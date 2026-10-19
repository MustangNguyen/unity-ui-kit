import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { ssim } from 'ssim.js';
import { loadRaw, shrinkRaw, toPng } from '../lib/image.mjs';
import { listSurfaces, loadInventory, reskinPath } from '../lib/model.mjs';
import { loadProject } from '../lib/project.mjs';
import { composeRows } from '../lib/sheet.mjs';
import { fail, readJson, relative, writeIfChanged, writeJson } from '../lib/util.mjs';
import { renderSurface } from './preview.mjs';

/**
 * uikit verify [<surface>] [--before]
 * Checks the Unity capture of a surface against what the inventory + reskin map say it should be:
 *   structure  every node still exists, no unexpected nodes (only UIKit_ decorations may be new)
 *   sprites    each node shows the sprite the map asks for
 *   rects      nodes the map resized/moved and untouched nodes keep their expected rects (±2 px)
 *   pixels     SSIM and pixel diff against the preview, with text areas masked out
 * Needs a fresh capture: Tools/UI Kit/Capture Surfaces. Exit code 2 on any failure.
 */
export default async function verify(args) {
  const project = loadProject(args.project);
  const surfaces = args._[1] ? [args._[1]] : listSurfaces(project);
  let ok = true;
  for (const surface of surfaces) ok = (await verifyOne(project, surface, Boolean(args.before))) && ok;
  if (!ok) process.exitCode = 2;
}

const TOLERANCE = 2;

async function verifyOne(project, surface, before) {
  const inventory = loadInventory(project, surface);
  const [w, h] = inventory.referenceResolution;
  const dir = path.join(project.dir, 'captures', 'surfaces', surface);
  const capturePng = path.join(dir, `${w}x${h}.png`);
  const captureInv = path.join(dir, `${w}x${h}.inventory.json`);
  if (!fs.existsSync(capturePng) || !fs.existsSync(captureInv)) fail(`${surface}: no capture at ${relative(dir)} (Tools/UI Kit/Capture Surfaces)`);
  const actual = readJson(captureInv);
  const mapFile = reskinPath(project, surface);
  const reskin = !before && fs.existsSync(mapFile) ? readJson(mapFile) : null;
  const changes = new Map((reskin?.nodes ?? []).map((c) => [c.path ?? '', c]));

  const problems = [];
  const expected = new Map(inventory.nodes.map((n) => [n.path, n]));
  const got = new Map(actual.nodes.map((n) => [n.path, n]));
  const decorations = new Set((reskin?.add ?? []).map((d) => `${d.parent ? `${d.parent}/` : ''}UIKit_${d.name}`));

  for (const p of expected.keys()) if (!got.has(p)) problems.push(`structure: "${p}" is missing`);
  for (const p of got.keys())
    if (!expected.has(p) && !decorations.has(p) && ![...decorations].some((d) => p.startsWith(`${d}/`)))
      problems.push(`structure: unexpected node "${p}"`);
  for (const d of decorations) if (!got.has(d)) problems.push(`structure: decoration "${d}" was not added`);

  // Expected rects come from the preview model, which applies the map's sizes and positions.
  const preview = await renderSurface(project, surface, { before });
  const modelRects = new Map(preview.model.ops.map((op) => [op.path, op]));

  for (const [p, node] of expected) {
    const now = got.get(p);
    if (!now) continue;
    const change = changes.get(p);
    if (change?.sprite) {
      const want = change.sprite.includes('/') ? null : change.sprite;
      if (want && now.sprite !== want) problems.push(`sprite: "${p}" shows "${now.sprite || 'none'}", map says "${want}"`);
    } else if (node.sprite !== now.sprite) problems.push(`sprite: "${p}" changed from "${node.sprite}" to "${now.sprite}" without a map entry`);
    const wantActive = preview.model.expectedActive.get(p);
    if (wantActive !== undefined && now.active !== wantActive)
      problems.push(`active: "${p}" is ${now.active ? 'shown' : 'hidden'}, expected ${wantActive ? 'shown' : 'hidden'}${change?.active ? ` (map: active ${change.active})` : ''}`);

    const op = modelRects.get(p);
    if (!op || op.approximate || !now.active) continue;
    const [ex, ey, ew, eh] = op.rect;
    const diff = [now.x - ex, now.y - ey, now.width - ew, now.height - eh].map((v) => Math.round(v));
    if (diff.some((v) => Math.abs(v) > TOLERANCE)) problems.push(`rect: "${p}" off by x${diff[0]} y${diff[1]} w${diff[2]} h${diff[3]}`);
  }

  // Decorations are new nodes: check them against the rect the map gives them.
  for (const op of preview.model.ops.filter((o) => o.decoration && !o.approximate)) {
    const now = got.get(op.path);
    if (!now) continue;
    const diff = [now.x - op.rect[0], now.y - op.rect[1], now.width - op.rect[2], now.height - op.rect[3]].map((v) => Math.round(v));
    if (diff.some((v) => Math.abs(v) > TOLERANCE)) problems.push(`rect: decoration "${op.path}" off by x${diff[0]} y${diff[1]} w${diff[2]} h${diff[3]}`);
  }

  // Pixels: capture vs preview, text areas painted out on both sides.
  const ref = await loadRaw(preview.file);
  const cap = await loadRaw(capturePng, { resize: { width: ref.width, height: ref.height } });
  for (const raw of [ref, cap]) maskOut(raw, preview.masks);
  const [a, b] = [await shrinkRaw(ref, 400), await shrinkRaw(cap, 400)];
  const structural = ssim(asImageData(a), asImageData(b)).mssim;
  const diffBuf = Buffer.alloc(ref.data.length);
  const mismatched = pixelmatch(ref.data, cap.data, diffBuf, ref.width, ref.height, { threshold: 0.1 });
  const t = project.config.thresholds;
  const pixelDiff = mismatched / (ref.width * ref.height);
  if (structural < t.ssim) problems.push(`pixels: SSIM ${structural.toFixed(3)} < ${t.ssim}`);

  const effects = preview.model.ops.filter((o) => o.effect).map((o) => `${o.path} (${o.effect})`);
  const outDir = path.join(project.dir, 'reports', 'verify', before ? `${surface}.before` : surface);
  writeJson(path.join(outDir, 'report.json'), {
    surface,
    mode: before ? 'before (inventory only)' : 'after (inventory + reskin map)',
    pass: problems.length === 0,
    ssim: Math.round(structural * 1000) / 1000,
    pixelDiff: Math.round(pixelDiff * 1000) / 1000,
    problems,
    notCompared: effects.length ? { reason: 'drawn by a custom material; set their final state in the fixture', nodes: effects } : undefined,
  });
  writeIfChanged(path.join(outDir, 'verify.png'), await composeRows([{
    title: `${surface}${before ? ' (before)' : ''}`,
    images: [
      { buffer: await toPng(ref), caption: 'expected (preview)' },
      { buffer: await toPng(cap), caption: 'unity capture' },
      { buffer: await toPng({ data: diffBuf, width: ref.width, height: ref.height }), caption: 'diff' },
    ],
    lines: [`SSIM ${structural.toFixed(3)}  pixel diff ${(pixelDiff * 100).toFixed(1)}%`, `${problems.length} problems`, 'text areas masked'],
  }], { height: 640, imageWidth: 320 }));

  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${surface}: SSIM ${structural.toFixed(3)}, diff ${(pixelDiff * 100).toFixed(1)}%, ${problems.length} problems -> ${relative(outDir)}`);
  for (const p of problems.slice(0, 12)) console.log(`  ${p}`);
  if (effects.length) console.log(`  note: ${effects.length} node(s) drawn by a custom material are not compared: ${effects.slice(0, 3).join(', ')}${effects.length > 3 ? ', ...' : ''}`);
  if (problems.length > 12) console.log(`  ... ${problems.length - 12} more in report.json`);
  return problems.length === 0;
}

function maskOut(raw, masks) {
  for (const [x, y, w, h] of masks) {
    for (let yy = Math.max(0, y); yy < Math.min(raw.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(raw.width, x + w); xx++) {
        const o = (yy * raw.width + xx) * 4;
        raw.data[o] = raw.data[o + 1] = raw.data[o + 2] = 128;
        raw.data[o + 3] = 255;
      }
    }
  }
}

const asImageData = (raw) => ({ data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length), width: raw.width, height: raw.height });
