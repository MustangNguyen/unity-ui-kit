import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSurfaces } from '../lib/model.mjs';
import { loadProject } from '../lib/project.mjs';
import { readJson } from '../lib/util.mjs';

/**
 * uikit doctor
 * Checks the setup that silently skews results: reference resolution vs the game's CanvasScaler,
 * capture sizes without the reference aspect, missing inventories, scan, package and skill.
 */
export default async function doctor(args) {
  const project = loadProject(args.project);
  const issues = [];
  const notes = [];
  const config = project.config;
  const ref = config.referenceResolution;

  const surfaces = listSurfaces(project);
  if (!surfaces.length) notes.push('no UIKit/surfaces.json: surface inventory, reskin, canvas and verify are not set up');
  const scalers = new Set();
  for (const s of surfaces) {
    const file = path.join(project.dir, 'inventory', `${s}.json`);
    if (!fs.existsSync(file)) {
      issues.push(`surface "${s}" has no inventory (Unity: Tools/UI Kit/Dump Inventory)`);
      continue;
    }
    const inv = readJson(file);
    scalers.add(inv.referenceResolution.join('x'));
  }
  for (const s of scalers) {
    if (s !== `${ref.width}x${ref.height}`)
      issues.push(`uikit.json referenceResolution is ${ref.width}x${ref.height} but the game's CanvasScaler uses ${s}: set it to ${s.replace('x', ' x ')}`);
  }

  const aspect = ref.width / ref.height;
  if (!config.captureSizes.some((c) => Math.abs(c.width / c.height - aspect) / aspect < 0.01))
    issues.push(`no capture size has the reference aspect (${ref.width}x${ref.height}); compare can only score sizes with that aspect`);

  if (!fs.existsSync(path.join(project.dir, 'protected.json'))) issues.push('no UIKit/protected.json: run `UIKit/uikit scan` before any reskin');

  const manifest = path.join(project.root, 'Packages', 'manifest.json');
  if (fs.existsSync(manifest) && !readJson(manifest).dependencies?.['com.mustang.ui-kit']) issues.push('Packages/manifest.json has no com.mustang.ui-kit');

  const assets = fs.existsSync(path.join(project.dir, 'assets.json')) ? readJson(path.join(project.dir, 'assets.json')).assets ?? [] : [];
  if (assets.length && !fs.existsSync(project.resolve(config.generatedDir))) notes.push(`${config.generatedDir} does not exist yet: run \`UIKit/uikit gen\``);

  if (!fs.existsSync(path.join(os.homedir(), '.claude', 'skills', 'unity-ui-from-reference'))) notes.push('Claude skill not installed: `uikit install-skill`');

  for (const i of issues) console.log(`ISSUE  ${i}`);
  for (const n of notes) console.log(`note   ${n}`);
  console.log(issues.length ? `\n${issues.length} issue(s)` : 'OK');
  if (issues.length) process.exitCode = 1;
}
