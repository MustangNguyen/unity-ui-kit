import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { buildModel, listSurfaces, loadInventory, parseColor, reskinPath } from '../lib/model.mjs';
import { loadProject } from '../lib/project.mjs';
import { drawImage, loadSource, tint } from '../lib/render.mjs';
import { escapeXml, fail, readJson, relative, writeAtomic, writeJson } from '../lib/util.mjs';

/**
 * uikit canvas [<surface>...] [--before] [--blobs <file>]
 * Generates a Claude Design canvas (the files /design publishes) from the same model as the preview,
 * so the canvas has the game's real structure and real sprites, never placeholders:
 *   UIKit/canvas/project/canvas.json            boards, one per surface, in rows
 *   UIKit/canvas/project/<Surface>.dc.html      absolute layout at the reference resolution
 *   UIKit/canvas/assets/<key>.png|ttf           baked sprites (crop + tint) and fonts to upload
 *   UIKit/canvas/uploads.json                   [{ key, file }] for the upload step
 *   UIKit/canvas/design-system/tokens.json      theme.json as Design System tokens
 * Images must be uploaded to the canvas (they become /_blob/<id> urls): upload every file in uploads.json,
 * write { "<key>": "/_blob/<id>" } to a JSON file, then rerun with --blobs <file> to fill the urls in.
 */
export default async function canvas(args) {
  const project = loadProject(args.project);
  const surfaces = args._.length > 1 ? args._.slice(1) : listSurfaces(project);
  if (!surfaces.length) fail('no surfaces (UIKit/surfaces.json)');
  const blobs = args.blobs ? readJson(path.resolve(args.blobs)) : null;

  const outDir = path.join(project.dir, 'canvas');
  const assetDir = path.join(outDir, 'assets');
  const uploads = new Map();
  const boards = {};
  const order = [];
  const files = [];
  const perRow = 6;
  let x = 0;
  let y = 0;
  let rowHeight = 0;

  for (const [i, surface] of surfaces.entries()) {
    const inventory = loadInventory(project, surface);
    const mapFile = reskinPath(project, surface);
    const reskin = !args.before && fs.existsSync(mapFile) ? readJson(mapFile) : null;
    const model = buildModel(project, inventory, { reskin });
    const html = await artboard(model, { assetDir, uploads, blobs, background: project.config.background });
    // The first artboard is the canvas entry and must be Main.dc.html.
    const file = i === 0 ? 'Main.dc.html' : `${surface.replace(/[^A-Za-z0-9_.-]/g, '_')}.dc.html`;
    files.push([file, html]);
    if (i > 0 && i % perRow === 0) {
      x = 0;
      y += rowHeight + 120;
      rowHeight = 0;
    }
    boards[file] = { x, y, w: model.width, h: model.height, title: surface };
    order.push(file);
    x += model.width + 80;
    rowHeight = Math.max(rowHeight, model.height);
  }

  const missing = blobs ? [...uploads.keys()].filter((k) => !blobs[k]) : [];
  if (missing.length) fail(`--blobs has no url for: ${missing.join(', ')}`);

  // /design shows every .dc.html in project/, listed or not: drop artboards this run did not produce.
  const projectDir = path.join(outDir, 'project');
  if (fs.existsSync(projectDir))
    for (const stale of fs.readdirSync(projectDir).filter((f) => f.endsWith('.dc.html') && !files.some(([name]) => name === f)))
      fs.rmSync(path.join(projectDir, stale));
  for (const [file, html] of files) writeAtomic(path.join(projectDir, file), html);
  const index = path.join(outDir, 'project', 'canvas.json');
  const previous = fs.existsSync(index) ? readJson(index) : null;
  writeJson(index, {
    v: 3,
    createdOnFiles: previous?.createdOnFiles ?? { v: 1, at: new Date().toISOString() },
    title: previous?.title ?? `${path.basename(project.root)} UI`,
    launch: { view: 'canvas' },
    pages: [],
    boards,
    order,
    notes: {},
    designSystems: previous?.designSystems ?? [],
  });
  writeJson(path.join(outDir, 'uploads.json'), [...uploads.entries()].map(([key, file]) => ({ key, file: path.relative(outDir, file) })));
  writeDesignTokens(project, path.join(outDir, 'design-system', 'tokens.json'));

  console.log(`${files.length} artboards -> ${relative(path.join(outDir, 'project'))}`);
  console.log(blobs
    ? 'urls filled in: publish project/ to the canvas'
    : `${uploads.size} files to upload (UIKit/canvas/uploads.json), then rerun with --blobs <key-to-url.json>`);
}

const px = (v) => `${Math.round(v)}px`;
const rgba = (hex) => {
  const [r, g, b, a] = parseColor(hex);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Math.round(a * 1000) / 1000})`;
};
const token = (key) => `__UIKIT_ASSET_${key}__`;

async function bake(buffer, assetDir, uploads, ext = 'png') {
  const key = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  const file = path.join(assetDir, `${key}.${ext}`);
  if (!uploads.has(key)) {
    if (!fs.existsSync(file)) writeAtomic(file, buffer);
    uploads.set(key, file);
  }
  return key;
}

/** One artboard: every op absolutely positioned at its design-px rect. */
async function artboard(model, { assetDir, uploads, blobs, background }) {
  const url = (key) => (blobs ? blobs[key] : token(key));
  const rules = ['body{margin:0}'];
  const fonts = new Map();
  const elements = [];

  for (const [i, op] of model.ops.entries()) {
    const [x, y, w, h] = op.rect;
    if (w <= 0 || h <= 0) continue;
    const style = [`position: absolute`, `left: ${px(x)}`, `top: ${px(y)}`, `width: ${px(w)}`, `height: ${px(h)}`];
    if (op.alpha < 1) style.push(`opacity: ${op.alpha}`);
    if (op.clip) {
      const [cx, cy, cw, ch] = op.clip;
      const inset = [cy - y, x + w - (cx + cw), y + h - (cy + ch), cx - x].map((v) => Math.max(0, v));
      if (inset.some((v) => v > 0)) style.push(`clip-path: inset(${inset.map(px).join(' ')})`);
    }

    if (op.kind === 'image') {
      const img = op.image;
      const sliced = (img.type === 'Sliced' || img.type === 'Tiled') && img.slice.some((v) => v > 0);
      const special = img.type === 'Filled' && img.fillAmount < 0.999;
      if (special || (img.preserveAspect && (img.type === 'Simple' || img.type === 'Filled'))) {
        // Bake the final pixels when CSS cannot express the draw mode exactly.
        const raw = await drawImage(op, Math.round(w), Math.round(h));
        if (!raw) continue;
        const key = await bake(await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).png().toBuffer(), assetDir, uploads);
        elements.push(`<img src="${url(key)}" alt="" style="${style.join('; ')}">`);
        continue;
      }
      const source = await loadSource(img.file, img.crop, img.cropBottom);
      if (!source) continue;
      const tinted = img.tinted ? tint(source, img.tint) : source;
      const key = await bake(await sharp(tinted.data, { raw: { width: tinted.width, height: tinted.height, channels: 4 } }).png().toBuffer(), assetDir, uploads);
      if (sliced) {
        // 9-slice: border-image with the sprite's border in source px, drawn at the border size Unity uses.
        let [dl, db, dr, dt] = img.sliceUnits;
        if (dl + dr > w && dl + dr > 0) [dl, dr] = [(dl * w) / (dl + dr), (dr * w) / (dl + dr)];
        if (db + dt > h && db + dt > 0) [db, dt] = [(db * h) / (db + dt), (dt * h) / (db + dt)];
        // Whole pixels: fractional border widths make browsers draw seams between the 9 pieces.
        [dl, db, dr, dt] = [dl, db, dr, dt].map((v) => Math.round(v));
        const [sl, sb, sr, st] = img.slice.map((v) => Math.round(v));
        rules.push(`.u${i}{border-style:solid;border-width:${[dt, dr, db, dl].map(px).join(' ')};` +
          `border-image-source:url(${url(key)});border-image-slice:${st} ${sr} ${sb} ${sl}${img.fillCenter === false ? '' : ' fill'};` +
          `border-image-width:${[dt, dr, db, dl].map(px).join(' ')};border-image-repeat:stretch}`);
        elements.push(`<div class="u${i}" style="${[...style, 'box-sizing: border-box'].join('; ')}"></div>`);
      } else {
        elements.push(`<img src="${url(key)}" alt="" style="${style.join('; ')}">`);
      }
      continue;
    }

    // Text
    const t = op.text;
    let family = 'sans-serif';
    if (t.fontFile && fs.existsSync(t.fontFile)) {
      if (!fonts.has(t.fontFile)) {
        const ext = path.extname(t.fontFile).slice(1).toLowerCase();
        const key = await bake(fs.readFileSync(t.fontFile), assetDir, uploads, ext);
        const format = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[ext] ?? 'truetype';
        fonts.set(t.fontFile, `uikit-${fonts.size}`);
        rules.push(`@font-face{font-family:"${fonts.get(t.fontFile)}";src:url(${url(key)}) format("${format}")}`);
      }
      family = fonts.get(t.fontFile);
    }
    const h0 = /Left|Justified|Flush/.test(t.alignment) && !/Center/.test(t.alignment) ? 'flex-start' : /Right/.test(t.alignment) ? 'flex-end' : 'center';
    const v0 = /^Top|^Upper/.test(t.alignment) ? 'flex-start' : /^Bottom|^Lower/.test(t.alignment) ? 'flex-end' : 'center';
    style.push('display: flex', `align-items: ${v0}`, `justify-content: ${h0}`,
      `text-align: ${h0 === 'flex-start' ? 'left' : h0 === 'flex-end' ? 'right' : 'center'}`,
      `font-family: '${family}', sans-serif`, `font-size: ${px(t.size)}`, `line-height: 1.2`, `color: ${rgba(t.color)}`,
      `white-space: ${t.wrap ? 'pre-wrap' : 'pre'}`);
    if (t.bold) style.push('font-weight: 700');
    if (t.italic) style.push('font-style: italic');
    if (t.upper) style.push('text-transform: uppercase');
    elements.push(`<div style="${style.join('; ')}">${escapeXml(t.content).replace(/\{\{/g, '&#123;&#123;')}</div>`);
  }

  const bg = background && background !== '#000000' ? rgba(background.length === 7 ? `${background}FF` : background) : 'transparent';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeXml(model.surface)}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
${rules.join('\n')}
</style>
</helmet>
<div style="position: relative; width: ${model.width}px; height: ${model.height}px; overflow: hidden; background: ${bg}">
${elements.join('\n')}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${model.width},"height":${model.height}}}'>
class Component extends DCLogic {
renderVals() {
return {};
}
}
</script>
</body>
</html>
`;
}

/** theme.json -> Design System tokens.json (list format the Design System type reads). */
function writeDesignTokens(project, file) {
  const theme = project.theme;
  const name = (n) => n.replace(/[^A-Za-z0-9_.-]/g, '-');
  const lengths = (theme.metrics ?? []).filter((m) => typeof m.value === 'number');
  writeJson(file, {
    name: theme.name ?? path.basename(project.root),
    version: 1,
    color: {
      themes: [{ id: 'light', name: 'Light' }],
      tokens: (theme.colors ?? []).map((c) => ({ name: name(c.name), value: { light: c.value }, usage: `UIKit token "${c.name}".` })),
    },
    radius: { tokens: lengths.filter((m) => /radius/i.test(m.name)).map((m) => ({ name: name(m.name), value: `${m.value}px`, usage: `UIKit metric "${m.name}".` })) },
    spacing: { tokens: lengths.filter((m) => /space|gap|pad/i.test(m.name)).map((m) => ({ name: name(m.name), value: `${m.value}px`, usage: `UIKit metric "${m.name}".` })) },
  });
}
