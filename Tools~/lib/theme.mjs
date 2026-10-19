import { merge } from './util.mjs';

/**
 * Token lookup over theme.json. Colors accept a token name or a literal (#hex, none);
 * metrics accept a number or a token name; styles support "extends".
 */
export function createTokens(theme) {
  const colors = new Map((theme.colors ?? []).map((c) => [c.name, c.value]));
  const metrics = new Map((theme.metrics ?? []).map((m) => [m.name, m.value]));
  const styles = theme.styles ?? {};

  const tokens = {
    color(value) {
      if (value == null) return null;
      if (value.startsWith('#') || value === 'none') return value;
      const color = colors.get(value);
      if (color === undefined) throw new Error(`unknown color token "${value}"`);
      return color;
    },
    metric(value, fallback = 0) {
      if (value == null) return fallback;
      if (typeof value === 'number') return value;
      const metric = metrics.get(value);
      if (metric === undefined) throw new Error(`unknown metric token "${value}"`);
      return metric;
    },
    style(ref) {
      if (typeof ref === 'object') return ref;
      const style = styles[ref];
      if (!style) throw new Error(`unknown style "${ref}"`);
      const { extends: parent, ...own } = style;
      return parent ? merge(tokens.style(parent), own) : own;
    },
  };
  return tokens;
}
