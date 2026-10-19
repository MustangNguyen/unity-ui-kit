import sharp from 'sharp';
import { escapeXml } from './util.mjs';

const svgDoc = (width, height, body) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`);

export const label = (x, y, text, { size = 18, anchor = 'middle', color = '#222', weight = 'normal' } = {}) =>
  `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(text)}</text>`;

const checker = (width, height, size = 16) =>
  `<defs><pattern id="c" width="${size * 2}" height="${size * 2}" patternUnits="userSpaceOnUse">` +
  `<rect width="${size * 2}" height="${size * 2}" fill="#f2f2f2"/><rect width="${size}" height="${size}" fill="#dcdcdc"/>` +
  `<rect x="${size}" y="${size}" width="${size}" height="${size}" fill="#dcdcdc"/></pattern></defs>` +
  `<rect width="${width}" height="${height}" fill="url(#c)"/>`;

async function fit(buffer, width, height) {
  const { data, info } = await sharp(buffer)
    .resize(width, height, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Grid of images on a checkerboard (so transparency shows), each with a caption. */
export async function composeGrid(items, { cell = 220, cols = 6, caption = 30 } = {}) {
  cols = Math.max(1, Math.min(cols, items.length));
  const rows = Math.ceil(items.length / cols);
  const width = cols * cell;
  const height = rows * (cell + caption);
  const layers = [{ input: svgDoc(width, height, checker(width, height)), left: 0, top: 0 }];
  let text = '';
  for (const [i, item] of items.entries()) {
    const cx = (i % cols) * cell;
    const cy = Math.floor(i / cols) * (cell + caption);
    const image = await fit(item.buffer, cell - 20, cell - 20);
    layers.push({ input: image.data, left: cx + Math.round((cell - image.width) / 2), top: cy + Math.round((cell - image.height) / 2) });
    text += `<rect x="${cx}" y="${cy + cell}" width="${cell}" height="${caption}" fill="#fff"/>` + label(cx + cell / 2, cy + cell + 21, item.label, { size: 15 });
  }
  layers.push({ input: svgDoc(width, height, text), left: 0, top: 0 });
  return sharp({ create: { width, height, channels: 4, background: '#ffffff' } }).composite(layers).png().toBuffer();
}

/**
 * One row per entry: images side by side at the same height, then text lines and color swatches.
 * entries: [{ title, images: [{ buffer, caption }], lines: [string], swatches: [[hex...], ...] }]
 */
export async function composeRows(entries, { height = 260, imageWidth = 380, infoWidth = 420 } = {}) {
  const columns = Math.max(...entries.map((e) => e.images.length));
  const gap = 16;
  const width = gap + columns * (imageWidth + gap) + infoWidth;
  const rowHeight = height + 44;
  const total = entries.length * rowHeight;
  const layers = [];
  let overlay = '';

  for (const [r, entry] of entries.entries()) {
    const top = r * rowHeight;
    overlay += `<rect x="0" y="${top}" width="${width}" height="${rowHeight}" fill="${r % 2 ? '#fafafa' : '#ffffff'}"/>`;
    overlay += label(gap, top + 26, entry.title, { anchor: 'start', size: 20, weight: 'bold' });
    for (const [c, img] of entry.images.entries()) {
      const left = gap + c * (imageWidth + gap);
      overlay += `<rect x="${left}" y="${top + 36}" width="${imageWidth}" height="${height}" fill="#e6e6e6"/>`;
      if (img.caption) overlay += label(left + imageWidth / 2, top + 36 + height - 8, img.caption, { size: 14, color: '#555' });
      const fitted = await fit(img.buffer, imageWidth, height - 24);
      layers.push({ input: fitted.data, left: left + Math.round((imageWidth - fitted.width) / 2), top: top + 36 + Math.round((height - 24 - fitted.height) / 2) });
    }
    const infoLeft = gap + columns * (imageWidth + gap);
    let y = top + 60;
    for (const line of entry.lines ?? []) {
      overlay += label(infoLeft, y, line, { anchor: 'start', size: 16 });
      y += 24;
    }
    for (const row of entry.swatches ?? []) {
      row.forEach((hex, i) => {
        overlay += `<rect x="${infoLeft + i * 44}" y="${y}" width="40" height="28" fill="${hex}" stroke="#999"/>`;
      });
      y += 36;
    }
  }

  return sharp({ create: { width, height: total, channels: 4, background: '#ffffff' } })
    .composite([{ input: svgDoc(width, total, overlay), left: 0, top: 0 }, ...layers])
    .png()
    .toBuffer();
}
