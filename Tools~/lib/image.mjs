import sharp from 'sharp';

/** RGBA pixels of an image file or buffer, optionally cropped and resized. */
export async function loadRaw(input, { extract, resize } = {}) {
  let image = sharp(input);
  if (extract) image = image.extract(extract);
  if (resize) image = image.resize(resize.width, resize.height, { fit: resize.fit ?? 'fill' });
  // Always 8-bit RGBA: 16-bit or greyscale PNGs would otherwise come back with another layout.
  const { data, info } = await image.toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export const toSharp = (raw) => sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } });

export const toPng = (raw) => toSharp(raw).png().toBuffer();

/** Crops to [x, y, w, h], clipped to the image bounds. */
export function cropRaw(raw, rect) {
  const [rx, ry, rw, rh] = rect.map(Math.round);
  const x = Math.max(0, rx), y = Math.max(0, ry);
  const w = Math.min(raw.width, rx + rw) - x;
  const h = Math.min(raw.height, ry + rh) - y;
  if (w <= 0 || h <= 0) throw new Error(`crop [${rect}] is outside the ${raw.width}x${raw.height} image`);
  const data = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * raw.width + x) * 4;
    raw.data.copy(data, row * w * 4, from, from + w * 4);
  }
  return { data, width: w, height: h };
}

/** Downscales so the longest side is at most `max` px, but never below `minShort` px on the short side. */
export async function shrinkRaw(raw, max, minShort = 32) {
  let scale = Math.min(1, max / Math.max(raw.width, raw.height));
  scale = Math.max(scale, Math.min(1, minShort / Math.min(raw.width, raw.height)));
  if (scale === 1) return raw;
  return loadRaw(await toPng(raw), {
    resize: { width: Math.max(1, Math.round(raw.width * scale)), height: Math.max(1, Math.round(raw.height * scale)) },
  });
}

const toLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function rgbToLab(r, g, b) {
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const fy = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const fz = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 color difference. Rough guide: < 3 invisible, < 10 close, > 20 clearly different. */
export const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Dominant colors by k-means in Lab space (deterministic). Transparent pixels are ignored. */
export function palette(raw, k = 6, maxSamples = 8000) {
  const samples = [];
  // Grid sampling: a linear stride can land on the same few columns of every row.
  const step = Math.max(1, Math.floor(Math.sqrt((raw.width * raw.height) / maxSamples)));
  for (let y = 0; y < raw.height; y += step) {
    for (let x = 0; x < raw.width; x += step) {
      const o = (y * raw.width + x) * 4;
      if (raw.data[o + 3] < 128) continue;
      const rgb = [raw.data[o], raw.data[o + 1], raw.data[o + 2]];
      samples.push({ rgb, lab: rgbToLab(...rgb) });
    }
  }
  if (samples.length === 0) return [];
  k = Math.min(k, samples.length);

  // k-means++ seeding with a fixed seed, so the same image always gives the same palette.
  const random = mulberry32(42);
  const centers = [samples[Math.floor(random() * samples.length)].lab];
  while (centers.length < k) {
    const weights = samples.map((s) => Math.min(...centers.map((c) => deltaE(s.lab, c))) ** 2);
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum === 0) break;
    let pick = random() * sum;
    let index = 0;
    while ((pick -= weights[index]) > 0) index++;
    centers.push(samples[index].lab);
  }

  let clusters = [];
  for (let iteration = 0; iteration < 12; iteration++) {
    clusters = centers.map(() => ({ lab: [0, 0, 0], rgb: [0, 0, 0], count: 0 }));
    for (const s of samples) {
      let best = 0, bestD = Infinity;
      centers.forEach((c, i) => {
        const d = deltaE(s.lab, c);
        if (d < bestD) [best, bestD] = [i, d];
      });
      const cluster = clusters[best];
      cluster.count++;
      for (let j = 0; j < 3; j++) {
        cluster.lab[j] += s.lab[j];
        cluster.rgb[j] += s.rgb[j];
      }
    }
    clusters.forEach((c, i) => {
      if (c.count) centers[i] = c.lab.map((v) => v / c.count);
    });
  }

  return clusters
    .filter((c) => c.count)
    .map((c) => ({
      hex: hex(c.rgb.map((v) => v / c.count)),
      share: Math.round((c.count / samples.length) * 1000) / 1000,
      lab: c.lab.map((v) => v / c.count),
    }))
    .sort((a, b) => b.share - a.share);
}

/** Most common color along the edge of a crop: the background a sprite would sit on. */
export function edgeColor(raw) {
  const { width: w, height: h } = raw;
  const data = [];
  const push = (x, y) => {
    const o = (y * w + x) * 4;
    data.push(raw.data[o], raw.data[o + 1], raw.data[o + 2], raw.data[o + 3]);
  };
  for (let x = 0; x < w; x++) push(x, 0), push(x, h - 1);
  for (let y = 1; y < h - 1; y++) push(0, y), push(w - 1, y);
  return palette({ data: Buffer.from(data), width: data.length / 4, height: 1 }, 3)[0] ?? null;
}

/** Drops colors close to `background` (ΔE < limit) and renormalizes the shares. */
export function withoutColor(colors, background, limit = 12) {
  if (!background) return colors;
  const kept = colors.filter((c) => deltaE(c.lab, background.lab) >= limit);
  const total = kept.reduce((sum, c) => sum + c.share, 0) || 1;
  return kept.map((c) => ({ ...c, share: Math.round((c.share / total) * 1000) / 1000 }));
}

/** Weighted distance from each reference color to its closest candidate color. */
export function paletteDistance(reference, candidate) {
  if (!reference.length || !candidate.length) return null;
  const total = reference.reduce((sum, c) => sum + c.share, 0);
  const distance = reference.reduce((sum, r) => sum + r.share * Math.min(...candidate.map((c) => deltaE(r.lab, c.lab))), 0);
  return Math.round((distance / total) * 10) / 10;
}
