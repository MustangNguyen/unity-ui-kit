import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, readJson, writeJson } from '../lib/util.mjs';

const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kitRoot = path.resolve(toolsDir, '..');
const templates = path.join(toolsDir, 'templates');
const CLAUDE_MARKER = '<!-- uikit -->';

/**
 * uikit init <unity-project> [--package <manifest value>]
 * Adds the package, scaffolds UIKit/ with example files, a ./UIKit/uikit wrapper,
 * .gitignore entries and a CLAUDE.md section. Never overwrites existing files.
 */
export default async function init(args) {
  const target = path.resolve(args._[1] ?? args.project);
  const manifestPath = path.join(target, 'Packages', 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail(`${target} is not a Unity project (no Packages/manifest.json)`);

  const manifest = readJson(manifestPath);
  manifest.dependencies['com.mustang.ui-kit'] = args.package ?? `file:${kitRoot}`;
  writeJson(manifestPath, manifest);
  log('Packages/manifest.json', 'package added');

  const uikit = path.join(target, 'UIKit');
  copyTree(path.join(templates, 'UIKit'), uikit, target);

  const wrapper = path.join(uikit, 'uikit');
  if (!fs.existsSync(wrapper)) {
    fs.writeFileSync(wrapper,
      '#!/usr/bin/env bash\n' +
      '# Runs the UI Kit CLI for this project. Usage: UIKit/uikit <command> [...]\n' +
      `exec node "${path.join(toolsDir, 'uikit.mjs')}" "$@" --project "$(cd "$(dirname "$0")/.." && pwd)"\n`,
      { mode: 0o755 });
    log('UIKit/uikit', 'created');
  }

  appendOnce(path.join(target, '.gitignore'), 'UIKit/captures/', '\n# UI Kit outputs\nUIKit/captures/\nUIKit/reports/\n');
  appendOnce(path.join(target, 'CLAUDE.md'), CLAUDE_MARKER,
    `\n${CLAUDE_MARKER}\n${fs.readFileSync(path.join(templates, 'CLAUDE.section.md'), 'utf8')}`);

  console.log(`\nNext:\n  1. Put reference images in UIKit/reference/\n  2. Describe each screen in UIKit/screens/<name>.json\n  3. UIKit/uikit gen   (then open Unity; sprites import with 9-slice borders)`);
}

function copyTree(from, to, root) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, root);
    else if (fs.existsSync(dst)) log(path.relative(root, dst), 'kept (exists)');
    else {
      fs.copyFileSync(src, dst);
      log(path.relative(root, dst), 'created');
    }
  }
}

function appendOnce(file, marker, text) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.includes(marker)) return log(path.basename(file), 'kept (already set up)');
  fs.appendFileSync(file, text);
  log(path.basename(file), current ? 'updated' : 'created');
}

const log = (file, what) => console.log(`  ${file.padEnd(36)} ${what}`);
