/**
 * Display-quality checks on a render model. These catch what a match against the preview cannot,
 * because the preview reproduces them faithfully:
 *   border   9-slice borders larger than the element: Unity squashes corners and round ends
 *   blur     art shown larger than its pixels on a real device (deviceScale)
 *   stretch  Simple images whose aspect ratio differs from the sprite's
 *   stroke   one sprite drawn with different border scales: outlines of different thickness
 *   tile     Tiled pattern size (info, to compare with the reference)
 * Each issue has a concrete fix that can go into the reskin map.
 */

const round2 = (v) => Math.ceil(v * 100) / 100;
const fmt = (v) => Math.round(v);

export function lintModel(model, { deviceScale = 1.5 } = {}) {
  const issues = [];
  const add = (op, kind, severity, message, fix = null) =>
    issues.push({ path: op.path, rect: op.rect, kind, severity, message, fix, decoration: Boolean(op.decoration) });
  const strokeGroups = new Map();

  for (const op of model.ops) {
    if (op.kind !== 'image' || !op.image.file) continue;
    const img = op.image;
    const [, , w, h] = op.rect;
    if (!(w > 0) || !(h > 0)) continue;
    const src = img.sourcePx ?? (img.crop ? img.crop.slice(2, 4) : null);
    const mul = img.ppuMultiplier ?? 1;
    const solid = src && src[0] <= 8 && src[1] <= 8; // a tiny swatch stretched as a flat fill
    const bordered = img.slice?.some((v) => v > 0) && (img.type === 'Sliced' || img.type === 'Tiled');

    // Filled ignores 9-slice borders: a pill/rounded sprite is stretched as a whole, ends included
    // (unless preserveAspect fits it; then the blur check below applies).
    if (img.type === 'Filled' && img.slice?.some((v) => v > 0) && src && !img.preserveAspect) {
      const ratio = w / h / (src[0] / src[1]);
      if (Math.abs(ratio - 1) > 0.08)
        add(op, 'stretch', Math.abs(ratio - 1) > 0.15 ? 'error' : 'warn',
          `Filled image ignores the sprite's 9-slice border, so its rounded ends stretch x${(ratio > 1 ? ratio : 1 / ratio).toFixed(2)} (sprite ${fmt(src[0])}x${fmt(src[1])}, rect ${fmt(w)}x${fmt(h)})`,
          {
            needSprite: `made for ${fmt(w)}x${fmt(h)} design px (ends stay round when full; a partial Horizontal fill still cuts its end flat)`,
            codeChange: 'round ends at any progress need a Sliced image whose width the game code sets instead of fillAmount',
          });
      continue;
    }

    if (bordered) {
      const [l, b, r, t] = img.sliceUnits;
      const worst = Math.max((l + r) / w, (b + t) / h);
      if (worst > 1.01) {
        add(op, 'border', worst > 1.15 ? 'error' : 'warn',
          `9-slice borders ${fmt(l + r)}x${fmt(b + t)} px do not fit ${fmt(w)}x${fmt(h)}: Unity squashes the corners (${Math.round((worst - 1) * 100)}% too big)`,
          { ppuMultiplier: round2(mul * worst), alternative: `a sprite variant made for height ${fmt(h)} (assets.json "heights")` });
      }
      const density = Math.max(...img.sliceUnits.map((u, i) => (img.slice[i] > 0 ? u / img.slice[i] : 0)));
      if (density * deviceScale > 1.25)
        add(op, 'blur', density * deviceScale > 2 ? 'error' : 'warn',
          `corners drawn at ${(density * deviceScale).toFixed(1)}x their pixels on a ${deviceScale}x screen: soft edges`,
          { regenerate: `uikit gen with "scale" >= ${Math.ceil(density * deviceScale)}`, or: `ppuMultiplier ${round2(mul * density * deviceScale)} (thinner borders)` });
      const key = img.sprite ?? img.file;
      if (!strokeGroups.has(key)) strokeGroups.set(key, []);
      // The smallest multiplier this node can take without squashed borders or blurry corners.
      const minMul = Math.max(mul * Math.max((l + r) / w, (b + t) / h), (mul * density * deviceScale) / 1.25);
      // Density after this node's own border fix (if any), so the group's target is not skewed by it.
      const fixedDensity = worst > 1.01 ? density / worst : density;
      strokeGroups.get(key).push({ op, density: fixedDensity, mul: worst > 1.01 ? mul * worst : mul, minMul });
    } else if (src && !solid && img.type !== 'Tiled') {
      let [dw, dh] = [w, h];
      // uGUI honours preserveAspect only for Simple and Filled; a borderless Sliced sprite stretches.
      if (img.preserveAspect && (img.type === 'Simple' || img.type === 'Filled')) {
        const s = Math.min(w / src[0], h / src[1]);
        [dw, dh] = [src[0] * s, src[1] * s];
      } else if (img.type === 'Simple' || img.type === 'Sliced') {
        const ratio = w / h / (src[0] / src[1]);
        if (Math.abs(ratio - 1) > 0.08)
          add(op, 'stretch', Math.abs(ratio - 1) > 0.15 ? 'error' : 'warn',
            `stretched ${ratio > 1 ? 'wide' : 'tall'} x${(ratio > 1 ? ratio : 1 / ratio).toFixed(2)} (sprite ${fmt(src[0])}x${fmt(src[1])}, rect ${fmt(w)}x${fmt(h)})`,
            { preserveAspect: 'true', alternative: 'a sprite with the rect\'s aspect ratio' });
      }
      const up = Math.max(dw / src[0], dh / src[1]) * deviceScale;
      if (up > 1.25)
        add(op, 'blur', up > 2 ? 'error' : 'warn',
          `shown at ${up.toFixed(1)}x its pixels on a ${deviceScale}x screen (${fmt(src[0])}x${fmt(src[1])} px for ${fmt(dw)}x${fmt(dh)} design px): blurry`,
          { needSourcePx: [Math.ceil(dw * deviceScale), Math.ceil(dh * deviceScale)] });
    } else if (img.type === 'Tiled' && img.spriteUnits) {
      add(op, 'tile', 'info', `pattern tile shows at ${fmt(img.spriteUnits[0])}x${fmt(img.spriteUnits[1])} design px (${(model.width / img.spriteUnits[0]).toFixed(1)} tiles across)`,
        { hint: 'ppuMultiplier scales the tile: 2 = half size, 0.5 = double size' });
    }
  }

  // One sprite, several border scales: outlines and corner radii differ between elements of the same role.
  for (const [sprite, group] of strokeGroups) {
    if (group.length < 2) continue;
    const ds = group.map((g) => g.density).sort((a, b) => a - b);
    const [min, max] = [ds[0], ds[ds.length - 1]];
    if (max / min <= 1.15) continue;
    const target = ds[Math.floor(ds.length / 2)];
    for (const g of group) {
      if (Math.abs(g.density / target - 1) <= 0.07) continue;
      // Never below what keeps this node's borders fitting and its corners sharp.
      const wanted = (g.mul * g.density) / target;
      const capped = wanted < g.minMul;
      add(g.op, 'stroke', 'warn',
        `"${sprite}" border scale ${g.density.toFixed(2)} here vs ${target.toFixed(2)} elsewhere (${group.length} uses): outline thickness differs` +
        (capped ? '; the border cannot get thicker here without squashing or blurring, so use a sprite made for this size' : ''),
        capped ? { alternative: 'a sprite variant made for this element height (assets.json "heights")' } : { ppuMultiplier: round2(wanted) });
    }
  }
  return issues;
}
