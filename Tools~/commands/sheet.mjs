import fs from 'node:fs';
import path from 'node:path';
import { cropRaw, edgeColor, loadRaw, palette, paletteDistance, toPng, withoutColor } from '../lib/image.mjs';
import { loadProject, loadScreen } from '../lib/project.mjs';
import { composeRows } from '../lib/sheet.mjs';
import { fail, relative, writeIfChanged, writeJson } from '../lib/util.mjs';

/**
 * uikit sheet <screen>
 * Per-asset review before anything is placed in Unity: for each region with an "asset",
 * shows the reference crop next to the generated sprite, with palettes and aspect ratio.
 */
export default async function sheet(args) {
  const project = loadProject(args.project);
  if (!args._[1]) fail('usage: uikit sheet <screen>');
  const screen = loadScreen(project, args._[1]);
  const outDir = path.join(project.dir, 'reports', screen.name);
  const generated = project.resolve(project.config.generatedDir);
  const ref = await loadRaw(screen.referencePath);

  const rows = [];
  const results = [];
  for (const region of screen.regions.filter((r) => r.asset)) {
    const assetPath = path.join(generated, `${region.asset}.png`);
    if (!fs.existsSync(assetPath)) {
      console.warn(`  ${region.name}: ${region.asset}.png not generated yet`);
      continue;
    }
    const refCrop = cropRaw(ref, region.rect);
    const asset = await loadRaw(assetPath);
    // The crop includes the screen behind the element; the sprite is transparent there.
    const background = region.background === false ? null : edgeColor(refCrop);
    const refPalette = withoutColor(palette(refCrop, 8), background);
    const assetPalette = palette(asset, 8);
    const result = {
      name: region.name,
      asset: region.asset,
      paletteDeltaE: paletteDistance(refPalette, assetPalette),
      aspect: { reference: ratio(refCrop), asset: ratio(asset) },
      referencePalette: refPalette.slice(0, 6).map((c) => c.hex),
      assetPalette: assetPalette.slice(0, 6).map((c) => c.hex),
    };
    results.push(result);
    rows.push({
      title: `${region.name} -> ${region.asset}`,
      images: [
        { buffer: await toPng(refCrop), caption: `reference ${refCrop.width}x${refCrop.height}` },
        { buffer: await toPng(asset), caption: `generated ${asset.width}x${asset.height}` },
      ],
      lines: [
        `palette ΔE ${result.paletteDeltaE ?? '-'}`,
        `aspect ${result.aspect.reference} vs ${result.aspect.asset} (asset includes shadow padding)`,
        background ? `background ${background.hex} ignored (set "background": false to keep)` : 'background kept',
        'palette: reference, then generated',
      ],
      swatches: [result.referencePalette, result.assetPalette],
    });
  }
  if (!rows.length) fail(`no region in ${relative(screen.file)} has a generated "asset"`);

  writeJson(path.join(outDir, 'sheet.json'), results);
  writeIfChanged(path.join(outDir, 'sheet.png'), await composeRows(rows));
  for (const r of results) console.log(`${r.name.padEnd(22)} ΔE ${String(r.paletteDeltaE).padEnd(6)} aspect ${r.aspect.reference} / ${r.aspect.asset}`);
  console.log(`\nimage: ${relative(path.join(outDir, 'sheet.png'))}`);
}

const ratio = (raw) => Math.round((raw.width / raw.height) * 100) / 100;
