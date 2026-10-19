import { merge } from './util.mjs';

// Builders return { svg, width, height, border } where border is the 9-slice
// border in design units, ordered [left, bottom, right, top] like Unity's spriteBorder.

const round = (n) => Math.round(n * 100) / 100;

/** "#RRGGBBAA" becomes a color plus an opacity, since SVG renderers handle the split form reliably. */
function paint(attr, hex) {
  if (/^#[0-9a-f]{8}$/i.test(hex)) {
    const opacity = round(parseInt(hex.slice(7), 16) / 255);
    return `${attr}="${hex.slice(0, 7)}" ${attr}-opacity="${opacity}"`;
  }
  return `${attr}="${hex}"`;
}

function stops(colors) {
  const step = colors.length > 1 ? 1 / (colors.length - 1) : 0;
  return colors.map((c, i) => {
    const [color, opacity] = /^#[0-9a-f]{8}$/i.test(c) ? [c.slice(0, 7), parseInt(c.slice(7), 16) / 255] : [c, 1];
    return `<stop offset="${round(i * step)}" stop-color="${color}"${opacity < 1 ? ` stop-opacity="${round(opacity)}"` : ''}/>`;
  }).join('');
}

/** A fill that is either one color or a top-to-bottom gradient. Returns [attribute, defs]. */
function fill(tokens, value, id, gradientAttrs = ' x1="0" y1="0" x2="0" y2="1"') {
  const list = Array.isArray(value) ? value.map((v) => tokens.color(v)) : [tokens.color(value)];
  if (list.length === 1) return [paint('fill', list[0]), ''];
  return [`fill="url(#${id})"`, `<linearGradient id="${id}"${gradientAttrs}>${stops(list)}</linearGradient>`];
}

const rect = (x, y, w, h, r, attrs) =>
  `<rect x="${round(x)}" y="${round(y)}" width="${round(Math.max(0, w))}" height="${round(Math.max(0, h))}" rx="${round(Math.max(0, r))}" ${attrs}/>`;

function shadowOf(tokens, s) {
  if (!s) return null;
  return {
    dx: tokens.metric(s.dx, 0),
    dy: tokens.metric(s.dy, 0),
    blur: tokens.metric(s.blur, 0),
    color: tokens.color(s.color ?? '#00000066'),
  };
}

function shadowPad(shadow) {
  if (!shadow) return { l: 0, r: 0, t: 0, b: 0 };
  const spread = Math.ceil(shadow.blur * 2);
  return {
    l: Math.max(0, spread - shadow.dx),
    r: Math.max(0, spread + shadow.dx),
    t: Math.max(0, spread - shadow.dy),
    b: Math.max(0, spread + shadow.dy),
  };
}

const blurFilter = (id, blur) =>
  `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${round(blur)}"/></filter>`;

const document = (width, height, defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<defs>${defs}</defs>${body}</svg>\n`;

/** Default look for a state that the style does not override. */
function stateFilter(state, id) {
  if (state === 'disabled')
    return [`<filter id="${id}-state"><feColorMatrix type="saturate" values="0.1"/></filter>`, ` filter="url(#${id}-state)" opacity="0.85"`];
  if (state === 'pressed')
    return [`<filter id="${id}-state"><feComponentTransfer><feFuncR type="linear" slope="0.88"/><feFuncG type="linear" slope="0.88"/><feFuncB type="linear" slope="0.88"/></feComponentTransfer></filter>`, ` filter="url(#${id}-state)"`];
  return ['', ''];
}

/**
 * Panel/button: shadow, outline, bevel, gradient face, gloss highlight, inner stroke, noise.
 * Pressed buttons with a bevel sink into it instead of darkening.
 */
export function buildBox({ tokens, style, width, height, state = 'normal', id }) {
  const override = style.states?.[state];
  const s = override ? merge(style, override) : style;

  const stroke = s.stroke ? tokens.color(s.stroke) : null;
  const sw = stroke ? tokens.metric(s.strokeWidth, 4) : 0;
  const bevelSize = s.bevel ? tokens.metric(s.bevel.size, 8) : 0;
  const shadow = shadowOf(tokens, s.shadow);
  const pad = shadowPad(shadow);
  const W = Math.ceil(pad.l + width + pad.r);
  const H = Math.ceil(pad.t + height + pad.b);
  const radius = s.radius === 'full' ? Math.min(width, height) / 2 : tokens.metric(s.radius, 0);

  let x = pad.l, y = pad.t, h = height, bevel = bevelSize;
  let [defs, groupAttrs] = ['', ''];
  if (state !== 'normal' && !override) {
    if (state === 'pressed' && bevel > 0) {
      const push = bevel * 0.7;
      y += push;
      h -= push;
      bevel -= push;
    } else [defs, groupAttrs] = stateFilter(state, id);
  }

  const body = [];
  if (shadow) {
    if (shadow.blur) defs += blurFilter(`${id}-shadow`, shadow.blur);
    body.push(rect(x + shadow.dx, y + shadow.dy, width, h, radius,
      paint('fill', shadow.color) + (shadow.blur ? ` filter="url(#${id}-shadow)"` : '')));
  }
  // Outline as a ring (not a filled base) so a translucent face does not show it through.
  // The ring reaches 1px under the face to avoid an anti-aliasing seam.
  if (stroke) {
    const ring = sw + 1;
    body.push(rect(x + ring / 2, y + ring / 2, width - ring, h - ring, Math.max(0, radius - ring / 2),
      `fill="none" ${paint('stroke', stroke)} stroke-width="${ring}"`));
  }

  const ix = x + sw, iy = y + sw, iw = width - 2 * sw, ir = Math.max(0, radius - sw);
  const ih = h - 2 * sw;
  if (bevel > 0) body.push(rect(ix, iy, iw, ih, ir, paint('fill', tokens.color(s.bevel.color))));

  const faceH = ih - bevel;
  const [faceFill, faceDefs] = fill(tokens, s.fill ?? '#ffffff', `${id}-face`);
  defs += faceDefs;
  body.push(rect(ix, iy, iw, faceH, ir, faceFill));

  const needsClip = s.highlight || s.noise;
  if (needsClip) defs += `<clipPath id="${id}-clip">${rect(ix, iy, iw, faceH, ir, '')}</clipPath>`;

  if (s.highlight) {
    const opacity = s.highlight.opacity ?? 0.3;
    const inset = tokens.metric(s.highlight.inset, Math.max(2, iw * 0.04));
    const hh = faceH * (s.highlight.height ?? 0.45);
    body.push(`<g clip-path="url(#${id}-clip)">` +
      rect(ix + inset, iy + inset * 0.5, iw - inset * 2, hh, Math.max(0, ir - inset), `fill="${s.highlight.color ?? '#ffffff'}" fill-opacity="${opacity}"`) +
      '</g>');
  }
  if (s.innerStroke) {
    const w = tokens.metric(s.innerStroke.width, 2);
    body.push(rect(ix + w / 2, iy + w / 2, iw - w, faceH - w, Math.max(0, ir - w / 2),
      `fill="none" ${paint('stroke', tokens.color(s.innerStroke.color))} stroke-width="${w}"`));
  }
  if (s.noise) {
    defs += `<filter id="${id}-noise" x="0" y="0" width="100%" height="100%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="${s.noise.frequency ?? 0.9}" numOctaves="2" seed="${s.noise.seed ?? 3}" stitchTiles="stitch"/>` +
      '<feColorMatrix type="saturate" values="0"/></filter>';
    body.push(`<g clip-path="url(#${id}-clip)" opacity="${s.noise.opacity ?? 0.08}">` +
      rect(ix, iy, iw, faceH, 0, `filter="url(#${id}-noise)"`) + '</g>');
  }

  // Same border for every state, so swapping sprites on press never moves the 9-slice grid.
  const corner = Math.max(radius, sw) + 1;
  let border = [pad.l + corner, pad.b + corner + bevelSize, pad.r + corner, pad.t + corner + bevelSize];
  if (shadow) {
    const reach = radius + Math.ceil(shadow.blur * 2) + 1;
    border = [
      Math.max(border[0], pad.l + shadow.dx + reach),
      Math.max(border[1], pad.b - shadow.dy + reach),
      Math.max(border[2], pad.r - shadow.dx + reach),
      Math.max(border[3], pad.t + shadow.dy + reach),
    ];
  }
  const wanted = border.map(Math.ceil); // what the corners need, before giving up on an axis
  if (border[0] + border[2] >= W) border = [0, border[1], 0, border[3]];
  if (border[1] + border[3] >= H) border = [border[0], 0, border[2], 0];

  return {
    svg: document(W, H, defs, `<g${groupAttrs}>${body.join('')}</g>`),
    width: W,
    height: H,
    border: border.map(Math.ceil),
    wanted,
  };
}

const ROOT_PAINT_ATTRS = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];

/** Reads viewBox, inner markup and root paint attributes from an SVG file. */
export function parseSvg(text) {
  const open = text.match(/<svg\b[^>]*>/i);
  if (!open) throw new Error('not an SVG document');
  const tag = open[0];
  const attr = (name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  let viewBox = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!viewBox) viewBox = [0, 0, parseFloat(attr('width')), parseFloat(attr('height'))];
  if (viewBox.some(Number.isNaN)) throw new Error('SVG has neither viewBox nor width/height');
  const inner = text.slice(open.index + tag.length, text.lastIndexOf('</svg>'));
  const rootAttrs = Object.fromEntries(ROOT_PAINT_ATTRS.map((n) => [n, attr(n)]).filter(([, v]) => v != null));
  return { viewBox, inner, rootAttrs };
}

/**
 * Icon from any SVG (game-icons.net, Lucide, Codex output): strips its colors,
 * then redraws it as shadow + outline + gradient fill in theme colors.
 */
export function buildIcon({ tokens, style, width, height, source, id }) {
  const { viewBox: [vx, vy, vw, vh], inner: raw, rootAttrs } = parseSvg(source);
  const inner = raw
    .replace(/<path\s+d="M0 0h(\d+)v\1H0z"\s*\/>/g, '') // game-icons.net background square
    .replace(/\sfill="(?!none)[^"]*"/g, '')
    .replace(/fill:\s*(?!none)[^;"]+;?/g, '');
  const strokeIcon = rootAttrs.fill === 'none';

  const outline = style.stroke ? tokens.color(style.stroke) : null;
  const sw = outline ? tokens.metric(style.strokeWidth, 4) : 0;
  const shadow = shadowOf(tokens, style.shadow);
  const pad = shadowPad(shadow);
  const W = Math.ceil(pad.l + width + pad.r);
  const H = Math.ceil(pad.t + height + pad.b);

  const dw = width - 2 * sw, dh = height - 2 * sw;
  const unit = Math.max(vw / dw, vh / dh); // design px to viewBox units
  const baseStroke = parseFloat(rootAttrs['stroke-width'] ?? '0') || 0;
  const base = Object.entries(rootAttrs).map(([k, v]) => `${k}="${v}"`).join(' ');

  const layer = (dx, dy, attrs) =>
    `<svg x="${round(pad.l + sw + dx)}" y="${round(pad.t + sw + dy)}" width="${round(dw)}" height="${round(dh)}" ` +
    `viewBox="${vx} ${vy} ${vw} ${vh}" overflow="visible"><g ${base}><g ${attrs}>${inner}</g></g></svg>`;

  const silhouette = (color) => {
    const c = tokens.color(color);
    const hex = c.slice(0, 7);
    const widen = outline ? 2 * sw * unit : 0;
    return strokeIcon
      ? `color="${hex}" stroke="${hex}" stroke-width="${round(baseStroke + widen)}"`
      : `color="${hex}" fill="${hex}"` + (widen ? ` stroke="${hex}" stroke-width="${round(widen)}" stroke-linejoin="round"` : '');
  };

  let defs = '';
  const body = [];
  if (shadow) {
    if (shadow.blur) defs += blurFilter(`${id}-shadow`, shadow.blur);
    const opacity = shadow.color.length === 9 ? round(parseInt(shadow.color.slice(7), 16) / 255) : 1;
    body.push(`<g opacity="${opacity}"${shadow.blur ? ` filter="url(#${id}-shadow)"` : ''}>` +
      layer(shadow.dx, shadow.dy, silhouette(shadow.color)) + '</g>');
  }
  if (outline) body.push(layer(0, 0, silhouette(style.stroke)));

  const fills = Array.isArray(style.fill) ? style.fill : [style.fill ?? '#ffffff'];
  if (strokeIcon) {
    const top = tokens.color(fills[0]).slice(0, 7);
    body.push(layer(0, 0, `color="${top}" stroke="${top}"`));
  } else {
    const [faceFill, faceDefs] = fill(tokens, fills.length > 1 ? fills : fills[0], `${id}-face`,
      ` gradientUnits="userSpaceOnUse" x1="0" y1="${vy}" x2="0" y2="${vy + vh}"`);
    defs += faceDefs;
    body.push(layer(0, 0, faceFill));
  }

  return { svg: document(W, H, defs, body.join('')), width: W, height: H, border: [0, 0, 0, 0] };
}

/** Custom art authored as SVG (for example by Codex): rendered as is, scaled to the asset size. */
export function buildRaw({ width, height, source }) {
  const { viewBox: [vx, vy, vw, vh], inner } = parseSvg(source);
  const outer = source.match(/<svg\b[^>]*>/i)[0];
  const xmlns = /xmlns:xlink=/.test(outer) ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"${xmlns} width="${width}" height="${height}" viewBox="${vx} ${vy} ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">${inner}</svg>\n`;
  return { svg, width, height, border: [0, 0, 0, 0] };
}
