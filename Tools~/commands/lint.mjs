import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { lintModel } from '../lib/lint.mjs';
import { buildModel, listSurfaces, loadInventory, reskinPath } from '../lib/model.mjs';
import { loadProject } from '../lib/project.mjs';
import { label } from '../lib/sheet.mjs';
import { fail, readJson, relative, writeIfChanged, writeJson } from '../lib/util.mjs';
import { renderModel } from '../lib/render.mjs';

const COLORS = { error: '#ff2d55', warn: '#ff9500', info: '#00c7be' };

/**
 * uikit lint [<surface>] [--before] [--fix] [--capture]
 * Display-quality checks (squashed 9-slice, blur, stretch, uneven outlines, tile size) on the inventory
 * plus the reskin map, so they are caught before Apply Reskin. Writes UIKit/reports/lint/<surface>.json
 * and lint.png (the preview with boxes). Exit code 2 when there are errors.
 * --fix merges the fixes that are plain property changes (ppuMultiplier, preserveAspect) into
 * UIKit/reskin/<surface>.json; the rest (new art, code changes) stays in the report.
 * --capture lints what Unity actually shows: the inventory written by the last Capture Surfaces.
 */
export default async function lint(args) {
  const project = loadProject(args.project);
  const surfaces = args._[1] ? [args._[1]] : listSurfaces(project);
  if (!surfaces.length) fail('no surfaces (UIKit/surfaces.json)');
  const deviceScale = project.config.deviceScale ?? 1.5;
  // Fixes belong to the map's own sprites: computed from the original art (--before) or from a capture that
  // already contains the map (--capture), they would be wrong or applied twice.
  if (args.fix && (args.before || args.capture)) fail('--fix works on the inventory + reskin map only (no --before / --capture)');
  let errors = 0;

  for (const surface of surfaces) {
    const before = Boolean(args.before) || Boolean(args.capture);
    let inventory = loadInventory(project, surface);
    if (args.capture) {
      const [w, h] = inventory.referenceResolution;
      const captured = path.join(project.dir, 'captures', 'surfaces', surface, `${w}x${h}.inventory.json`);
      if (!fs.existsSync(captured)) fail(`${surface}: no capture inventory at ${relative(captured)} (Tools/UI Kit/Capture Surfaces)`);
      inventory = readJson(captured);
    }
    const mapFile = reskinPath(project, surface);
    const reskin = !before && fs.existsSync(mapFile) ? readJson(mapFile) : null;
    const model = buildModel(project, inventory, { reskin });
    let issues = lintModel(model, { deviceScale });
    if (args.fix) {
      const merged = mergeFixes(mapFile, surface, reskin ?? (fs.existsSync(mapFile) ? readJson(mapFile) : null), issues);
      if (merged) {
        console.log(`${surface}: ${merged} fix(es) written to ${relative(mapFile)}`);
        issues = lintModel(buildModel(project, inventory, { reskin: readJson(mapFile) }), { deviceScale });
      }
    }
    const count = (s) => issues.filter((i) => i.severity === s).length;
    errors += count('error');

    const outDir = path.join(project.dir, 'reports', 'lint', args.capture ? `${surface}.capture` : before ? `${surface}.before` : surface);
    writeJson(path.join(outDir, 'report.json'), { surface, mode: before ? 'before' : 'after', deviceScale, issues });

    // Rendered here, into the lint folder: the preview files belong to `uikit preview`.
    const lintModelNow = args.fix ? buildModel(project, inventory, { reskin: fs.existsSync(mapFile) ? readJson(mapFile) : null }) : model;
    const { png: base } = await renderModel(lintModelNow);
    const boxes = issues.filter((i) => i.severity !== 'info').map((i, n) => {
      const [x, y, w, h] = i.rect.map(Math.round);
      const c = COLORS[i.severity];
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${c}" stroke-width="4"/>` +
        `<rect x="${x}" y="${Math.max(0, y - 26)}" width="${String(n + 1).length * 12 + 12}" height="26" fill="${c}"/>` +
        label(x + 6, Math.max(0, y - 26) + 19, n + 1, { anchor: 'start', size: 18, color: '#fff', weight: 'bold' });
    });
    const png = await sharp(base)
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}">${boxes.join('')}</svg>`) }])
      .png()
      .toBuffer();
    writeIfChanged(path.join(outDir, 'lint.png'), png);

    console.log(`${count('error') ? 'FAIL' : 'ok  '} ${surface}: ${count('error')} errors, ${count('warn')} warnings -> ${relative(outDir)}`);
    let n = 0;
    for (const issue of issues.filter((i) => i.severity !== 'info')) {
      n++;
      if (n > 15) continue;
      console.log(`  ${n}. [${issue.severity}] ${issue.kind} ${issue.path}: ${issue.message}`);
      if (issue.fix) console.log(`     fix: ${JSON.stringify(issue.fix)}`);
    }
    if (n > 15) console.log(`  ... ${n - 15} more in report.json`);
    for (const issue of issues.filter((i) => i.severity === 'info')) console.log(`  info ${issue.path}: ${issue.message}`);
  }
  if (errors) process.exitCode = 2;
}

/** Writes ppuMultiplier / preserveAspect fixes into the surface's reskin map. Returns how many nodes changed. */
function mergeFixes(mapFile, surface, map, issues) {
  map = map ?? { surface, nodes: [], add: [] };
  map.nodes = map.nodes ?? [];
  let changed = 0;
  for (const issue of issues) {
    if (issue.decoration) continue; // decorations are not map nodes; fix their sprite or rect in "add"
    const fix = issue.fix ?? {};
    const patch = {};
    if (fix.ppuMultiplier) patch.ppuMultiplier = fix.ppuMultiplier;
    if (fix.preserveAspect) patch.preserveAspect = fix.preserveAspect;
    if (!Object.keys(patch).length) continue;
    let entry = map.nodes.find((n) => (n.path ?? '') === issue.path);
    if (!entry) map.nodes.push((entry = { path: issue.path }));
    // Several issues on one node (border + stroke): keep the larger multiplier so the border still fits.
    if (patch.ppuMultiplier) patch.ppuMultiplier = Math.max(patch.ppuMultiplier, entry.ppuMultiplier ?? 0);
    if (Object.entries(patch).every(([k, v]) => entry[k] === v)) continue;
    Object.assign(entry, patch);
    changed++;
  }
  if (changed) writeJson(mapFile, map);
  return changed;
}
