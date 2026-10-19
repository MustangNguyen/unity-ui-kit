import { deltaE, palette, rgbToLab } from './image.mjs';

/**
 * Objective style comparison of two component images that are already cropped to the component's rect
 * and resized to the same size. No background segmentation: every measure is a profile or a statistic
 * of the whole crop, so it works the same on any art.
 *   vertical    lightness from top to bottom, sampled near the sides (gloss, gradient, 3D lip): one value per row
 *   horizontal  lightness from left to right, sampled near the top and bottom (rim, outline, corners): one per column
 *   face        dominant color of the crop
 *   detail      mean edge strength (flat vs detailed/glossy)
 */

const L = (raw, x, y) => {
  const o = (y * raw.width + x) * 4;
  const a = raw.data[o + 3] / 255;
  // Transparent pixels count as mid grey, the same on both sides.
  const mix = (c) => c * a + 128 * (1 - a);
  return rgbToLab(mix(raw.data[o]), mix(raw.data[o + 1]), mix(raw.data[o + 2]))[0];
};

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Undo a darkening overlay (a popup dim) by dividing colors by its factor (0..1). */
export function undim(raw, factor) {
  if (!factor || factor >= 1) return raw;
  const data = Buffer.from(raw.data);
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = Math.min(255, Math.round(data[i + c] / factor));
  return { data, width: raw.width, height: raw.height };
}

export function profiles(raw) {
  const { width: w, height: h } = raw;
  // Bands near the sides (10-25% and 75-90%), not the middle: a centered label or glyph is content, not style,
  // and differs between the reference and the game. The median keeps stray pixels from dominating.
  const sides = (n) => {
    const out = [];
    for (const [a, b] of [[0.1, 0.25], [0.75, 0.9]])
      for (let i = Math.round(n * a); i <= Math.round(n * b); i++) out.push(Math.min(n - 1, i));
    return out;
  };
  const columns = sides(w);
  const rowsAt = sides(h);
  const vertical = Array.from({ length: h }, (_, y) => median(columns.map((x) => L(raw, x, y))));
  const horizontal = Array.from({ length: w }, (_, x) => median(rowsAt.map((y) => L(raw, x, y))));
  let edges = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) edges += Math.hypot(L(raw, x + 1, y) - L(raw, x - 1, y), L(raw, x, y + 1) - L(raw, x, y - 1));
  const face = palette(raw, 4)[0];
  return { vertical, horizontal, detail: edges / Math.max(1, (w - 2) * (h - 2)), face };
}

const rmse = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const sample = (p, fractions) => fractions.map((f) => round(p[Math.min(p.length - 1, Math.round(f * (p.length - 1)))]));

/** Reference vs game, each measure with a fixed tolerance. Profiles are in Lab lightness (0..100). */
export function compareProfiles(ref, game, aspects) {
  const rows = [
    { feature: 'aspect', reference: round(aspects[0], 2), game: round(aspects[1], 2), diff: round(Math.abs(aspects[1] / aspects[0] - 1), 2), tolerance: 0.1, unit: 'ratio' },
    { feature: 'face', reference: ref.face.hex, game: game.face.hex, diff: round(deltaE(ref.face.lab, game.face.lab)), tolerance: 10, unit: 'ΔE' },
    {
      feature: 'vertical', reference: sample(ref.vertical, [0.1, 0.5, 0.9]).join('/'), game: sample(game.vertical, [0.1, 0.5, 0.9]).join('/'),
      diff: round(rmse(ref.vertical, game.vertical)), tolerance: 8, unit: 'ΔL rms (top/mid/bottom)',
    },
    {
      feature: 'horizontal', reference: sample(ref.horizontal, [0.03, 0.1, 0.5]).join('/'), game: sample(game.horizontal, [0.03, 0.1, 0.5]).join('/'),
      diff: round(rmse(ref.horizontal, game.horizontal)), tolerance: 8, unit: 'ΔL rms (edge/inner/center)',
    },
    { feature: 'detail', reference: round(ref.detail), game: round(game.detail), diff: round(Math.abs(game.detail - ref.detail)), tolerance: 3, unit: 'edge strength' },
  ];
  return rows.map((r) => ({ ...r, pass: r.diff <= r.tolerance }));
}

/** A small SVG chart of two profiles (reference grey, game orange), for the report image. */
export function profileChart(ref, game, width, height, title) {
  const path = (p) => p.map((v, i) => `${i ? 'L' : 'M'}${((i / Math.max(1, p.length - 1)) * (width - 8) + 4).toFixed(1)},${(height - 4 - (v / 100) * (height - 20)).toFixed(1)}`).join('');
  return `<rect width="${width}" height="${height}" fill="#fff"/>` +
    `<text x="4" y="12" font-family="sans-serif" font-size="11" fill="#333">${title}</text>` +
    `<path d="${path(ref)}" fill="none" stroke="#888" stroke-width="2"/><path d="${path(game)}" fill="none" stroke="#e8590c" stroke-width="2"/>`;
}
