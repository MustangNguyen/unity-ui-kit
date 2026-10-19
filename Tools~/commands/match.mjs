import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ssim } from 'ssim.js';
import { compareProfiles, profileChart, profiles, undim } from '../lib/features.mjs';
import { cropRaw, loadRaw, toPng } from '../lib/image.mjs';
import { loadProject, loadScreen } from '../lib/project.mjs';
import { composeRows } from '../lib/sheet.mjs';
import { fail, readJson, relative, writeIfChanged, writeJson } from '../lib/util.mjs';
import { renderSurface } from './preview.mjs';

/**
 * uikit match [<name>] [--preview]
 * Objective comparison of game components with the reference, pair by pair (UIKit/matches.json):
 *   { "matches": [ { "name": "play_button", "reference": "demo-home#level_button", "surface": "Home", "node": "Safe area /play btn" } ] }
 * The reference side is a region of a screen file (draw it tight with `uikit overlay`; "dim": 0.4 on the region
 * undoes a popup overlay). The game side is the node's rect in the last Unity capture (--preview: in the
 * preview of the reskin map). Both are cropped to their rect, scaled to the same size and measured the same way:
 * aspect, dominant color, vertical and horizontal lightness profiles, edge detail, structure (SSIM).
 * Writes UIKit/reports/match/report.json and match.png. Exit code 2 when any measure is out of tolerance.
 */
export default async function match(args) {
  const project = loadProject(args.project);
  const file = path.join(project.dir, 'matches.json');
  if (!fs.existsSync(file)) fail('no UIKit/matches.json ({ "matches": [ { name, reference: "<screen>#<region>", surface, node } ] })');
  let pairs = readJson(file).matches ?? [];
  if (args._[1]) pairs = pairs.filter((p) => p.name === args._[1]);
  if (!pairs.length) fail('no matching pairs');

  const results = [];
  const rows = [];
  for (const pair of pairs) {
    const [screenName, regionName] = pair.reference.split('#');
    const screen = loadScreen(project, screenName);
    const region = screen.regions.find((r) => r.name === regionName) ?? fail(`${pair.name}: no region "${regionName}" in ${screenName}`);
    const ref = undim(cropRaw(await loadRaw(screen.referencePath), region.rect), region.dim);
    const { image, rect } = await gameSide(project, pair, Boolean(args.preview));
    const game = cropRaw(image, rect);

    // Same size on both sides: the reference's aspect, 64 px tall, so profiles line up sample by sample.
    const height = 64;
    const width = Math.max(8, Math.round((height * ref.width) / ref.height));
    const [rs, gs] = [await resize(ref, width, height), await resize(game, width, height)];
    const [pr, pg] = [profiles(rs), profiles(gs)];
    const measures = compareProfiles(pr, pg, [ref.width / ref.height, game.width / game.height]);
    const structural = ssim(imageData(rs), imageData(gs)).mssim;
    const failed = measures.filter((m) => !m.pass).map((m) => m.feature);
    const result = { name: pair.name, reference: pair.reference, surface: pair.surface, node: pair.node, ssim: round(structural, 3), measures, failed, pass: failed.length === 0 };
    results.push(result);

    const cw = 360;
    const charts = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="220">` +
      `<g>${profileChart(pr.vertical, pg.vertical, cw, 105, 'vertical (top to bottom): grey reference, orange game')}</g>` +
      `<g transform="translate(0,112)">${profileChart(pr.horizontal, pg.horizontal, cw, 105, 'horizontal (left to right)')}</g></svg>`);
    rows.push({
      title: `${pair.name}  ${result.pass ? 'MATCH' : `differs: ${failed.join(', ')}`}`,
      images: [
        { buffer: await toPng(ref), caption: `reference ${pair.reference}` },
        { buffer: await toPng(game), caption: `game ${pair.surface}: ${pair.node.split('/').pop()}` },
        { buffer: await sharp(charts).png().toBuffer(), caption: '' },
      ],
      lines: [
        `structure SSIM ${round(structural, 3)}`,
        ...measures.map((m) => `${m.pass ? '✓' : '✗'} ${m.feature}: ref ${m.reference} | game ${m.game}`),
        ...measures.map((m) => `   ${m.feature} diff ${m.diff} (max ${m.tolerance} ${m.unit})`),
      ],
    });
  }

  const outDir = path.join(project.dir, 'reports', 'match');
  writeJson(path.join(outDir, 'report.json'), { source: args.preview ? 'preview' : 'capture', results });
  writeIfChanged(path.join(outDir, 'match.png'), await composeRows(rows, { height: 240, imageWidth: 360, infoWidth: 640 }));
  for (const r of results) {
    const off = r.measures.filter((m) => !m.pass).map((m) => `${m.feature} ${m.game} vs ${m.reference}`);
    console.log(`${r.pass ? 'MATCH ' : 'DIFFER'} ${r.name.padEnd(18)} ssim ${r.ssim}  ${off.join('; ')}`);
  }
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} match -> ${relative(path.join(outDir, 'match.png'))}`);
  if (results.some((r) => !r.pass)) process.exitCode = 2;
}

/** The node's rect and pixels: from the last capture of its surface, or from the reskin preview. */
async function gameSide(project, pair, preview) {
  const inventory = readJson(path.join(project.dir, 'inventory', `${pair.surface}.json`));
  const [w, h] = inventory.referenceResolution;
  if (preview) {
    const out = await renderSurface(project, pair.surface);
    const op = out.model.ops.find((o) => o.path === pair.node);
    const node = inventory.nodes.find((n) => n.path === pair.node);
    if (!op && !node) fail(`${pair.name}: node "${pair.node}" not in ${pair.surface}`);
    return { image: await loadRaw(out.file), rect: op ? op.rect : [node.x, node.y, node.width, node.height] };
  }
  const dir = path.join(project.dir, 'captures', 'surfaces', pair.surface);
  const capturedFile = path.join(dir, `${w}x${h}.inventory.json`);
  if (!fs.existsSync(capturedFile)) fail(`${pair.name}: no capture of ${pair.surface} (Tools/UI Kit/Capture Surfaces)`);
  const node = readJson(capturedFile).nodes.find((n) => n.path === pair.node) ?? fail(`${pair.name}: node "${pair.node}" not in the ${pair.surface} capture`);
  return { image: await loadRaw(path.join(dir, `${w}x${h}.png`)), rect: [node.x, node.y, node.width, node.height] };
}

async function resize(raw, width, height) {
  const { data, info } = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } })
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const imageData = (raw) => ({ data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length), width: raw.width, height: raw.height });
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
