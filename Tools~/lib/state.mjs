import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './util.mjs';

// Step results are tracked by a hash of their input files, not by mtimes: outputs written with
// writeIfChanged keep old mtimes when nothing changed, and mtimes say nothing about content.

/** Short hash of file contents (paths relative to the project, so moving the project keeps it). */
export function hashFiles(project, files, extra = '') {
  const hash = crypto.createHash('sha1');
  hash.update(extra);
  for (const file of files) {
    hash.update(path.relative(project.root, file));
    hash.update('\0');
    hash.update(fs.existsSync(file) ? fs.readFileSync(file) : 'missing');
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

const stateFile = (project, name) => path.join(project.dir, '.state', `${name}.json`);

export function readState(project, name) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(project, name), 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(project, name, value) {
  writeAtomic(stateFile(project, name), JSON.stringify(value, null, 2) + '\n');
}

/** Files that decide what `gen` produces. */
export function genInputs(project, assets) {
  return [
    path.join(project.dir, 'theme.json'),
    path.join(project.dir, 'assets.json'),
    ...assets.filter((a) => a.src).map((a) => path.join(project.dir, a.src)),
  ];
}

/** Files that decide a compare report for one capture. */
export const compareInputs = (screen, capture) => [screen.referencePath, screen.file, capture.png, capture.layout];

/** Settings from uikit.json that change what gen / compare produce (other settings must not invalidate). */
export const genSettings = (project) => JSON.stringify({ scale: project.config.scale, generatedDir: project.config.generatedDir });
export const compareSettings = (project) => JSON.stringify(project.config.thresholds);
