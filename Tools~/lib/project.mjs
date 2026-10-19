import fs from 'node:fs';
import path from 'node:path';
import { fail, merge, readJson } from './util.mjs';

const DEFAULT_CONFIG = {
  referenceResolution: { width: 1080, height: 1920 },
  captureSizes: [{ width: 1080, height: 1920, label: '16x9' }],
  generatedDir: 'Assets/UI/Generated',
  scale: 1,
  thresholds: { ssim: 0.8, paletteDeltaE: 10, iou: 0.85 },
  maxIterations: 4,
  deviceScale: 1.5, // device px per design px to plan art resolution for (1536-wide tablets at a 1024 design)
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

/**
 * Every capture a screen should have: one per configured size for a scene, one for a prefab.
 * [{ size, png, layout }]
 */
export function captureFiles(project, screen) {
  const sizes = screen.prefab ? [null] : project.config.captureSizes.map((s) => `${s.width}x${s.height}`);
  return sizes.map((size) => {
    const png = capturePath(project, screen, size ?? undefined);
    return { size: size ?? path.basename(png, '.png'), png, layout: png.replace(/\.png$/, '.layout.json') };
  });
}

export const DEFAULT_STATES = ['normal', 'pressed', 'disabled'];

/** PNG base names that `gen` writes for one asset (buttons get one per state). */
export function spriteNames(asset) {
  const bases = asset.heights?.length && (asset.type === 'button' || asset.type === 'panel') ? asset.heights.map((h) => `${asset.id}_h${h}`) : [asset.id];
  return asset.type === 'button' ? bases.flatMap((b) => (asset.states ?? DEFAULT_STATES).map((s) => `${b}_${s}`)) : bases;
}

/** Screen names in UIKit/screens/, sorted. */
export function listScreens(project) {
  const dir = path.join(project.dir, 'screens');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json')).sort();
}

const checkpointsPath = (project) => path.join(project.dir, 'checkpoints.json');

/** Human approvals: { spec, assets, screens: { name: isoDate } }. */
export function loadCheckpoints(project) {
  const file = checkpointsPath(project);
  return { screens: {}, ...(fs.existsSync(file) ? readJson(file) : {}) };
}

export function saveCheckpoints(project, checkpoints) {
  fs.writeFileSync(checkpointsPath(project), JSON.stringify(checkpoints, null, 2) + '\n');
}
