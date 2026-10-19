import fs from 'node:fs';
import { cropRaw, loadRaw, palette } from '../lib/image.mjs';
import { loadProject, loadScreen } from '../lib/project.mjs';
import { fail } from '../lib/util.mjs';

/**
 * uikit palette <screen>            dominant colors of every region of a screen
 * uikit palette <image> [--rect x,y,w,h] [--k 6]
 * Measured colors for spec extraction, instead of guessing hex values by eye.
 */
export default async function paletteCommand(args) {
  const target = args._[1] ?? fail('usage: uikit palette <screen|image> [--rect x,y,w,h] [--k 6]');
  const k = Number(args.k ?? 6);
  const isImage = /\.(png|jpe?g|webp)$/i.test(target) && fs.existsSync(target);

  if (isImage) {
    let raw = await loadRaw(target);
    if (args.rect) raw = cropRaw(raw, String(args.rect).split(',').map(Number));
    console.log(JSON.stringify(format(palette(raw, k)), null, 2));
    return;
  }

  const screen = loadScreen(loadProject(args.project), target);
  const ref = await loadRaw(screen.referencePath);
  const out = { screen: format(palette(ref, k)) };
  for (const region of screen.regions) out[region.name] = format(palette(cropRaw(ref, region.rect), k));
  console.log(JSON.stringify(out, null, 2));
}

const format = (colors) => colors.map(({ hex, share }) => ({ hex, share }));
