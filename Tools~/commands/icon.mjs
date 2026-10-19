import fs from 'node:fs';
import path from 'node:path';
import { loadProject } from '../lib/project.mjs';
import { withLock } from '../lib/lock.mjs';
import { fail, relative, writeAtomic } from '../lib/util.mjs';

const SOURCES = {
  'game-icons': {
    urls: (name) => [
      `https://raw.githubusercontent.com/game-icons/icons/master/${name}.svg`,
      `https://cdn.jsdelivr.net/gh/game-icons/icons@master/${name}.svg`,
    ],
    credit: (name) => `${name.split('/').pop()} by ${name.split('/')[0]}, game-icons.net, CC BY 3.0`,
    example: 'game-icons:lorc/crystal-ball',
  },
  lucide: {
    urls: (name) => [
      `https://cdn.jsdelivr.net/npm/lucide-static/icons/${name}.svg`,
      `https://unpkg.com/lucide-static/icons/${name}.svg`,
    ],
    credit: (name) => `${name}, Lucide (lucide.dev), ISC License`,
    example: 'lucide:settings',
  },
};

/**
 * uikit icon add <source:name> [--as file-name]
 * Downloads an icon into UIKit/icons/ and records its license in UIKit/icons/CREDITS.md.
 * game-icons.net (CC BY 3.0) needs the credit line shipped with the game.
 */
export default async function icon(args) {
  const [, action, ref] = args._;
  const usage = `usage: uikit icon add <source:name>  e.g. ${Object.values(SOURCES).map((s) => s.example).join(', ')}`;
  if (action !== 'add' || !ref?.includes(':')) fail(usage);
  const [sourceName, name] = ref.split(/:(.*)/s);
  const source = SOURCES[sourceName] ?? fail(`unknown source "${sourceName}". ${usage}`);

  const project = loadProject(args.project);
  const svg = await download(source.urls(name));

  const dir = path.join(project.dir, 'icons');
  const file = path.join(dir, `${args.as ?? name.split('/').pop()}.svg`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, svg);

  // Parallel art agents all add credit lines: read-modify-write under a lock so none is lost.
  const credits = path.join(dir, 'CREDITS.md');
  const line = `- ${path.basename(file)}: ${source.credit(name)}\n`;
  await withLock(project, 'icons', () => {
    const current = fs.existsSync(credits) ? fs.readFileSync(credits, 'utf8') : '# Icon credits\n\n';
    if (!current.includes(line)) writeAtomic(credits, current + line);
  });

  console.log(`${relative(file)}\nuse in assets.json: { "id": "icon_${path.basename(file, '.svg').replace(/-/g, '_')}", "type": "icon", "src": "icons/${path.basename(file)}", "size": [96, 96], "style": "icon" }`);
}

/** First URL that answers with an SVG; mirrors cover a blocked or slow CDN. */
async function download(urls) {
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        errors.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      const text = await response.text();
      if (text.includes('<svg')) return text;
      errors.push(`${url}: not an SVG`);
    } catch (error) {
      errors.push(`${url}: ${error.cause?.code ?? error.message}`);
    }
  }
  fail(`download failed:\n  ${errors.join('\n  ')}`);
}
