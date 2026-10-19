# Mustang UI Kit

Bộ công cụ dựng UI Unity (uGUI) từ ảnh reference, có đo đạc thay vì để AI tự chấm bằng mắt.

Gồm 3 phần:

1. **Unity package** `com.mustang.ui-kit`: `UITheme`, `ThemedGraphic`, capture màn hình ở Edit mode theo nhiều resolution, dump layout ra JSON, tự import sprite (9-slice, PPU).
2. **CLI** `Tools~/uikit.mjs` (Node): sinh sprite SVG → PNG từ theme, so sánh reference với ảnh chụp Unity, đo màu, tạo ảnh review.
3. **Claude skill** `unity-ui-from-reference`: quy trình 4 bước có 3 checkpoint cho người duyệt, cùng rubric cho agent chấm riêng.

## Cài một lần cho máy

```bash
cd ~/MienCuong/Unity/unity-ui-kit/Tools~ && npm install
```

```bash
node ~/MienCuong/Unity/unity-ui-kit/Tools~/uikit.mjs install-skill
```

## Thêm vào project mới

```bash
node ~/MienCuong/Unity/unity-ui-kit/Tools~/uikit.mjs init ~/MienCuong/Unity/<project>
```

Lệnh này:
- thêm package vào `Packages/manifest.json` (dạng `file:` trỏ về repo này, nên sửa repo là mọi project nhận ngay);
- tạo `UIKit/` với file mẫu: `theme.json`, `assets.json`, `uikit.json`, `screens/example.json`;
- tạo `UIKit/uikit` để gọi CLI từ trong project;
- thêm `UIKit/captures/` và `UIKit/reports/` vào `.gitignore`;
- thêm một mục hướng dẫn vào `CLAUDE.md`.

Lệnh không ghi đè file đã có.

Dùng ở máy khác hoặc CI thì cài package bằng git URL thay cho `file:`:

```bash
node <đường dẫn clone>/Tools~/uikit.mjs init <project> --package "https://github.com/MustangNguyen/unity-ui-kit.git#v0.1.1"
```

CLI vẫn chạy từ bản clone (cần `npm install` trong `Tools~`).

## Lệnh CLI

Chạy từ thư mục gốc project Unity:

| Lệnh | Việc |
|---|---|
| `UIKit/uikit gen` | `assets.json` + `theme.json` → SVG (`UIKit/svg/`) → PNG (`Assets/UI/Generated/`) + dữ liệu import + ảnh xem trước `UIKit/reports/assets.png` |
| `UIKit/uikit overlay <screen>` | Vẽ lưới tọa độ và các region lên reference để đọc tọa độ chính xác |
| `UIKit/uikit palette <screen>` | Đo màu chủ đạo của từng region |
| `UIKit/uikit sheet <screen>` | So crop reference với sprite đã sinh |
| `UIKit/uikit compare <screen>` | So reference với ảnh chụp Unity: SSIM, % pixel khác, ΔE palette, IoU layout. Exit code 2 khi trượt ngưỡng |
| `UIKit/uikit icon add game-icons:lorc/crystal-ball` | Tải icon (có `lucide:<name>`), ghi credit vào `UIKit/icons/CREDITS.md` |

## Trong Unity

- `Tools > UI Kit > Capture Open Scene`: chụp scene đang mở ở mọi resolution trong `uikit.json`, ghi PNG và `.layout.json` vào `UIKit/captures/<scene>/`.
- Chuột phải prefab > `UI Kit > Capture Prefab`: chụp một prefab riêng vào `UIKit/captures/prefabs/`.
- Code (dùng qua Unity MCP): `UICapture.CaptureOpenScene()`, `UICapture.CapturePrefab(prefab)`, `UICapture.CapturePrefabsIn("Assets/UI/Prefabs")`.
- Batch mode: `-executeMethod Mustang.UIKit.Editor.UICapture.CaptureFromCommandLine -uikitScenes "Assets/Scenes/Home.unity"`.
- Sprite trong thư mục generated tự nhận 9-slice border và PPU. `UITheme.asset` được tạo tự động cạnh `ui-theme.json`.

## Style trong theme.json

```json
"button": {
  "fill": ["primary", "primaryDark"],
  "stroke": "primaryDeep", "strokeWidth": "stroke",
  "radius": "radius.md",
  "bevel": { "size": "bevel", "color": "primaryDeep" },
  "shadow": { "dx": 0, "dy": 6, "blur": 0, "color": "shadow" },
  "highlight": { "opacity": 0.35, "height": 0.42 },
  "innerStroke": { "color": "#FFFFFFAA", "width": 3 },
  "noise": { "opacity": 0.05, "frequency": 0.9 },
  "states": { "disabled": { "fill": ["#CCCCCC", "#999999"] } }
}
```

- Màu: tên token hoặc `#RRGGBB` / `#RRGGBBAA`. Mảng nhiều màu là gradient từ trên xuống.
- Kích thước: số hoặc tên token metric. `"radius": "full"` cho viên thuốc hoặc hình tròn.
- `"extends": "button"` để kế thừa style khác.
- State `pressed` mặc định lún xuống phần bevel; `disabled` mặc định giảm bão hòa màu. Khai báo trong `states` để ghi đè.

## Kiểm thử

`Tests~/UIKitSmokeTest.cs` kiểm import sprite, theme, capture (pixel, gamma), layout dump, capture prefab và việc reimport khi đổi border. Cách chạy:

1. Copy file vào `Assets/Editor/` của một project Unity đã chạy `uikit init` và `uikit gen`.
2. Chạy Unity batchmode với `-executeMethod UIKitSmokeTest.Run` (Built-in) hoặc `UIKitSmokeTest.RunUrp` (URP). Không dùng `-nographics`.

Đường dẫn project test không được chứa `~`. Unity coi đường dẫn đó là ẩn, script của package mất liên kết, và prefab lưu ra bị mất component.

## Giới hạn

- SVG hợp với phong cách flat, casual, vector. Art vẽ tay nhiều texture thì SVG chỉ đạt mức na ná.
- Capture ở Edit mode không mô phỏng safe area của thiết bị thật.
- Khi chụp, mọi canvas chuyển sang camera space ở cùng khoảng cách và chỉ xếp theo sorting order. Scene trộn canvas overlay với canvas camera có thể xếp lớp khác lúc chạy game.
- Đã kiểm trên Unity 6000.0.68f1 và 6000.6.0f1, cả Built-in lẫn URP.
- Package cài bằng `file:` đường dẫn tuyệt đối chỉ chạy trên máy này. Máy khác dùng git URL như ở trên.
