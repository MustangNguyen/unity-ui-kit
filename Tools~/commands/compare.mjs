import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { ssim } from 'ssim.js';
import { cropRaw, loadRaw, palette, paletteDistance, shrinkRaw, toPng } from '../lib/image.mjs';
import { captureFiles, capturePath, loadProject, loadScreen } from '../lib/project.mjs';
import { compareInputs, compareSettings, hashFiles, readState, writeState } from '../lib/state.mjs';
import { composeRows } from '../lib/sheet.mjs';
import { fail, readJson, relative, writeIfChanged, writeJson } from '../lib/util.mjs';

/**
 * uikit compare <screen> [--size 1080x1920] [--ref img --cap img --layout json --out dir]
 * Reference vs Unity capture: SSIM, pixel diff, palette distance, and layout IoU per region.
 * With a screen and no --size/--cap, compares every capture size that exists.
 * Reports go to UIKit/reports/<screen>/<size>/. Exit code 2 when any check is below the thresholds.
 */
export default async function compare(args) {
  const project = loadProject(args.project);
  const screen = args._[1] ? loadScreen(project, args._[1]) : null;
  const refPath = path.resolve(args.ref ?? screen?.referencePath ?? fail('need <screen> or --ref'));
  if (!fs.existsSync(refPath)) fail(`not found: ${refPath}`);

  let captures;
  const partial = Boolean(args.cap || args.size || args.out || !screen);
  if (partial) {
    const png = path.resolve(args.cap ?? capturePath(project, screen, args.size));
    captures = [{ size: path.basename(png, '.png'), png, layout: path.resolve(args.layout ?? png.replace(/\.png$/, '.layout.json')) }];
  } else {
    const all = captureFiles(project, screen);
    captures = all.filter((c) => fs.existsSync(c.png));
    for (const c of all.filter((c) => !captures.includes(c))) console.warn(`missing capture ${c.size}: ${relative(c.png)}`);
  }
  if (!captures.length || !captures.every((c) => fs.existsSync(c.png)))
    fail(`no capture found (${captures.map((c) => relative(c.png)).join(', ')}). Capture in Unity first.`);

  const name = screen?.name ?? path.basename(refPath, path.extname(refPath));
  let pass = true;
  let decisive = 0;
  for (const capture of captures) {
    const base = args.out ? path.resolve(args.out) : path.join(project.dir, 'reports', name);
    const outDir = args.out && captures.length === 1 ? base : path.join(base, capture.size);
    if (captures.length > 1) console.log(`\n== ${capture.size}`);
    const report = await compareOne(project, screen, refPath, capture, outDir);
    if (!report.informational) decisive++;
    pass = report.pass && pass;
  }
  if (decisive === 0) {
    console.log('\nFAIL: no capture size has the aspect ratio of the reference, so nothing could be scored. Add one to captureSizes in UIKit/uikit.json.');
    pass = false;
  }
  // Only a full check (every size, default paths) counts as a fix round.
  // A missing aspect size is a config problem, not a fix round.
  if (screen && !partial && decisive > 0 && captures.length === captureFiles(project, screen).length) countIteration(project, screen, captures, pass);
  if (!pass) process.exitCode = 2;
}

/**
 * Counts failed checks per screen, once per distinct set of captures (so a rect correction alone
 * is not a round), for maxIterations. Only a pass or a user decision (approve / --revoke) resets it:
 * theme changes must not, or a color problem that never converges would never stop.
 */
function countIteration(project, screen, captures, pass) {
  const key = `iterations-${screen.name}`;
  const inputs = hashFiles(project, captures.flatMap((c) => [c.png, c.layout]), compareSettings(project));
  const state = readState(project, key) ?? { count: 0, lastInputs: null };
  if (pass) state.count = 0;
  else if (state.lastInputs !== inputs) state.count++;
  state.lastInputs = inputs;
  writeState(project, key, state);
  if (!pass) console.log(`failed checks for ${screen.name}: ${state.count} (fix rounds allowed: ${project.config.maxIterations})`);
}

async function compareOne(project, screen, refPath, capture, outDir) {
  const { png: capPath, layout: layoutPath } = capture;
  let layout = fs.existsSync(layoutPath) ? readJson(layoutPath) : null;
  const t = project.config.thresholds;

  const ref = await loadRaw(refPath);
  let capRaw = await loadRaw(capPath);

  // A prefab is captured with padding around it: cut the capture down to the prefab's own rect
  // (from the layout dump) and shift the layout to match, so the padding is not scored as error.
  if (screen?.prefab && layout) {
    const root = layout.nodes.find((n) => n.path.split('/').length === 2);
    if (root && root.width >= 1 && root.height >= 1) {
      const rect = [root.x, root.y, root.width, root.height].map(Math.round);
      capRaw = cropRaw(capRaw, rect);
      layout = {
        ...layout,
        width: capRaw.width,
        height: capRaw.height,
        nodes: layout.nodes.map((n) => ({ ...n, x: n.x - rect[0], y: n.y - rect[1] })),
      };
    }
  }

  const aspect = (m) => m.width / m.height;
  const aspectError = Math.abs(aspect(ref) - aspect(capRaw)) / aspect(ref);
  // A capture at another aspect ratio is stretched to the reference, so its numbers are only hints:
  // they do not decide pass/fail. Layout at that size is judged with the rubric (robustness).
  const informational = aspectError > 0.01;
  if (informational)
    console.log(`info only: aspect differs from the reference (${capRaw.width}x${capRaw.height} vs ${ref.width}x${ref.height})`);

  const cap = await loadRaw(await toPng(capRaw), { resize: { width: ref.width, height: ref.height } });

  const targets = [{ name: 'screen', rect: [0, 0, ref.width, ref.height] }, ...(screen?.regions ?? [])];
  const results = [];
  const rows = [];
  for (const region of targets) {
    const r = await measure(region, ref, cap, layout, t);
    results.push(r.result);
    rows.push(r.row);
  }

  const report = {
    inputs: screen ? hashFiles(project, compareInputs(screen, capture), compareSettings(project)) : null,
    reference: relative(refPath),
    capture: relative(capPath),
    layout: layout ? relative(layoutPath) : null,
    thresholds: t,
    informational,
    pass: informational || results.every((r) => r.pass),
    regions: results,
  };
  writeJson(path.join(outDir, 'report.json'), report);
  writeIfChanged(path.join(outDir, 'compare.png'), await composeRows(rows));

  printTable(results);
  console.log(`\n${informational ? 'INFO' : report.pass ? 'PASS' : 'FAIL'}  report: ${relative(path.join(outDir, 'report.json'))}  image: ${relative(path.join(outDir, 'compare.png'))}`);
  return report;
}

async function measure(region, ref, cap, layout, t) {
  const refCrop = cropRaw(ref, region.rect);
  const capCrop = cropRaw(cap, region.rect);

  const [a, b] = [await shrinkRaw(refCrop, 400), await shrinkRaw(capCrop, 400)];
  // ssim.js uses an 11px window; below that the score is meaningless, so skip it.
  const structural = Math.min(a.width, a.height) >= 11 ? ssim(asImageData(a), asImageData(b)).mssim : null;

  const diff = Buffer.alloc(refCrop.data.length);
  const mismatched = pixelmatch(refCrop.data, capCrop.data, diff, refCrop.width, refCrop.height, { threshold: 0.1 });
  const refPalette = palette(refCrop);
  const capPalette = palette(capCrop);
  const colorDistance = paletteDistance(refPalette, capPalette);

  const result = {
    name: region.name,
    rect: region.rect,
    ssim: structural == null ? null : round(structural, 3),
    pixelDiff: round(mismatched / (refCrop.width * refCrop.height), 3),
    paletteDeltaE: colorDistance,
    referencePalette: refPalette.slice(0, 5).map((c) => c.hex),
    capturePalette: capPalette.slice(0, 5).map((c) => c.hex),
  };
  if (region.node) Object.assign(result, layoutMatch(region, layout, ref));

  const failures = [];
  if (result.ssim != null && result.ssim < t.ssim) failures.push(`ssim<${t.ssim}`);
  if (result.paletteDeltaE != null && result.paletteDeltaE > t.paletteDeltaE) failures.push(`ΔE>${t.paletteDeltaE}`);
  if (result.iou != null && result.iou < t.iou) failures.push(`iou<${t.iou}`);
  if (result.layoutError) failures.push(result.layoutError);
  result.pass = failures.length === 0;
  result.failures = failures;

  const lines = [
    `SSIM ${result.ssim ?? '- (region too small)'}   pixel diff ${(result.pixelDiff * 100).toFixed(1)}%`,
    `palette ΔE ${result.paletteDeltaE ?? '-'}`,
  ];
  if (result.iou != null) lines.push(`layout IoU ${result.iou}  offset ${result.offset.join(', ')}  size x${result.sizeRatio.join(', x')}`);
  lines.push(result.pass ? 'PASS' : `FAIL: ${failures.join(', ')}`);
  lines.push('palette: reference, then capture');

  return {
    result,
    row: {
      title: region.name,
      images: [
        { buffer: await toPng(refCrop), caption: 'reference' },
        { buffer: await toPng(capCrop), caption: 'unity' },
        { buffer: await toPng({ data: diff, width: refCrop.width, height: refCrop.height }), caption: 'diff' },
      ],
      lines,
      swatches: [result.referencePalette, result.capturePalette],
    },
  };
}

/** Where the Unity node actually sits vs the region drawn on the reference, in reference pixels. */
function layoutMatch(region, layout, ref) {
  if (!layout) return { layoutError: 'no layout dump' };
  const node = layout.nodes.find((n) => n.path === region.node || n.path.endsWith(`/${region.node}`));
  if (!node) return { layoutError: `node "${region.node}" not found` };
  const sx = ref.width / layout.width;
  const sy = ref.height / layout.height;
  const actual = [node.x * sx, node.y * sy, node.width * sx, node.height * sy];
  const [x, y, w, h] = region.rect;
  return {
    node: node.path,
    actualRect: actual.map((v) => Math.round(v)),
    iou: round(iou(region.rect, actual), 3),
    offset: [Math.round(actual[0] + actual[2] / 2 - (x + w / 2)), Math.round(actual[1] + actual[3] / 2 - (y + h / 2))],
    sizeRatio: [round(actual[2] / w, 2), round(actual[3] / h, 2)],
  };
}

function iou([ax, ay, aw, ah], [bx, by, bw, bh]) {
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  const inter = ix * iy;
  return inter / (aw * ah + bw * bh - inter);
}

const asImageData = (raw) => ({
  data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length),
  width: raw.width,
  height: raw.height,
});

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

function printTable(results) {
  const pad = (v, n) => String(v ?? '-').padEnd(n);
  console.log(`${pad('region', 22)}${pad('ssim', 8)}${pad('diff%', 8)}${pad('ΔE', 7)}${pad('iou', 7)}status`);
  for (const r of results)
    console.log(`${pad(r.name, 22)}${pad(r.ssim, 8)}${pad((r.pixelDiff * 100).toFixed(1), 8)}${pad(r.paletteDeltaE, 7)}${pad(r.iou, 7)}${r.pass ? 'ok' : r.failures.join(' ')}`);
}
