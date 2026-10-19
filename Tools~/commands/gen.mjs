import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { withLock } from '../lib/lock.mjs';
import { DEFAULT_STATES, loadProject, spriteNames } from '../lib/project.mjs';
import { genInputs, genSettings, hashFiles, readState, writeState } from '../lib/state.mjs';
import { composeGrid } from '../lib/sheet.mjs';
import { buildBox, buildIcon, buildRaw } from '../lib/svg.mjs';
import { createTokens } from '../lib/theme.mjs';
import { fail, readJson, relative, writeIfChanged, writeJson } from '../lib/util.mjs';

/**
 * uikit gen [--only id,id]
 * assets.json + theme.json -> UIKit/svg/*.svg, <generatedDir>/*.png, _uikit_import.json, ui-theme.json
 * and a preview grid at UIKit/reports/assets.png.
 */
export default async function gen(args) {
  if (args.only === true) fail('--only needs ids, e.g. --only btn_primary,panel_main');
  const project = loadProject(args.project);
  // Parallel agents may each run `gen --only <their asset>`; the shared manifest needs one writer at a time.
  await withLock(project, 'gen', () => generate(project, args));
}

async function generate(project, args) {
  // Read inputs inside the lock: another run may have changed them while this one waited.
  project.theme = readJson(project.themePath);
  const tokens = createTokens(project.theme);
  const { assets } = readJson(path.join(project.dir, 'assets.json'));
  const inputs = hashFiles(project, genInputs(project, assets), genSettings(project));
  const names = assets.flatMap(spriteNames);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length) fail(`assets.json produces the same sprite name twice: ${dupes.join(', ')} (check ids and "heights")`);
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  for (const id of only ?? []) if (!assets.some((a) => a.id === id)) console.warn(`  --only: no asset "${id}"`);
  const scale = project.config.scale;
  const outDir = project.resolve(project.config.generatedDir);
  const svgDir = path.join(project.dir, 'svg');

  const importPath = path.join(outDir, '_uikit_import.json');
  const known = fs.existsSync(importPath) ? readJson(importPath).sprites : [];
  const sprites = new Map(known.map((s) => [s.file, s]));
  const preview = [];
  let changed = 0;
  let failed = 0;

  for (const asset of assets) {
    if (only && !only.has(asset.id)) continue;
    let built;
    try {
      built = [...variants(asset, tokens, project)];
    } catch (error) {
      console.error(`  ${asset.id}: ${error.message}`);
      failed++;
      continue;
    }
    for (const variant of built) {
      const file = `${variant.name}.png`;
      writeIfChanged(path.join(svgDir, `${variant.name}.svg`), variant.svg);
      let png;
      try {
        png = await sharp(Buffer.from(variant.svg), { density: 72 * scale }).png().toBuffer();
      } catch (error) {
        console.error(`  ${variant.name}: render failed: ${error.message} (see UIKit/svg/${variant.name}.svg)`);
        failed++;
        continue;
      }
      if (writeIfChanged(path.join(outDir, file), png)) changed++;
      sprites.set(file, { file, border: variant.border.map((v) => Math.ceil(v * scale)), pixelsPerUnit: 100 * scale });
      preview.push({ label: variant.name, buffer: png });
    }
  }

  writeJson(importPath, { sprites: [...sprites.values()].sort((a, b) => a.file.localeCompare(b.file)) });
  writeIfChanged(path.join(outDir, 'ui-theme.json'), fs.readFileSync(project.themePath));
  // A partial run (--only) shows only its own sprites, so it must not replace the full preview or the stamp.
  // `at` = when the sprite files last changed. Captures older than that show old art. It follows a
  // hash of the files, so a run that changed nothing keeps it (builds stay valid) and a change made
  // earlier by `gen --only` still counts.
  if (!only && !failed) {
    const previous = readState(project, 'gen');
    const files = assets.flatMap(spriteNames).map((n) => path.join(outDir, `${n}.png`));
    const sprites = hashFiles(project, [...files, importPath]);
    const at = previous?.sprites === sprites && previous?.at ? previous.at : new Date().toISOString();
    writeState(project, 'gen', { inputs, sprites, at });
  }
  if (preview.length && !only) {
    const sheet = path.join(project.dir, 'reports', 'assets.png');
    writeIfChanged(sheet, await composeGrid(preview));
    console.log(`preview: ${relative(sheet)}`);
  }
  console.log(`${preview.length} sprites (${changed} changed) -> ${relative(outDir)}`);
  if (failed) process.exitCode = 1;
}

/**
 * A box sprite whose 9-slice border fits inside it on both axes. With "heights", the width grows when the
 * corners (a "full" radius is half the height) need more room than "size" gives; a stretchable middle stays.
 */
function boxThatFits(tokens, asset, width, height, state, id) {
  const style = tokens.style(asset.style);
  let w = asset.heights?.length ? Math.max(width, height + 16) : width;
  let box = buildBox({ tokens, style, width: w, height, state, id });
  for (let i = 0; i < 3 && box.wanted[0] + box.wanted[2] + 4 > box.width; i++) {
    w = Math.ceil(w + box.wanted[0] + box.wanted[2] + 4 - box.width);
    box = buildBox({ tokens, style, width: w, height, state, id });
  }
  // A sprite made for one height needs no vertical slicing; a shared one stretches its round ends when taller.
  if (!asset.heights?.length && box.wanted[1] + box.wanted[3] >= box.height)
    console.warn(`  ${id}: corners fill the whole height, so it cannot stretch vertically; add "heights" for each element height it is used at`);
  return box;
}

function* variants(asset, tokens, project) {
  const { id, size } = asset;
  if (!Array.isArray(size) || size.length !== 2) throw new Error('"size" must be [width, height]');
  const [width, height] = size;
  const source = () => fs.readFileSync(path.join(project.dir, asset.src), 'utf8');

  // "heights": one sprite per element height, so outlines and corners keep the same design-px size at every
  // height and the 9-slice border always fits (no ppuMultiplier, no squashed corners).
  const heights = asset.heights?.length ? asset.heights.map((h) => ({ h, suffix: `_h${h}` })) : [{ h: height, suffix: '' }];

  switch (asset.type) {
    case 'panel':
    case 'button':
      for (const { h, suffix } of heights) {
        const states = asset.type === 'button' ? asset.states ?? DEFAULT_STATES : [null];
        for (const state of states) {
          const name = `${id}${suffix}${state ? `_${state}` : ''}`;
          yield { name, ...boxThatFits(tokens, asset, width, h, state ?? 'normal', name) };
        }
      }
      break;
    case 'icon':
      yield { name: id, ...buildIcon({ tokens, style: tokens.style(asset.style), width, height, source: source(), id }) };
      break;
    case 'svg':
      yield { name: id, ...buildRaw({ width, height, source: source() }), ...(asset.border && { border: asset.border }) };
      break;
    default:
      throw new Error(`unknown type "${asset.type}" (panel, button, icon, svg)`);
  }
}
