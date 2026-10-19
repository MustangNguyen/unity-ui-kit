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
| `Assets/UI/Generated/` | Output only. Never edit by hand. |

## Workflow

Run the phases in order. Stop at each **CHECKPOINT** and wait for the user.

### 1. Spec (no Unity work yet)
1. Read every reference image and the screen's `notes`. If there is only one reference, ask which properties to copy (layout, palette, shapes, typography) and which to ignore.
2. `UIKit/uikit overlay <screen>` and read `UIKit/reports/<screen>/overlay.png`: take region rects from the grid, not by guessing. Write them into the screen file, rerun overlay, and check that the boxes sit on the elements.
3. `UIKit/uikit palette <screen>`: take color tokens from measured hex values.
4. Write `theme.json` (tokens + styles) and `assets.json`. Keep sprite count low: one style per role, states come from `button`, 9-slice handles sizes. Generate sliced sprites small (for example 120x120); Unity stretches them.
5. **CHECKPOINT 1:** show the token list, the style list, the asset list and the overlay image. Ask the user to approve.

### 2. Assets
1. Icons: prefer `UIKit/uikit icon add game-icons:<author>/<name>` or `lucide:<name>` and theme them with an `icon` style. Draw only what no icon set has.
2. Custom art (illustrations, unusual frames): write SVG by hand or delegate it (Codex via the `ccg` skill). Put it in `UIKit/icons/` as type `svg`. Rules for the author: viewBox set, no text, no external images, no fonts, flat shapes + gradients, palette from theme.json only.
3. `UIKit/uikit gen`, then read `UIKit/reports/assets.png`.
4. `UIKit/uikit sheet <screen>` and read `sheet.png`: reference crop vs sprite with palette ΔE.
5. Judge pass (see below) on the sheet. Fix by changing `theme.json` styles, not the PNGs. Repeat 3 to 5 up to `maxIterations`.
6. **CHECKPOINT 2:** show `assets.png` and `sheet.png` with scores. Ask the user to approve the look before building screens.

### 3. Build in Unity
1. Build UI as prefabs. Use Image with the generated sprites (Image Type Sliced for sprites with a border), TMP for text, layout groups for lists.
2. Add `ThemedGraphic` (theme = `Assets/UI/Generated/UITheme.asset`) to every element that takes a theme color, including text.
3. Canvas: Screen Space, CanvasScaler Scale With Screen Size, reference resolution from `uikit.json`. Use anchors so the layout survives every capture size.
4. Use Unity MCP for edits. Check the console for errors after each change.

### 4. Measure and fix
1. Capture: MCP `execute_menu_item` "Tools/UI Kit/Capture Open Scene", or run code `Mustang.UIKit.Editor.UICapture.CaptureOpenScene()`. Prefabs: `UICapture.CapturePrefab(prefab)` or `UICapture.CapturePrefabsIn("Assets/UI/Prefabs")`.
2. `UIKit/uikit compare <screen>` (default size = first capture size; `--size 1080x2340` for the others). Read `compare.png` and `report.json`.
3. Check every capture size, not only the reference size: look for overlap, clipping, elements out of the safe area, and text overflow.
4. Fix the cause with the numbers: offset/IoU means anchors or size; palette ΔE means token or style; low SSIM with good IoU means shape or style.
5. Judge pass on `compare.png`. Repeat up to `maxIterations`. When the limit is reached, stop and report what still fails.
6. **CHECKPOINT 3:** show the compare images at all sizes, the table, and the judge scores. Ask the user to accept.

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
