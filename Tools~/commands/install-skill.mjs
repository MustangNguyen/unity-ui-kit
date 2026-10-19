import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../lib/util.mjs';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'Documentation~', 'skill');

/**
 * uikit install-skill
 * Symlinks the Claude Code skill into ~/.claude/skills, so editing it in this repo updates every project.
 */
export default async function installSkill() {
  const target = path.join(os.homedir(), '.claude', 'skills', 'unity-ui-from-reference');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) fs.unlinkSync(target);
  else if (existing) fail(`${target} exists and is not a symlink; remove it first`);
  fs.symlinkSync(skillDir, target, 'dir');
  console.log(`${target} -> ${skillDir}`);
}
