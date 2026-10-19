import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadProject } from '../lib/project.mjs';
import { composeGrid } from '../lib/sheet.mjs';
import { buildBox, buildIcon, buildRaw } from '../lib/svg.mjs';
import { createTokens } from '../lib/theme.mjs';
import { fail, readJson, relative, writeIfChanged, writeJson } from '../lib/util.mjs';

const DEFAULT_STATES = ['normal', 'pressed', 'disabled'];

/**
 * uikit gen [--only id,id]
 * assets.json + theme.json -> UIKit/svg/*.svg, <generatedDir>/*.png, _uikit_import.json, ui-theme.json
 * and a preview grid at UIKit/reports/assets.png.
 */
export default async function gen(args) {
  const project = loadProject(args.project);
  const tokens = createTokens(project.theme);
  const { assets } = readJson(path.join(project.dir, 'assets.json'));
  if (args.only === true) fail('--only needs ids, e.g. --only btn_primary,panel_main');
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
  if (preview.length) {
    const sheet = path.join(project.dir, 'reports', 'assets.png');
    writeIfChanged(sheet, await composeGrid(preview));
    console.log(`preview: ${relative(sheet)}`);
  }
  console.log(`${preview.length} sprites (${changed} changed) -> ${relative(outDir)}`);
  if (failed) process.exitCode = 1;
}

function* variants(asset, tokens, project) {
  const { id, size } = asset;
  if (!Array.isArray(size) || size.length !== 2) throw new Error('"size" must be [width, height]');
  const [width, height] = size;
  const source = () => fs.readFileSync(path.join(project.dir, asset.src), 'utf8');

  switch (asset.type) {
    case 'panel':
      yield { name: id, ...buildBox({ tokens, style: tokens.style(asset.style), width, height, id }) };
      break;
    case 'button':
      for (const state of asset.states ?? DEFAULT_STATES) {
        const name = `${id}_${state}`;
        yield { name, ...buildBox({ tokens, style: tokens.style(asset.style), width, height, state, id: name }) };
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
