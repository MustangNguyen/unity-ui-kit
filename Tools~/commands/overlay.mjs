import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadProject, loadScreen } from '../lib/project.mjs';
import { label } from '../lib/sheet.mjs';
import { fail, relative, writeIfChanged } from '../lib/util.mjs';

/**
 * uikit overlay <screen|image> [--grid 100]
 * Draws a labelled pixel grid and the screen's regions on the reference, so region
 * rectangles can be read and checked by eye (or by a vision model) instead of guessed.
 */
export default async function overlay(args) {
  const target = args._[1] ?? fail('usage: uikit overlay <screen|image> [--grid 100]');
  const project = loadProject(args.project);
  const isImage = /\.(png|jpe?g|webp)$/i.test(target) && fs.existsSync(target);
  const screen = isImage ? null : loadScreen(project, target);
  const imagePath = isImage ? path.resolve(target) : screen.referencePath;
  const { width, height } = await sharp(imagePath).metadata();
  const step = Number(args.grid ?? 100);

  let svg = '';
  for (let x = 0; x <= width; x += step) {
    svg += `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#00e5ff" stroke-opacity="${x % (step * 5) ? 0.35 : 0.8}" stroke-width="1"/>`;
    svg += label(x + 3, 16, x, { anchor: 'start', size: 13, color: '#00e5ff' });
  }
  for (let y = 0; y <= height; y += step) {
    svg += `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#00e5ff" stroke-opacity="${y % (step * 5) ? 0.35 : 0.8}" stroke-width="1"/>`;
    svg += label(3, y - 3, y, { anchor: 'start', size: 13, color: '#00e5ff' });
  }
  for (const region of screen?.regions ?? []) {
    const [x, y, w, h] = region.rect;
    svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ff2d75" fill-opacity="0.12" stroke="#ff2d75" stroke-width="3"/>`;
    svg += `<rect x="${x}" y="${y - 22}" width="${region.name.length * 9 + 10}" height="22" fill="#ff2d75"/>`;
    svg += label(x + 5, y - 6, region.name, { anchor: 'start', size: 15, color: '#fff' });
  }

  const name = screen?.name ?? path.basename(imagePath, path.extname(imagePath));
  const out = path.join(project.dir, 'reports', name, 'overlay.png');
  const png = await sharp(imagePath)
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg}</svg>`) }])
    .png()
    .toBuffer();
  writeIfChanged(out, png);
  console.log(relative(out));
}
