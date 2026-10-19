---
name: unity-ui-from-reference
description: Build or refactor Unity uGUI screens and UI sprites from reference images with measured checks (Mustang UI Kit). Use for any Unity UI design, UI refactor, UI asset generation (buttons, panels, icons as SVG to PNG), or "make this screen look like the reference" task in a project that has a UIKit/ folder or should get one.
---

# Unity UI from reference

Goal: a Unity screen that matches the reference, judged by numbers and a separate judge, never by the builder's own "looks close".

Tooling: the `com.mustang.ui-kit` package plus the CLI at `UIKit/uikit` in the project (Node). If the project has no `UIKit/` folder, run `node ~/MienCuong/Unity/unity-ui-kit/Tools~/uikit.mjs init <project>` first.

## Files

| File | Role |
|---|---|
| `UIKit/theme.json` | Color and metric tokens, plus `styles` (fill, stroke, bevel, shadow, highlight, innerStroke, noise, states, extends). Single source of truth. |
| `UIKit/assets.json` | Every sprite: `id`, `type` (`panel`, `button`, `icon`, `svg`), `size` [w, h] in design px, `style`, `src` for icon/svg. |
| `UIKit/screens/<name>.json` | `reference` image, `scene` or `prefab`, `notes`, `regions` [{name, rect [x,y,w,h] in reference px, asset, node}]. |
| `UIKit/uikit.json` | Capture sizes, generated folder, thresholds, max iterations. |
| `UIKit/checkpoints.json` | User approvals written by `uikit approve`. `uikit plan` reads them. |
| `Assets/UI/Generated/` | Output only. Never edit by hand. |

## Workflow

Run the phases in order. Stop at each **CHECKPOINT** and wait for the user. With more than one screen or more than a few custom assets, run the phases through `uikit plan` (see **Parallel execution**) instead of doing every step yourself.

### 1. Spec (no Unity work yet)
1. Read every reference image and the screen's `notes`. If there is only one reference, ask which properties to copy (layout, palette, shapes, typography) and which to ignore.
2. `UIKit/uikit overlay <screen>` and read `UIKit/reports/<screen>/overlay.png`: take region rects from the grid, not by guessing. Write them into the screen file, rerun overlay, and check that the boxes sit on the elements.
3. `UIKit/uikit palette <screen>`: take color tokens from measured hex values.
4. Write `theme.json` (tokens + styles) and `assets.json`. Keep sprite count low: one style per role, states come from `button`, 9-slice handles sizes. Generate sliced sprites small (for example 120x120); Unity stretches them.
5. **CHECKPOINT 1:** show the token list, the style list, the asset list and the overlay image. Ask the user to approve. On yes: `UIKit/uikit approve spec`.

### 2. Assets
1. Icons: prefer `UIKit/uikit icon add game-icons:<author>/<name>` or `lucide:<name>` and theme them with an `icon` style. Draw only what no icon set has.
2. Custom art (illustrations, unusual frames): write SVG by hand or delegate it (Codex via the `ccg` skill). Put it in `UIKit/icons/` as type `svg`. Rules for the author: viewBox set, no text, no external images, no fonts, flat shapes + gradients, palette from theme.json only.
3. `UIKit/uikit gen`, then read `UIKit/reports/assets.png`.
4. `UIKit/uikit sheet <screen>` and read `sheet.png`: reference crop vs sprite with palette ΔE.
5. Judge pass (see below) on the sheet. Fix by changing `theme.json` styles, not the PNGs. Repeat 3 to 5 up to `maxIterations`.
6. **CHECKPOINT 2:** show `assets.png` and `sheet.png` with scores. Ask the user to approve the look before building screens. On yes: `UIKit/uikit approve assets`.

### 3. Build in Unity
1. Build UI as prefabs. Use Image with the generated sprites (Image Type Sliced for sprites with a border), TMP for text, layout groups for lists.
2. Add `ThemedGraphic` (theme = `Assets/UI/Generated/UITheme.asset`) to every element that takes a theme color, including text.
3. Canvas: Screen Space, CanvasScaler Scale With Screen Size, reference resolution from `uikit.json`. Use anchors so the layout survives every capture size.
4. Use Unity MCP for edits. Check the console for errors after each change.

### 4. Measure and fix
1. Capture: MCP `execute_menu_item` "Tools/UI Kit/Capture Open Scene", or run code `Mustang.UIKit.Editor.UICapture.CaptureOpenScene()`. Prefabs: `UICapture.CapturePrefab(prefab)` or `UICapture.CapturePrefabsIn("Assets/UI/Prefabs")`.
2. `UIKit/uikit compare <screen>` compares every captured size; reports are in `UIKit/reports/<screen>/<size>/` (`compare.png`, `report.json`). Sizes with another aspect ratio than the reference are marked INFO: their numbers are hints only.
3. Check every capture size, not only the reference size: look for overlap, clipping, elements out of the safe area, and text overflow.
4. Fix the cause with the numbers: offset/IoU means anchors or size; palette ΔE means token or style; low SSIM with good IoU means shape or style.
5. Judge pass on `compare.png`. Repeat up to `maxIterations`. When the limit is reached, stop and report what still fails.
6. **CHECKPOINT 3:** show the compare images at all sizes, the table, and the judge scores. Ask the user to accept. On yes: `UIKit/uikit approve <screen>`.

## Parallel execution

`UIKit/uikit plan` computes the task graph from the files on disk and prints what is ready, grouped by lane. You are the lead: you dispatch, merge and talk to the user. Loop:

1. Run `UIKit/uikit plan` (`--json` for the full graph).
2. Start every ready task by its lane:
   - **parallel**: one background subagent per task, all at once (at most 5 running). Each task writes only its own files and reads the rest.
   - **unity**: one task at a time, never two agents on Unity MCP together. There is one Editor, and a script compile or domain reload in one task breaks the other. Do it yourself or give it to one builder agent.
   - **lead**: do it yourself. These tasks touch shared files (`theme.json`, `assets.json`, `gen`) or need the user (approval tasks).
3. When any task finishes, merge its result and run `plan` again, then start what became ready at once. Do not wait for a whole phase. For example: when screen A is captured, start `compare:A` while the Unity lane builds screen B.
4. Stop at approval tasks and ask the user. Tasks on other branches may keep running.

When not to split: a task that takes a couple of tool calls, or only one ready task. Spawning costs more than it saves.

### Who does what

| Task | Agent | Gets | Returns |
|---|---|---|---|
| `spec:<screen>` | general-purpose (reads images) | brief from plan, the screen file, this skill | regions written in its screen file; proposed tokens with measured hex, styles, assets |
| `art:<id>` | Codex via the `ccg` skill, or executor | asset id, size, `src` path, palette hex list, SVG rules (phase 2) | the SVG file at `src` |
| `review:<screen>` | critic or verifier (never the builder) | sheet.png, sheet.json, reference, `rubric.md` | scores and fixes as style changes |
| `build:<screen>` / `fix:<screen>` | lead or one builder agent with Unity MCP | brief, screen file, asset list, fixes | prefab/scene changes and a fresh capture |
| `compare:<screen>` | critic or verifier | brief: it runs compare and judges every size | scores and fixes; it does not touch Unity |

Brief for a parallel agent: paste the task's `brief` from plan, its `writes` list ("edit only these files"), the paths it must read, and "return a short result; do not edit theme.json or assets.json". The lead merges the proposals: one token per color role across all screens, and one style per element role.

### Shared-file rules
- Only the lead edits `theme.json` and `assets.json`. Agents return proposals.
- `uikit gen` and `uikit icon add` take locks, so several agents may run `gen --only <id>` (to preview their own sprite) or `icon add` at once. Only a full `gen` refreshes `reports/assets.png` and counts for the plan, so it stays a lead task.
- Plan tracks content, not time: an approval covers exactly what the user saw. A `theme.json` change after CHECKPOINT 2 sends the job back through `gen` and CHECKPOINT 2, and blocks every build until then. So collect the color fixes from all screens and apply them as one theme change.
- `fix:<screen>` stops after `maxIterations` rounds; the screen then goes to CHECKPOINT 3 marked as still failing. The user accepts (`uikit approve <screen>`) or gives direction; to allow new fix rounds after direction, run `uikit approve <screen> --revoke` (it resets the count). Theme changes do not reset it.
- `config:<screen>` means no capture size has the reference's aspect ratio. Add one to `captureSizes` in `uikit.json` (lead), then recapture.
- Editing a region rect does not reopen CHECKPOINT 1, but it reruns that screen's review and compare.
- `uikit approve` only after the user said yes in chat.

## Judge pass

The builder never approves its own work. Spawn a separate agent (for example `critic` or `verifier`, or a different model) with only:
- the images (sheet.png or compare.png, and the reference),
- `report.json` / `sheet.json`,
- `rubric.md` from this skill folder.

Do not give it your intent or your opinion of the result. It returns the rubric scores and a list of concrete fixes. Pass condition: every metric in thresholds passes AND every rubric item is 3 or higher AND the average is 4 or higher.

## Rules
- Every claim about a match cites a metric or a judge score.
- Change tokens and styles, then regenerate. Do not patch generated PNGs.
- Do not copy art from reference images into the game. The references show direction only.
- game-icons.net icons need the credit lines from `UIKit/icons/CREDITS.md` in the shipped game.
- Do not edit files that another session is editing. If the project is busy, work on assets and specs only.
