import fs from 'node:fs';
import path from 'node:path';
import { loadProject } from '../lib/project.mjs';
import { relative, writeJson } from '../lib/util.mjs';

// Vendor code is not the game's UI code; its lookups do not constrain the reskin.
const SKIP = /\/(Plugins|ThirdParty|Third Party|Demigiant|TextMesh Pro|Samples|Editor)\//i;

/**
 * uikit scan
 * Finds what game code depends on in the UI hierarchy, so the reskin keeps it intact:
 *   names / paths  literals passed to Find, GameObject.Find, FindChild
 *   iterates       classes that walk children by index (GetChild, childCount, foreach Transform)
 * Writes UIKit/protected.json (read by the Unity inventory and the reskin engine) and lists every hit.
 */
export default async function scan(args) {
  const project = loadProject(args.project);
  const files = listCs(path.join(project.root, 'Assets'));
  const names = new Set();
  const paths = new Set();
  const iterates = new Set();
  const hits = [];

  for (const file of files) {
    const rel = path.relative(project.root, file);
    if (SKIP.test('/' + rel.replace(/\\/g, '/'))) continue;
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    const classes = [...source.matchAll(/\bclass\s+(\w+)/g)].map((m) => m[1]);
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      // Shader.Find takes shader names, not hierarchy names.
      for (const m of line.matchAll(/(?<!Shader\.)\b(?:Find|FindChild|FindDeepChild|FindRecursive)\(\s*"([^"]+)"/g)) {
        (m[1].includes('/') ? paths : names).add(m[1]);
        hits.push(`${rel}:${i + 1}  Find("${m[1]}")`);
      }
      if (/\.GetChild\(|\.childCount\b|foreach\s*\(\s*Transform\s+\w+\s+in\b/.test(line)) {
        for (const c of classes) iterates.add(c);
        hits.push(`${rel}:${i + 1}  children by index (${classes.join(', ') || 'no class'})`);
      }
    });
  }

  const out = path.join(project.dir, 'protected.json');
  writeJson(out, { names: [...names].sort(), paths: [...paths].sort(), iterates: [...iterates].sort(), hits });
  console.log(`${names.size} names, ${paths.size} paths, ${iterates.size} classes iterating children (${hits.length} hits) -> ${relative(out)}`);
  if (args.verbose) for (const hit of hits) console.log(`  ${hit}`);
}

function listCs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listCs(full));
    else if (entry.name.endsWith('.cs')) out.push(full);
  }
  return out;
}
