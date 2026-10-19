#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from './lib/util.mjs';

const USAGE = `uikit <command> [--project <unity-project>]   (default project: current folder)

  init <unity-project>       add the package, scaffold UIKit/, wrapper, CLAUDE.md section
  gen [--only id,id]         assets.json + theme.json -> SVG -> PNG sprites with 9-slice import data
  overlay <screen|image>     reference with pixel grid and region boxes (to read/check rects)
  palette <screen|image>     measured dominant colors (for the spec, instead of guessing)
  sheet <screen>             reference crop vs generated sprite, per asset
  compare <screen> [--size WxH]
                             reference vs Unity capture (all sizes): SSIM, diff, palette ΔE, layout IoU
  icon add <source:name>     fetch an icon (game-icons:lorc/crystal-ball, lucide:settings)
  plan [--json]              task graph: what can run in parallel now, by lane (parallel, unity, lead)
  approve spec|assets|<screen> [--revoke]
                             record a user approval (checkpoint) for plan
  install-skill              link the Claude skill into ~/.claude/skills

Reskin of an existing game (UIKit/surfaces.json, Unity: Tools/UI Kit/Dump Inventory, Capture Surfaces, Apply Reskin):
  scan                       find what game code looks up by name/path or walks by index -> UIKit/protected.json
  preview [<surface>] [--before]
                             expected look from inventory + reskin map -> UIKit/previews/<surface>.png
  canvas [<surface>...] [--before] [--blobs <file>]
                             Claude Design canvas files (+ assets to upload) from the same model
  verify [<surface>] [--before]
                             Unity capture vs expected: structure, sprites, rects, pixels (text masked)
  doctor                     setup checks (reference resolution vs CanvasScaler, capture sizes, scan, package)
`;

const COMMANDS = ['init', 'gen', 'overlay', 'palette', 'sheet', 'compare', 'icon', 'plan', 'approve', 'scan', 'preview', 'canvas', 'verify', 'doctor', 'install-skill'];

const args = parseArgs(process.argv.slice(2));
args.project = path.resolve(args.project ?? process.cwd());
const command = args._[0];

if (!command || args.help || !COMMANDS.includes(command)) {
  console.log(USAGE);
  process.exit(command && !args.help ? 1 : 0);
}

const { default: run } = await import(`./commands/${command}.mjs`);
await run(args);
