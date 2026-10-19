import sharp from 'sharp';
import { parseColor } from './model.mjs';
import { escapeXml } from './util.mjs';

// Draws a render model to a PNG the way uGUI would: hierarchy order, 9-slice with Unity's border
// shrinking, multiplicative tint, CanvasGroup alpha, Mask/RectMask2D clipping. Text uses the system's
// fallback fonts (TMP SDF fonts cannot be loaded here), so comparisons mask text areas.

const sourceCache = new Map();

/** Source pixels of a sprite (cropped to its rect in the texture), or a 4x4 white quad when there is no sprite. */
/** crop: [x, y, w, h] from the top-left; cropBottom: the same from the bottom-left (Unity sprite rects in a .meta). */
export async function loadSource(file, crop, cropBottom = null) {
  const key = `${file}|${crop?.join(',')}|${cropBottom?.join(',')}`;
  if (sourceCache.has(key)) return sourceCache.get(key);
  let raw;
  if (!file) raw = { data: Buffer.alloc(4 * 4 * 4, 255), width: 4, height: 4 };
  else {
    try {
      const meta = await sharp(file).metadata();
      // 16-bit and greyscale PNGs must become 8-bit RGBA, or the raw buffer is read with the wrong stride.
      let image = sharp(file).toColourspace('srgb').ensureAlpha();
      if (!crop && cropBottom) crop = [cropBottom[0], meta.height - cropBottom[1] - cropBottom[3], cropBottom[2], cropBottom[3]];
      if (crop) {
        const left = Math.min(meta.width - 1, Math.max(0, Math.round(crop[0])));
        const top = Math.min(meta.height - 1, Math.max(0, Math.round(crop[1])));
        const width = Math.max(1, Math.min(meta.width - left, Math.round(crop[2])));
        const height = Math.max(1, Math.min(meta.height - top, Math.round(crop[3])));
        image = image.extract({ left, top, width, height });
      }
      const { data, info } = await image.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
      raw = { data, width: info.width, height: info.height };
    } catch (error) {
      // Built-in sprites (unity_builtin_extra), PSDs and other formats sharp cannot read.
      warnings.add(`cannot read ${file}: ${error.message}`);
      raw = null;
    }
  }
  sourceCache.set(key, raw);
  return raw;
}

/** Problems met while rendering (unreadable sprite files); shown by the commands. */
export const warnings = new Set();

const asInput = (raw) => ({ input: raw.data, raw: { width: raw.width, height: raw.height, channels: 4 } });

async function resize(raw, width, height, fit = 'fill') {
  const { data, info } = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } })
    .resize(Math.max(1, width), Math.max(1, height), { fit, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function extract(raw, left, top, width, height) {
  const { data, info } = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } })
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function blank(width, height, pieces) {
  const { data, info } = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(pieces)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** 9-slice: corners keep their size, edges stretch along one axis, the center both. */
export async function nineSlice(source, slicePx, sliceUnits, width, height, fillCenter = true) {
  const [sl, sb, sr, st] = slicePx;
  let [dl, db, dr, dt] = sliceUnits;
  // Unity's Image.GetAdjustedBorders: borders shrink proportionally when the rect is smaller than them.
  if (dl + dr > width && dl + dr > 0) [dl, dr] = [(dl * width) / (dl + dr), (dr * width) / (dl + dr)];
  if (db + dt > height && db + dt > 0) [db, dt] = [(db * height) / (db + dt), (dt * height) / (db + dt)];
  const sx = [0, sl, source.width - sr, source.width].map(Math.round);
  const sy = [0, st, source.height - sb, source.height].map(Math.round);
  const dx = [0, dl, width - dr, width].map(Math.round);
  const dy = [0, dt, height - db, height].map(Math.round);
  const pieces = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      if (i === 1 && j === 1 && !fillCenter) continue;
      const [w, h] = [sx[i + 1] - sx[i], sy[j + 1] - sy[j]];
      const [tw, th] = [dx[i + 1] - dx[i], dy[j + 1] - dy[j]];
      if (w <= 0 || h <= 0 || tw <= 0 || th <= 0) continue;
      const piece = await resize(await extract(source, sx[i], sy[j], w, h), tw, th);
      pieces.push({ ...asInput(piece), left: dx[i], top: dy[j] });
    }
  }
  return blank(width, height, pieces);
}

/** Image type Tiled without borders: the sprite repeats at its native size from the bottom-left corner, as uGUI does. */
export async function tile(source, [tileW, tileH], width, height) {
  // Cell edges at round(i * tile) keep the fractional tile size, so the pattern stays in phase with Unity.
  const cache = new Map();
  const cell = async (w, h) => {
    if (!cache.has(`${w}x${h}`)) cache.set(`${w}x${h}`, await resize(source, w, h));
    return cache.get(`${w}x${h}`);
  };
  const pieces = [];
  for (let j = 0; height - Math.round(j * tileH) > 0; j++) {
    const bottom = height - Math.round(j * tileH);
    const top = height - Math.round((j + 1) * tileH);
    for (let i = 0; Math.round(i * tileW) < width; i++) {
      const left = Math.round(i * tileW);
      const right = Math.round((i + 1) * tileW);
      const piece = await cell(Math.max(1, right - left), Math.max(1, bottom - top));
      // Cells hanging over the top or right edge are cropped (uGUI keeps the bottom-left of the sprite).
      const [x0, y0] = [left, Math.max(0, top)];
      const [w, h] = [Math.min(piece.width, width - left), Math.min(piece.height, bottom - y0)];
      if (w <= 0 || h <= 0) continue;
      const part = w === piece.width && h === piece.height ? piece : await extract(piece, 0, piece.height - h, w, h);
      pieces.push({ ...asInput(part), left: x0, top: y0 });
    }
  }
  return blank(width, height, pieces);
}

/** Multiplies RGBA by a tint and an extra alpha, in place on a copy. */
export function tint(raw, color, alpha = 1) {
  const [r, g, b, a] = parseColor(color);
  const data = Buffer.from(raw.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * r);
    data[i + 1] = Math.round(data[i + 1] * g);
    data[i + 2] = Math.round(data[i + 2] * b);
    data[i + 3] = Math.round(data[i + 3] * a * alpha);
  }
  return { data, width: raw.width, height: raw.height };
}

/** Image type Filled: keep the filled fraction (horizontal/vertical; radial fills are drawn full). */
function applyFill(raw, method, amount, origin) {
  if (amount >= 0.999 || !/Horizontal|Vertical/.test(method ?? '')) return raw;
  const data = Buffer.from(raw.data);
  const { width, height } = raw;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const keep = method === 'Horizontal'
        ? origin === 1 ? x >= width * (1 - amount) : x < width * amount
        : origin === 1 ? y < height * amount : y >= height * (1 - amount);
      if (!keep) data[(y * width + x) * 4 + 3] = 0;
    }
  }
  return { data, width, height };
}

/** Pixels of one image op at its final size (before alpha and clipping). */
export async function drawImage(op, width, height) {
  const img = op.image;
  const source = await loadSource(img.file, img.crop, img.cropBottom);
  if (!source) return null;
  let raw;
  const sliced = (img.type === 'Sliced' || img.type === 'Tiled') && img.slice.some((v) => v > 0);
  const tiled = img.type === 'Tiled' && !sliced && img.spriteUnits?.every((v) => v >= 1);
  if (tiled) raw = await tile(source, img.spriteUnits, width, height);
  else if (sliced) raw = await nineSlice(source, img.slice, img.sliceUnits, width, height, img.fillCenter !== false);
  else if (img.preserveAspect && (img.type === 'Simple' || img.type === 'Filled')) {
    // Unity places the fitted image by the pivot, and fills the fitted rect, not the whole one.
    let fitted = await resize(source, width, height, 'inside');
    if (img.type === 'Filled') fitted = applyFill(fitted, img.fillMethod, img.fillAmount, img.fillOrigin);
    const [px, py] = img.pivot ?? [0.5, 0.5];
    raw = await blank(width, height, [{ ...asInput(fitted), left: Math.round((width - fitted.width) * px), top: Math.round((height - fitted.height) * (1 - py)) }]);
  } else {
    raw = await resize(source, width, height);
    if (img.type === 'Filled') raw = applyFill(raw, img.fillMethod, img.fillAmount, img.fillOrigin);
  }
  return tint(raw, img.tint, 1);
}

const H_ALIGN = (a = '') => (/Left|Justified|Flush|Geometry/.test(a) && !/Center/.test(a) ? 'start' : /Right/.test(a) ? 'end' : 'middle');
const V_ALIGN = (a = '') => (/^Top|^Upper/.test(a) ? 'top' : /^Bottom|^Lower/.test(a) ? 'bottom' : 'middle');

/** Wraps by an estimated glyph width (fallback fonts differ from the game's anyway). */
function wrapLines(text, width, size, wrap) {
  const paragraphs = text.split('\n');
  if (!wrap) return paragraphs;
  const perLine = Math.max(1, Math.floor(width / (size * 0.52)));
  const lines = [];
  for (const p of paragraphs) {
    let line = '';
    for (const word of p.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > perLine && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

export function textSvg(op, width, height) {
  const t = op.text;
  const [r, g, b, a] = parseColor(t.color);
  const content = t.upper ? t.content.toUpperCase() : t.content;
  const lineHeight = t.size * 1.2;
  const lines = wrapLines(content, width, t.size, t.wrap);
  const block = lines.length * lineHeight;
  const valign = V_ALIGN(t.alignment);
  const top = valign === 'top' ? 0 : valign === 'bottom' ? height - block : (height - block) / 2;
  const anchor = H_ALIGN(t.alignment);
  const x = anchor === 'start' ? 0 : anchor === 'end' ? width : width / 2;
  const fill = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" y="${(top + i * lineHeight + t.size * 0.95).toFixed(1)}">${escapeXml(line)}</tspan>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<text font-family="${escapeXml(t.family || 'sans-serif')}, sans-serif" font-size="${t.size}" fill="${fill}" fill-opacity="${a}" ` +
    `font-weight="${t.bold ? 700 : 400}" font-style="${t.italic ? 'italic' : 'normal'}" text-anchor="${anchor}">${tspans}</text></svg>`;
}

async function drawText(op, width, height) {
  const { data, info } = await sharp(Buffer.from(textSvg(op, width, height))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Visible part of rect after the clip rect and the canvas bounds: [left, top, right, bottom] in canvas px. */
function visibleBox(rect, clip, width, height) {
  let [l, t, r, b] = [rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]];
  if (clip) [l, t, r, b] = [Math.max(l, clip[0]), Math.max(t, clip[1]), Math.min(r, clip[0] + clip[2]), Math.min(b, clip[1] + clip[3])];
  [l, t, r, b] = [Math.max(0, l), Math.max(0, t), Math.min(width, r), Math.min(height, b)].map(Math.round);
  return r > l && b > t ? [l, t, r, b] : null;
}

/** Renders the whole model; `masks` collects text rects so comparisons can ignore them. */
export async function renderModel(model, { background = null } = {}) {
  const layers = [];
  const masks = [];
  // A custom shader decides what effect ops show (glare, iris reveal, grayscale). Shader-only quads (no sprite)
  // are left out; sprite-backed ones are drawn as plain sprites. Both are masked out of comparisons.
  for (const op of model.ops) {
    if (op.effect) {
      const box = visibleBox(op.rect.map(Math.round), op.clip, model.width, model.height);
      if (box) masks.push([box[0], box[1], box[2] - box[0], box[3] - box[1]]);
      if (op.kind === 'image' && !op.image.file) continue;
    }
    const [x, y, w, h] = op.rect.map(Math.round);
    if (w <= 0 || h <= 0) continue;
    const box = visibleBox([x, y, w, h], op.clip, model.width, model.height);
    if (!box) continue;
    let raw = op.kind === 'image' ? await drawImage(op, w, h) : await drawText(op, w, h);
    if (!raw) continue;
    if (op.alpha < 1) raw = tint(raw, '#FFFFFFFF', op.alpha);
    const [l, t, r, b] = box;
    if (l !== x || t !== y || r - l !== w || b - t !== h) raw = await extract(raw, l - x, t - y, r - l, b - t);
    layers.push({ ...asInput(raw), left: l, top: t });
    if (op.kind === 'text') masks.push([l, t, r - l, b - t]);
  }
  const bg = background ? parseColor(background) : [0, 0, 0, 0];
  const png = await sharp({
    create: { width: model.width, height: model.height, channels: 4, background: { r: bg[0] * 255, g: bg[1] * 255, b: bg[2] * 255, alpha: bg[3] } },
  })
    .composite(layers)
    .png()
    .toBuffer();
  return { png, masks };
}
