import fs from 'node:fs';
import path from 'node:path';
import { buildModel, listSurfaces, loadInventory, reskinPath } from '../lib/model.mjs';
import { loadProject } from '../lib/project.mjs';
import { renderModel, warnings as renderWarnings } from '../lib/render.mjs';
import { fail, readJson, relative, writeIfChanged, writeJson } from '../lib/util.mjs';

/**
 * uikit preview [<surface>] [--before]
 * Renders the expected look of each surface from its inventory and (unless --before) its reskin map:
 * UIKit/previews/<surface>.png, plus <surface>.masks.json (text areas, ignored by verify).
 * This is the target the Unity capture is checked against after the reskin.
 */
export default async function preview(args) {
  const project = loadProject(args.project);
  const surfaces = args._[1] ? [args._[1]] : listSurfaces(project);
  if (!surfaces.length) fail('no surfaces (UIKit/surfaces.json)');
  for (const surface of surfaces) {
    const out = await renderSurface(project, surface, { before: Boolean(args.before) });
    if (out) console.log(`${surface}: ${relative(out.file)}${out.warnings.length ? `  (${out.warnings.length} warnings)` : ''}`);
    for (const w of out?.warnings ?? []) console.log(`  warning: ${w}`);
  }
}

export async function renderSurface(project, surface, { before = false } = {}) {
  const inventory = loadInventory(project, surface);
  const mapFile = reskinPath(project, surface);
  const reskin = !before && fs.existsSync(mapFile) ? readJson(mapFile) : null;
  const model = buildModel(project, inventory, { reskin });
  const { png, masks } = await renderModel(model);
  const name = before ? `${surface}.before` : surface;
  const file = path.join(project.dir, 'previews', `${name}.png`);
  writeIfChanged(file, png);
  writeJson(path.join(project.dir, 'previews', `${name}.masks.json`), { masks });
  return { file, masks, model, warnings: [...model.warnings, ...renderWarnings] };
}
