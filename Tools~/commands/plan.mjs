import fs from 'node:fs';
import path from 'node:path';
import { captureFiles, listScreens, loadCheckpoints, loadProject, loadScreen, spriteNames } from '../lib/project.mjs';
import { compareInputs, compareSettings, genInputs, genSettings, hashFiles, readState } from '../lib/state.mjs';
import { sheetInputsHash } from './sheet.mjs';

/**
 * uikit plan [--json]
 * Task graph for the whole UI job, computed from the files on disk, so an orchestrating agent
 * knows what can run in parallel right now.
 *
 * Lanes:
 *   parallel  any number at once (each task reads shared files and writes only its own)
 *   unity     one at a time (there is one Unity Editor)
 *   lead      the orchestrating agent itself (shared files, gen, human approval)
 *
 * Status: done | ready | blocked | approval (ready, but the user must approve).
 * Freshness is decided by content hashes recorded by each step, never by file times.
 */
export default async function plan(args) {
  const project = loadProject(args.project);
  const { tasks, notes } = buildTasks(project);
  resolveStatus(tasks);
  if (args.json) console.log(JSON.stringify({ tasks, notes }, null, 2));
  else print(tasks, notes);
}

const exists = (file) => fs.existsSync(file);
const validRect = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > 0 && r[3] > 0;

function tryReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Loads the screens that can be planned; the rest go to notes. */
function loadScreens(project, notes) {
  const screens = [];
  for (const name of listScreens(project)) {
    let screen;
    try {
      screen = loadScreen(project, name);
    } catch (error) {
      notes.push(`screen ${name}: unreadable (${error.message})`);
      continue;
    }
    if (!screen.reference || !exists(screen.referencePath)) notes.push(`screen ${name}: skipped, reference image missing`);
    else screens.push(screen);
  }
  return screens;
}

/**
 * What each approval covers. An approval stays valid only while this hash is unchanged,
 * so the user re-approves whatever changed after they said yes.
 */
export function approvalHashes(project) {
  const notes = [];
  const screens = loadScreens(project, notes);
  const { assets = [] } = tryReadJson(path.join(project.dir, 'assets.json')) ?? {};
  const screenHash = {};
  for (const s of screens) {
    if (!s.scene && !s.prefab) continue;
    screenHash[s.name] = hashFiles(project, captureFiles(project, s).flatMap((c) => compareInputs(s, c)), compareSettings(project));
  }
  // Spec approval covers the structure the user saw at CHECKPOINT 1 (screens, targets, regions and
  // their sprites), not region rects: correcting a rect later must not reopen CHECKPOINT 1.
  const structure = screens.map((s) => ({
    name: s.name,
    reference: s.reference,
    target: s.prefab ?? s.scene ?? null,
    regions: s.regions.map((r) => [r.name, r.asset ?? null, r.node ?? null]),
  }));
  return {
    spec: hashFiles(project, [], JSON.stringify(structure)),
    assets: hashFiles(project, genInputs(project, assets), genSettings(project)),
    screens: screenHash,
  };
}

export function buildTasks(project) {
  const notes = [];
  const kit = (...p) => path.join(project.dir, ...p);
  const rel = (file) => path.relative(project.root, file);
  const checkpoints = loadCheckpoints(project);
  const current = approvalHashes(project);
  const approved = (entry, hash) => Boolean(entry) && typeof entry === 'object' && entry.hash === hash;
  const changedSince = (entry, hash) => Boolean(entry) && !approved(entry, hash);

  const assetsFile = tryReadJson(kit('assets.json'));
  if (!assetsFile) notes.push('UIKit/assets.json missing or unreadable');
  const assets = assetsFile?.assets ?? [];
  const generated = project.resolve(project.config.generatedDir);
  const screens = loadScreens(project, notes);

  const tasks = [];
  const add = (task) => (tasks.push({ deps: [], writes: [], ...task }), task.id);

  // Phase 1: spec. One agent per screen; each writes only its own screen file and returns token proposals.
  const specIds = screens.map((s) => add({
    id: `spec:${s.name}`,
    lane: 'parallel',
    writes: [rel(s.file)],
    done: s.regions.length > 0 && s.regions.every((r) => validRect(r.rect)) && Boolean(s.scene || s.prefab),
    brief: `Screen "${s.name}": run \`UIKit/uikit overlay ${s.name}\` and \`UIKit/uikit palette ${s.name}\`, read the images, ` +
      `fill ${rel(s.file)}: "scene" or "prefab", and "regions" (name, rect from the grid, node, asset id). ` +
      'Return proposed color tokens (measured hex), styles and assets. Do not edit theme.json or assets.json.',
  }));

  const themeId = add({
    id: 'theme',
    lane: 'lead',
    deps: specIds,
    writes: ['UIKit/theme.json', 'UIKit/assets.json'],
    approval: true,
    changed: changedSince(checkpoints.spec, current.spec),
    done: approved(checkpoints.spec, current.spec),
    brief: 'Merge the spec proposals into one theme.json and assets.json (one style per role, shared across screens). ' +
      'CHECKPOINT 1: show tokens, styles, assets and overlays; after the user approves run `UIKit/uikit approve spec`.',
  });

  // Phase 2: art. Every icon/svg source file is independent work (Codex can take the svg ones).
  const artIds = assets.filter((a) => a.type === 'icon' || a.type === 'svg').map((a) => {
    if (!a.src) return add({
      id: `art:${a.id}`,
      lane: 'lead',
      deps: [themeId],
      done: false,
      brief: `Asset "${a.id}" has no "src" in assets.json; set it (for example "icons/${a.id}.svg").`,
    });
    return add({
      id: `art:${a.id}`,
      lane: 'parallel',
      deps: [themeId],
      writes: [`UIKit/${a.src}`],
      done: exists(kit(a.src)),
      brief: a.type === 'icon'
        ? `Icon "${a.id}" -> UIKit/${a.src}: prefer \`UIKit/uikit icon add game-icons:<author>/<name> --as ${path.basename(a.src, '.svg')}\` ` +
          `or lucide:<name>${path.dirname(a.src) === 'icons' ? '' : ` (then move it to UIKit/${a.src})`}; draw only if no set has it.`
        : `Custom art "${a.id}" -> UIKit/${a.src}, ${a.size?.join('x')} px: hand-written SVG (Codex OK) following the skill's SVG rules, palette from theme.json only.`,
    });
  });

  const genStamp = readState(project, 'gen');
  const sprites = assets.flatMap(spriteNames).map((n) => path.join(generated, `${n}.png`));
  const genId = add({
    id: 'gen',
    lane: 'lead',
    deps: [themeId, ...artIds],
    writes: [rel(generated), 'UIKit/svg/'],
    done: sprites.length > 0 && sprites.every(exists) && genStamp?.inputs === current.assets,
    brief: 'Run `UIKit/uikit gen` (full run, no --only) and look at UIKit/reports/assets.png.',
  });

  // Phase 3: per-screen asset review, read-only, so all screens at once.
  const reviewIds = screens.filter((s) => s.regions.some((r) => r.asset)).map((s) => add({
    id: `review:${s.name}`,
    lane: 'parallel',
    deps: [genId],
    writes: [`UIKit/reports/${s.name}/sheet.*`],
    done: tryReadJson(kit('reports', s.name, 'sheet.json'))?.inputs === sheetInputsHash(project, s),
    brief: `Run \`UIKit/uikit sheet ${s.name}\`, then judge UIKit/reports/${s.name}/sheet.png with the skill's rubric.md. ` +
      'Return fixes as theme.json style changes; do not edit theme.json yourself.',
  }));

  const assetsId = add({
    id: 'assets',
    lane: 'lead',
    deps: [genId, ...reviewIds],
    approval: true,
    changed: changedSince(checkpoints.assets, current.assets),
    done: approved(checkpoints.assets, current.assets),
    brief: 'Apply the review fixes to theme.json, rerun gen until the reviews pass (max iterations). ' +
      'CHECKPOINT 2: show assets.png and the sheets; after approval run `UIKit/uikit approve assets`.',
  });

  // Phase 4: build is serial (one Editor); compare/judge of a built screen overlaps the next build.
  const genAt = Date.parse(genStamp?.at ?? '') || 0;
  const sceneOwners = new Map();
  for (const s of screens) {
    if (!s.scene && !s.prefab) continue; // spec task is not done yet; it asks for scene/prefab
    const target = s.prefab ?? s.scene;
    if (sceneOwners.has(target)) notes.push(`screens ${sceneOwners.get(target)} and ${s.name} share ${target}: build them one after the other and compare both after each capture`);
    sceneOwners.set(target, s.name);

    const captures = captureFiles(project, s);
    // A capture older than the current sprites shows old art, so it does not count.
    const built = captures.every((c) => exists(c.png) && exists(c.layout) && fs.statSync(c.png).mtimeMs >= genAt);
    const buildId = add({
      id: `build:${s.name}`,
      lane: 'unity',
      deps: [assetsId],
      writes: [target],
      done: built,
      brief: `Build "${s.name}" in ${target} with Unity MCP (Sliced sprites, ThemedGraphic, anchors), check the console, ` +
        `then capture (${s.prefab ? 'UICapture.CapturePrefab' : 'Tools/UI Kit/Capture Open Scene'}).`,
    });

    const reports = captures.map((c) => ({ capture: c, report: tryReadJson(kit('reports', s.name, c.size, 'report.json')) }));
    const compared = built && reports.every(({ capture, report }) => report?.inputs === hashFiles(project, compareInputs(s, capture), compareSettings(project)));
    const compareId = add({
      id: `compare:${s.name}`,
      lane: 'parallel',
      deps: [buildId],
      writes: [`UIKit/reports/${s.name}/`],
      done: compared,
      brief: `Run \`UIKit/uikit compare ${s.name}\` (all sizes), then judge every compare.png with rubric.md, including robustness at each size. ` +
        'Return the fixes; do not touch Unity.',
    });

    const decisive = compared ? reports.filter(({ report }) => !report.informational) : [];
    const failures = compared
      ? decisive.flatMap(({ capture, report }) => report.regions.filter((r) => !r.pass).map((r) => `${capture.size} ${r.name}: ${r.failures.join(', ')}`))
      : [];
    const noDecisiveSize = compared && decisive.length === 0;
    if (noDecisiveSize) {
      add({
        id: `config:${s.name}`,
        lane: 'lead',
        deps: [compareId],
        writes: ['UIKit/uikit.json'],
        done: false,
        brief: `No capture size of "${s.name}" has the reference's aspect ratio, so nothing can be scored. ` +
          'Add a size with that aspect to captureSizes in UIKit/uikit.json, then recapture.',
      });
    }
    const failing = failures.length > 0 && !noDecisiveSize;
    // count = failed compares of distinct captures; the first failure leads to fix round 1.
    const rounds = readState(project, `iterations-${s.name}`)?.count ?? 0;
    const screenApproved = approved(checkpoints.screens[s.name], current.screens[s.name]);
    const exhausted = rounds > project.config.maxIterations;

    let fixId = null;
    if (failing && !screenApproved && !exhausted) {
      fixId = add({
        id: `fix:${s.name}`,
        lane: 'unity',
        deps: [compareId],
        writes: [target],
        done: false,
        brief: `Fix "${s.name}" (round ${rounds}/${project.config.maxIterations}): ${failures.slice(0, 6).join('; ')}. ` +
          'Layout/IoU -> anchors and sizes in Unity; color -> ask the lead for a theme change. Then recapture.',
      });
    }
    add({
      id: `approve:${s.name}`,
      lane: 'lead',
      deps: [compareId],
      blockedBy: fixId ?? (noDecisiveSize ? `config:${s.name}` : null),
      approval: true,
      changed: changedSince(checkpoints.screens[s.name], current.screens[s.name]),
      done: screenApproved,
      brief: failing && exhausted
        ? `CHECKPOINT 3 for "${s.name}": still failing after ${rounds - 1} fix rounds (${failures.slice(0, 4).join('; ')}). ` +
          `Show the compare images and ask the user to accept as is or give direction; accept = \`UIKit/uikit approve ${s.name}\`.`
        : `CHECKPOINT 3 for "${s.name}": show compare images at all sizes, the table and judge scores; after approval run \`UIKit/uikit approve ${s.name}\`.`,
    });
  }

  return { tasks, notes };
}

/**
 * Tasks are built in dependency order. A task only counts as done when its deps are done too:
 * old outputs on disk (for example PNGs from an earlier run) must not skip an unapproved phase.
 */
export function resolveStatus(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const task of tasks) {
    const waiting = [...task.deps, ...(task.blockedBy ? [task.blockedBy] : [])].filter((d) => !byId.get(d)?.done);
    task.done = task.done && waiting.length === 0;
    if (task.done) task.status = 'done';
    else if (waiting.length) {
      task.status = 'blocked';
      task.waitingFor = waiting;
    } else task.status = task.approval ? 'approval' : 'ready';
  }
}

function print(tasks, notes) {
  const count = (s) => tasks.filter((t) => t.status === s).length;
  console.log(`tasks: ${tasks.length}  done ${count('done')}  ready ${count('ready')}  approval ${count('approval')}  blocked ${count('blocked')}`);
  for (const note of notes) console.log(`note: ${note}`);

  const ready = tasks.filter((t) => t.status === 'ready' || t.status === 'approval');
  if (!ready.length) {
    console.log(count('done') === tasks.length && tasks.length ? '\nAll done.' : '\nNothing ready.');
    return;
  }
  const groups = [
    ['parallel', 'Start all of these now, one agent each (they write separate files):'],
    ['unity', 'Unity lane, one at a time (single Editor). Start the first now:'],
    ['lead', 'Lead (you):'],
  ];
  for (const [lane, title] of groups) {
    const list = ready.filter((t) => t.lane === lane);
    if (!list.length) continue;
    console.log(`\n${title}`);
    for (const t of list) {
      const tag = t.status === 'approval' ? (t.changed ? ' (needs user approval: changed since last approval)' : ' (needs user approval)') : '';
      console.log(`  [${t.id}]${tag}\n    ${t.brief}`);
    }
  }
  const blocked = tasks.filter((t) => t.status === 'blocked');
  if (blocked.length) console.log(`\nBlocked next: ${blocked.slice(0, 6).map((t) => t.id).join(', ')}${blocked.length > 6 ? ', ...' : ''}`);
  console.log('\nRe-run `UIKit/uikit plan` after each task finishes. Full graph: `UIKit/uikit plan --json`.');
}
