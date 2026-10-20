import fs from 'node:fs';
import path from 'node:path';
import { fail, readJson } from './util.mjs';

/**
 * Render model of one surface: the draw operations Unity would issue, in hierarchy order.
 * Built from the baseline inventory, optionally with the reskin map applied ("after").
 * The preview (PNG) and the design canvas (.dc.html) both draw from this, so they match each other
 * and the real hierarchy.
 */

export const inventoryPath = (project, surface) => path.join(project.dir, 'inventory', `${surface}.json`);
export const reskinPath = (project, surface) => path.join(project.dir, 'reskin', `${surface}.json`);

export function loadInventory(project, surface) {
  const file = inventoryPath(project, surface);
  if (!fs.existsSync(file)) fail(`no inventory for "${surface}" (${file}). In Unity: Tools/UI Kit/Dump Inventory`);
  return readJson(file);
}

export function listSurfaces(project) {
  const file = path.join(project.dir, 'surfaces.json');
  if (!fs.existsSync(file)) return [];
  return (readJson(file).surfaces ?? []).map((s) => s.name);
}

/** #RRGGBB[AA] -> [r, g, b, a] in 0..1 */
export function parseColor(hex) {
  const h = (hex ?? '#FFFFFFFF').replace('#', '');
  const v = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [v(0), v(2), v(4), h.length >= 8 ? v(6) : 1];
}

const isWhite = (c) => c[0] >= 0.999 && c[1] >= 0.999 && c[2] >= 0.999 && c[3] >= 0.999;

/** Pixel size of a PNG from its header (no decoding). */
export function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(24);
  fs.readSync(fd, head, 0, 24, 0);
  fs.closeSync(fd);
  return head.toString('ascii', 12, 16) === 'IHDR' ? [head.readUInt32BE(16), head.readUInt32BE(20)] : null;
}

const NUM = '(-?[\\d.eE+-]+)';
const vec4 = (key, text) => text.match(new RegExp(`${key}:\\s*\\{x:\\s*${NUM},\\s*y:\\s*${NUM},\\s*z:\\s*${NUM},\\s*w:\\s*${NUM}\\}`))?.slice(1, 5).map(Number);

/**
 * Border, pixels-per-unit and (for a named sprite of a multi-sprite sheet) its rect, from the texture's .meta.
 * rect is Unity's: origin bottom-left, in source pixels.
 */
function readSpriteMeta(file, spriteName = null) {
  const meta = `${file}.meta`;
  if (!fs.existsSync(meta)) return { border: [0, 0, 0, 0], ppu: 100, rectBottom: null };
  const text = fs.readFileSync(meta, 'utf8');
  const ppu = Number(text.match(/spritePixelsToUnits:\s*([\d.]+)/)?.[1] ?? 100);
  if (spriteName) {
    // spriteSheet.sprites entries: "- serializedVersion: 2\n      name: X\n      rect: ... border: {...}"
    const start = text.search(new RegExp(`\\n\\s*name: ${spriteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n`));
    if (start < 0) throw new Error(`sprite "${spriteName}" not found in ${path.basename(meta)}`);
    const block = text.slice(start, start + 1200);
    const x = Number(block.match(/\bx:\s*([\d.]+)/)?.[1]);
    const y = Number(block.match(/\by:\s*([\d.]+)/)?.[1]);
    const w = Number(block.match(/width:\s*([\d.]+)/)?.[1]);
    const h = Number(block.match(/height:\s*([\d.]+)/)?.[1]);
    return { border: vec4('border', block) ?? [0, 0, 0, 0], ppu, rectBottom: [x, y, w, h] };
  }
  return { border: vec4('spriteBorder', text) ?? [0, 0, 0, 0], ppu, rectBottom: null };
}

const intersect = (a, b) => {
  const [l, t] = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const [r, btm] = [Math.min(a[0] + a[2], b[0] + b[2]), Math.min(a[1] + a[3], b[1] + b[3])];
  return [l, t, Math.max(0, r - l), Math.max(0, btm - t)];
};

export function buildModel(project, inventory, { reskin = null } = {}) {
  const theme = project.theme;
  const colorTokens = new Map((theme.colors ?? []).map((c) => [c.name, c.value]));
  const resolveColor = (value) => {
    if (!value) return null;
    if (value.startsWith('#')) return value.length === 7 ? `${value}FF` : value;
    const hex = colorTokens.get(value);
    if (!hex) throw new Error(`unknown color token "${value}"`);
    return hex.length === 7 ? `${hex}FF` : hex;
  };
  const generated = project.resolve(project.config.generatedDir);
  const importFile = path.join(generated, '_uikit_import.json');
  const imports = new Map((fs.existsSync(importFile) ? readJson(importFile).sprites : []).map((s) => [s.file, s]));
  const refPpu = inventory.referencePixelsPerUnit || 100;
  const fontFiles = new Map(inventory.nodes.filter((n) => n.font && n.fontFile).map((n) => [n.font, n.fontFile]));

  // Resolve a sprite value from the reskin map to a source image + border, the same way UIReskin loads it.
  const resolveSprite = (value) => {
    if (value.includes('/')) {
      const [assetPath, spriteName] = value.split('#');
      const file = project.resolve(assetPath);
      if (!fs.existsSync(file)) throw new Error(`sprite file ${assetPath} not found`);
      const { border, ppu, rectBottom } = readSpriteMeta(file, spriteName || null);
      return { file, crop: null, cropBottom: rectBottom, slice: border, ppu };
    }
    const file = path.join(generated, `${value}.png`);
    if (!fs.existsSync(file)) throw new Error(`generated sprite "${value}" not found (run uikit gen)`);
    const entry = imports.get(`${value}.png`);
    return { file, crop: null, slice: entry?.border ?? [0, 0, 0, 0], ppu: entry?.pixelsPerUnit ?? 100 };
  };

  const changes = new Map((reskin?.nodes ?? []).map((c) => [c.path ?? '', c]));
  const warnings = [];
  for (const p of changes.keys()) if (!inventory.nodes.some((n) => n.path === p)) warnings.push(`reskin path not in inventory: "${p}"`);

  // Pass 1: geometry and visibility per node after the reskin map.
  const nodes = inventory.nodes.map((n) => ({ ...n }));
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : p === '' ? null : '');
  const moved = new Set(); // nodes whose rect changed; descendants that stretch with them are approximate
  for (const node of nodes) {
    const change = changes.get(node.path);
    if (!change) continue;
    if (change.active === 'false') node.activeSelf = false;
    if (change.active === 'true') node.activeSelf = true;
    if (change.size?.length === 2) {
      if (node.fixedWidth) {
        node.x += (node.width - change.size[0]) * node.pivotX;
        node.width = change.size[0];
      }
      if (node.fixedHeight) {
        node.y += (node.height - change.size[1]) * (1 - node.pivotY);
        node.height = change.size[1];
      }
      moved.add(node.path);
    }
    if (change.position?.length === 2) {
      // position is anchoredPosition, in the parent's local units: convert the move to design px.
      if (node.fixedWidth) node.x += (change.position[0] - node.anchoredX) * (node.parentScaleX || 1);
      if (node.fixedHeight) node.y -= (change.position[1] - node.anchoredY) * (node.parentScaleY || 1);
      moved.add(node.path);
    }
  }
  // active = activeSelf && parent active, top-down (nodes are in hierarchy order). The root keeps the
  // inventory's value; older inventories without activeSelf fall back to activeInHierarchy.
  for (const node of nodes) {
    const self = node.activeSelf ?? node.active;
    const parent = byPath.get(parentOf(node.path));
    node.active = parent ? self && parent.active : self;
  }

  // Pass 2: draw ops.
  const ops = [];
  const decorationsByParent = new Map();
  for (const deco of reskin?.add ?? []) {
    if (!decorationsByParent.has(deco.parent)) decorationsByParent.set(deco.parent, []);
    decorationsByParent.get(deco.parent).push(deco);
  }
  const lastDescendantIndex = new Map();

  nodes.forEach((node) => {
    const change = changes.get(node.path);
    // Under a resized/moved node, stretched children would move too; the model keeps their old rects.
    const approximate = [...moved].some((m) => (m === '' ? node.path !== '' : node.path.startsWith(`${m}/`)));
    if (!node.active || node.alpha <= 0.001 || node.width <= 0 || node.height <= 0) return;
    const base = {
      path: node.path, rect: [node.x, node.y, node.width, node.height], clip: node.clip?.length === 4 ? node.clip : null, alpha: node.alpha, approximate,
      effect: node.material || null, // drawn by a custom shader: its look cannot be reproduced here
    };

    if (node.drawsImage && !node.maskGraphicHidden) {
      let image = null;
      const multiplier = change?.ppuMultiplier > 0 ? change.ppuMultiplier : node.pixelsPerUnitMultiplier || 1;
      if (change?.sprite) {
        const s = resolveSprite(change.sprite);
        // Unity: px / (spritePPU / refPPU * multiplier), in local units; then the node's scale to design px.
        const k = refPpu / s.ppu / multiplier;
        const [sx, sy] = [node.scaleX || 1, node.scaleY || 1];
        const units = [s.slice[0] * k * sx, s.slice[1] * k * sy, s.slice[2] * k * sx, s.slice[3] * k * sy];
        const px = s.cropBottom ? s.cropBottom.slice(2, 4) : pngSize(s.file) ?? [0, 0];
        let type = node.imageType;
        if (!change.type && s.slice.some((v) => v > 0) && type === 'Simple') type = 'Sliced';
        image = {
          file: s.file, crop: null, cropBottom: s.cropBottom, slice: s.slice, sliceUnits: units, type, sprite: change.sprite,
          sourcePx: px, spriteUnits: [px[0] * k * sx, px[1] * k * sy],
        };
      } else if (node.spritePath) {
        // A changed multiplier rescales the borders and the native size the inventory measured.
        const f = (node.pixelsPerUnitMultiplier || 1) / multiplier;
        image = {
          file: project.resolve(node.spritePath), crop: node.spriteRect, slice: node.slice, type: node.imageType, sprite: node.sprite,
          sliceUnits: node.sliceUnits.map((v) => v * f),
          sourcePx: node.spriteRect.slice(2, 4),
          spriteUnits: node.spriteUnits ? node.spriteUnits.map((v) => v * f) : null,
        };
      } else if (node.texturePath) {
        image = { file: project.resolve(node.texturePath), crop: null, slice: [0, 0, 0, 0], sliceUnits: [0, 0, 0, 0], type: 'Simple' };
      } else if (node.components.includes('RawImage')) {
        image = null; // runtime texture: nothing known to draw
      } else {
        image = { file: null, crop: null, slice: [0, 0, 0, 0], sliceUnits: [0, 0, 0, 0], type: 'Simple' }; // Unity draws a white quad
      }
      if (image) {
        if (change?.type) image.type = change.type;
        const tint = resolveColor(change?.color) ?? node.color;
        ops.push({
          ...base,
          kind: 'image',
          image: {
            ...image,
            preserveAspect: change?.preserveAspect ? change.preserveAspect === 'true' : node.preserveAspect,
            fillCenter: node.fillCenter,
            fillMethod: node.fillMethod,
            fillAmount: node.fillAmount,
            fillOrigin: node.fillOrigin,
            tint,
            tinted: !isWhite(parseColor(tint)),
            pivot: [node.pivotX ?? 0.5, node.pivotY ?? 0.5],
            ppuMultiplier: multiplier,
          },
        });
      }
    }

    if (node.drawsText && node.text) {
      const style = change?.text ?? {};
      const font = style.font || node.font;
      ops.push({
        ...base,
        kind: 'text',
        text: {
          content: node.text,
          font,
          fontFile: (style.font ? fontFiles.get(style.font) : node.fontFile) ? project.resolve(style.font ? fontFiles.get(style.font) : node.fontFile) : null,
          family: style.font ? style.font : node.fontFamily || node.font,
          // TMP size is in local units; the node's scale turns it into design px.
          size: (style.size > 0 ? style.size : node.fontSize) * (node.scaleY || 1),
          color: resolveColor(style.color) ?? node.textColor ?? '#000000FF',
          alignment: node.alignment,
          wrap: node.wrap,
          bold: /Bold/.test(node.fontStyle ?? ''),
          italic: /Italic/.test(node.fontStyle ?? ''),
          upper: /UpperCase/.test(node.fontStyle ?? ''),
        },
      });
    }
    lastDescendantIndex.set(node.path, ops.length);
    for (let p = parentOf(node.path); p !== null; p = parentOf(p)) lastDescendantIndex.set(p, ops.length);
  });

  // Decorations are appended as the parent's last child: drawn after its whole subtree.
  const inserts = [];
  for (const [parentPath, decos] of decorationsByParent) {
    const parent = byPath.get(parentPath);
    if (!parent) {
      warnings.push(`decoration parent not in inventory: "${parentPath}"`);
      continue;
    }
    if (!parent.active) continue;
    // A Mask/RectMask2D on the parent clips its new child to the parent's rect too.
    let clip = parent.clip?.length === 4 ? parent.clip : null;
    if (parent.masks) {
      const own = [parent.x, parent.y, parent.width, parent.height];
      clip = clip ? intersect(clip, own) : own;
    }
    const parentApproximate = [...moved].some((m) => (m === '' ? true : parentPath === m || parentPath.startsWith(`${m}/`)));
    for (const deco of decos) {
      // Already applied: the inventory holds the real node (drawn with its own type and tiling), so drawing the
      // map entry again would double it.
      if (byPath.has(`${parentPath ? `${parentPath}/` : ''}UIKit_${deco.name}`)) continue;
      const s = deco.sprite ? resolveSprite(deco.sprite) : { file: null, slice: [0, 0, 0, 0], ppu: refPpu };
      const tint = resolveColor(deco.color) ?? '#FFFFFFFF';
      const k = refPpu / s.ppu;
      inserts.push({
        at: lastDescendantIndex.get(parentPath) ?? ops.length,
        op: {
          path: `${parentPath ? `${parentPath}/` : ''}UIKit_${deco.name}`,
          rect: [parent.x + deco.rect[0], parent.y + deco.rect[1], deco.rect[2], deco.rect[3]],
          clip,
          alpha: parent.alpha,
          approximate: parentApproximate,
          kind: 'image',
          decoration: true,
          image: {
            // The decoration's own scale is 1, so its design scale is the parent's.
            file: s.file, crop: null, cropBottom: s.cropBottom, slice: s.slice,
            sliceUnits: [s.slice[0] * k * (parent.scaleX || 1), s.slice[1] * k * (parent.scaleY || 1), s.slice[2] * k * (parent.scaleX || 1), s.slice[3] * k * (parent.scaleY || 1)],
            type: deco.type || (s.slice.some((v) => v > 0) ? 'Sliced' : 'Simple'), preserveAspect: false, fillCenter: true,
            tint, tinted: !isWhite(parseColor(tint)), sprite: deco.sprite, pivot: [0, 1],
          },
        },
      });
    }
  }
  inserts.sort((a, b) => b.at - a.at).forEach(({ at, op }) => ops.splice(at, 0, op));

  return {
    expectedActive: new Map(nodes.map((n) => [n.path, n.active])),
    surface: inventory.surface,
    width: inventory.width,
    height: inventory.height,
    referenceResolution: inventory.referenceResolution,
    background: project.config.background,
    ops,
    warnings,
  };
}
