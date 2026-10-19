import fs from 'node:fs';
import path from 'node:path';

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

export function fail(message) {
  console.error(`uikit: ${message}`);
  process.exit(1);
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function writeJson(file, value) {
  return writeIfChanged(file, JSON.stringify(value, null, 2) + '\n');
}

/** Writes only when the bytes differ, so Unity does not reimport untouched files. Returns true when written. */
export function writeIfChanged(file, content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (fs.existsSync(file) && fs.readFileSync(file).equals(buffer)) return false;
  writeAtomic(file, buffer);
  return true;
}

/** Write to a temp file and rename, so a parallel reader never sees a half-written file. */
export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge for plain objects; arrays and scalars from `over` replace `base`. */
export function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = merge(base[key], value);
  return out;
}

export const escapeXml = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export const relative = (file) => path.relative(process.cwd(), file) || '.';
