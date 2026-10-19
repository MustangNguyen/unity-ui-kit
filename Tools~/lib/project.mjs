import fs from 'node:fs';
import path from 'node:path';
import { fail, merge, readJson } from './util.mjs';

const DEFAULT_CONFIG = {
  referenceResolution: { width: 1080, height: 1920 },
  captureSizes: [{ width: 1080, height: 1920, label: '16x9' }],
  generatedDir: 'Assets/UI/Generated',
  scale: 1,
  thresholds: { ssim: 0.8, paletteDeltaE: 10, iou: 0.85 },
};

/** Loads the UIKit/ folder of a Unity project: uikit.json, theme.json and helpers to resolve paths. */
export function loadProject(root) {
  const dir = path.join(root, 'UIKit');
  if (!fs.existsSync(dir)) fail(`no UIKit/ folder in ${root}. Run: uikit init <unity-project>`);
  const configPath = path.join(dir, 'uikit.json');
  const config = merge(DEFAULT_CONFIG, fs.existsSync(configPath) ? readJson(configPath) : {});
  const themePath = path.join(dir, 'theme.json');
  if (!fs.existsSync(themePath)) fail(`missing ${themePath}`);
  return {
    root,
    dir,
    config,
    themePath,
    theme: readJson(themePath),
    resolve: (...parts) => path.resolve(root, ...parts),
  };
}

/** A screen file (UIKit/screens/<name>.json) ties one reference image to a scene or prefab and its regions. */
export function loadScreen(project, nameOrPath) {
  const file = nameOrPath.endsWith('.json')
    ? path.resolve(nameOrPath)
    : path.join(project.dir, 'screens', `${nameOrPath}.json`);
  if (!fs.existsSync(file)) fail(`screen file not found: ${file}`);
  const screen = readJson(file);
  return {
    name: path.basename(file, '.json'),
    regions: [],
    ...screen,
    file,
    referencePath: path.resolve(path.dirname(file), screen.reference),
  };
}

/** Path of the PNG that Unity's UICapture wrote for this screen at the given size ("1080x1920"). */
export function capturePath(project, screen, size) {
  if (!screen) fail('need a <screen> or --cap');
  const captures = path.join(project.dir, 'captures');
  if (screen.prefab) return path.join(captures, 'prefabs', `${path.basename(screen.prefab, '.prefab')}.png`);
  if (!screen.scene) fail(`${screen.file}: set "scene" or "prefab"`);
  const first = project.config.captureSizes[0];
  const label = size ?? `${first.width}x${first.height}`;
  return path.join(captures, path.basename(screen.scene, '.unity'), `${label}.png`);
}
