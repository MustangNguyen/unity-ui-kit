## UI work (Mustang UI Kit)

UI is built from reference images with the `unity-ui-from-reference` skill. Use it for any UI screen or UI asset task.

- Source of truth: `UIKit/theme.json` (tokens and styles), `UIKit/assets.json` (sprite list), `UIKit/screens/*.json` (reference + regions).
- Never hand-edit files in `Assets/UI/Generated/`. Change the JSON, then run `UIKit/uikit gen`.
- Bind UI colors with the `ThemedGraphic` component, not hardcoded colors.
- Several screens or assets: drive the work with `UIKit/uikit plan` and run its ready tasks in parallel by lane.
- Measure before judging: `UIKit/uikit palette`, `overlay`, `sheet`, `compare`. Do not claim "looks close" without a report.
- Capture in Unity: menu `Tools/UI Kit/Capture Open Scene`, or `Mustang.UIKit.Editor.UICapture.CaptureOpenScene()`.
- Credits for downloaded icons are in `UIKit/icons/CREDITS.md`; ship them with the game.
