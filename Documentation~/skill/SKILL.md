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

## Reskin an existing game (keep features, animations and effects)

Use this when the game already has its screens and the job is a new look. The reference images give the style; the game gives the structure (which elements each screen has); animations and effects stay. Never redraw a screen's structure by hand, in the canvas or in Unity: both are generated from one reskin map.

### Setup (once per project)
1. `UIKit/surfaces.json`: one entry per screen or popup. Find the root by `component` (type name), `path`, or `prefab`. Add `"show": "popup"` for popups that open with a scale/alpha animation, and `"states"` for fixture states.
   ```json
   { "surfaces": [ { "name": "Home", "scene": "Assets/Scenes/Home.unity", "component": "HomeScreen", "states": ["default", "hard"] },
                   { "name": "NoAds", "scene": "Assets/Scenes/Home.unity", "component": "RemoveAdsPopup", "show": "popup" } ] }
   ```
2. `UIKit/uikit scan`: lists the names and paths game code looks up and the classes that walk children by index (`UIKit/protected.json`).
3. Fixtures: a class implementing `Mustang.UIKit.IUIKitFixture` per surface that fills it with fixed fake data (`Apply(root, state)`), so canvas, preview and capture show the same content. Without one, runtime-filled lists stay empty.
4. Unity: `Tools/UI Kit/Dump Inventory (all surfaces)` writes `UIKit/inventory/<surface>.json` (baseline). `UIKit/uikit doctor` must report OK (it catches a uikit.json reference resolution that differs from the CanvasScaler).
5. `UIKit/uikit preview --before` then capture (`Tools/UI Kit/Capture Surfaces`) and `UIKit/uikit verify --before`: every surface must PASS. This proves the preview draws like Unity before anything changes.

### The reskin map: `UIKit/reskin/<surface>.json`
```json
{ "surface": "NoAds",
  "nodes": [ { "path": "SafeContent/Content/Scale", "sprite": "panel_main" },
             { "path": "SafeContent/Content/Scale/buy btn", "sprite": "btn_primary_normal", "size": [640, 170] },
             { "path": "SafeContent/Content/Scale/Title/Label", "text": { "font": "LilitaOne SDF", "size": 72, "color": "ink" } } ],
  "add": [ { "parent": "SafeContent/Content/Scale", "name": "Ribbon", "sprite": "ribbon", "rect": [300, -40, 388, 80] } ] }
```
- `path`: as in the inventory (`""` = root, `Item[1]` = second sibling named Item).
- `sprite`: a generated asset id (`uikit gen`) or an asset path (`Assets/...png`, `path#spriteName`). Sliced is set automatically for sprites with a border; `type` overrides.
- `color` / `text.color`: a theme token (adds `ThemedGraphic`) or `#RRGGBBAA`.
- `size` [w, h] and `add[].rect` [x, y, w, h] are design px (like inventory rects); `position` is `anchoredPosition`.
- `active`: "true" / "false" (game code may still toggle it at runtime).
- `ppuMultiplier`: Image.pixelsPerUnitMultiplier. Bigger = thinner 9-slice borders and smaller tiles. Prefer a sprite made for the element's height (`"heights"` in assets.json) over a multiplier when outlines must stay the same thickness everywhere.
- `add`: decorations appended as the parent's last child (drawn on top). Refused under a LayoutGroup, or a node whose children game code iterates (directly, or through a serialized reference held by a class that walks children). Decorations taken out of the map are removed on the next apply.
- Units hold under scaled parents: the engine divides by the scale between the node and the canvas, and the preview applies the same scale to 9-slice borders and text.

### Display quality: `uikit lint`
A match against the preview cannot see these, because the preview draws them faithfully. `UIKit/uikit lint <surface>` checks:
- **border**: 9-slice borders larger than the element; Unity squashes the corners and round ends.
- **blur**: art shown larger than its pixels on a `deviceScale` (uikit.json, default 1.5) screen.
- **stretch**: Simple images (and Filled ones with a rounded sprite: Filled ignores 9-slice) whose aspect ratio differs from the sprite.
- **stroke**: one sprite drawn with different border scales, so outlines differ in thickness.
- **tile**: the Tiled pattern size (info, to compare with the reference).
Every issue has a fix. `--fix` writes the property fixes (ppuMultiplier, preserveAspect) into the map; new art and code changes stay in the report. `--before` lints the game as it is; `--capture` lints the last Unity capture (what Unity really shows). Lint must have no errors before Apply Reskin.

For new sprites, generate one per element height so borders always fit and outlines stay equal: `{ "id": "pill", "type": "panel", "style": "pill", "size": [40, 40], "heights": [38, 54, 90] }` gives `pill_h38`, `pill_h54`, `pill_h90` (buttons: `cta_h80_normal`, ...). Set `"scale"` in uikit.json to `deviceScale` or more for sharp art.

### Flow (per surface, parallel across surfaces)
1. Write the map from the inventory, the theme and the component crops of the reference. One agent per surface; the map is that agent's only file.
2. `UIKit/uikit preview <surface>` and `UIKit/uikit lint <surface> --fix`: look at `UIKit/previews/<surface>.png` and `UIKit/reports/lint/<surface>/lint.png`. Judge the preview (rubric) against the reference.
3. `UIKit/uikit canvas`: generates the Claude Design canvas from the same model (see "Canvas" below). The user reviews the canvas: CHECKPOINT 2.
4. Unity: `Tools/UI Kit/Apply Reskin (dry run)`, read `UIKit/reports/reskin/<surface>.json`, then `Apply Reskin`. The engine changes properties only, never renames, reparents, reorders or deletes nodes, and saves nothing if any check fails.
5. `Tools/UI Kit/Capture Surfaces`, then `UIKit/uikit verify <surface>` (structure, sprites, rects ±2 px, pixels against the preview) and `UIKit/uikit lint <surface> --capture`. Fix the map or the engine input, never the scene by hand.

The preview leaves out nodes drawn by a custom material (glare, iris reveal, blur: their shader decides the look) and Mask graphics with Show Mask Graphic off; verify lists the material nodes it did not compare. Put such effects in their final state in the fixture.

Batch mode for all of it: `-executeMethod Mustang.UIKit.Editor.UIKitSurfaces.FromCommandLine -uikitAction inventory|capture|reskin [-uikitSurface X] [-uikitState s] [-uikitDryRun]` (no `-quit` needed: it exits itself, with code 1 when any surface failed). Unity in batch mode must run without `-nographics` for captures.

Saving a scene after a reskin rewrites the values that LayoutGroups drive (large scene diff). They are recomputed at runtime; `verify --before` on the untouched surfaces of that scene proves nothing visible moved.

### Canvas (Claude Design)
`UIKit/uikit canvas` writes `UIKit/canvas/project/` (`canvas.json` + one `.dc.html` per surface, first = `Main.dc.html`), the baked sprites and fonts to upload (`UIKit/canvas/uploads.json`) and `UIKit/canvas/design-system/tokens.json`. To publish: create the canvas (Design type) once, upload every file in uploads.json as an asset of that canvas, write `{ "<key>": "<url from the upload>" }` to a file, run `UIKit/uikit canvas --blobs <file>`, then publish `project/canvas.json` and the `.dc.html` files to the canvas. Never edit the generated `.dc.html` by hand: change the map and regenerate.

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
