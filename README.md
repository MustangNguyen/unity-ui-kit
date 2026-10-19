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
node <đường dẫn clone>/Tools~/uikit.mjs init <project> --package "https://github.com/MustangNguyen/unity-ui-kit.git#v0.4.0"
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
| `UIKit/uikit compare <screen>` | So reference với ảnh chụp Unity ở mọi kích thước đã chụp: SSIM, % pixel khác, ΔE palette, IoU layout. Report nằm ở `UIKit/reports/<screen>/<size>/`. Exit code 2 khi trượt ngưỡng. Kích thước khác tỉ lệ reference chỉ để tham khảo |
| `UIKit/uikit plan` | Task graph của cả job: việc nào xong, việc nào chạy song song được ngay, chia theo lane `parallel` / `unity` / `lead` |
| `UIKit/uikit approve spec\|assets\|<screen>` | Ghi lại một checkpoint mày đã duyệt, để `plan` mở khóa phase sau |
| `UIKit/uikit scan`, `preview`, `canvas`, `verify`, `doctor` | Luồng reskin game có sẵn (mục bên dưới) |
| `UIKit/uikit icon add game-icons:lorc/crystal-ball` | Tải icon (có `lucide:<name>`), ghi credit vào `UIKit/icons/CREDITS.md` |

## Trong Unity

- `Tools > UI Kit > Capture Open Scene`: chụp scene đang mở ở mọi resolution trong `uikit.json`, ghi PNG và `.layout.json` vào `UIKit/captures/<scene>/`.
- Chuột phải prefab > `UI Kit > Capture Prefab`: chụp một prefab riêng vào `UIKit/captures/prefabs/`.
- Code (dùng qua Unity MCP): `UICapture.CaptureOpenScene()`, `UICapture.CapturePrefab(prefab)`, `UICapture.CapturePrefabsIn("Assets/UI/Prefabs")`.
- Batch mode: `-executeMethod Mustang.UIKit.Editor.UICapture.CaptureFromCommandLine -uikitScenes "Assets/Scenes/Home.unity"`.
- Sprite trong thư mục generated tự nhận 9-slice border và PPU. `UITheme.asset` được tạo tự động cạnh `ui-theme.json`.

## Reskin game đã có (giữ tính năng, anim, effect)

Dùng khi game đã có màn hình, chỉ đổi giao diện. Ảnh demo quyết định style; game quyết định cấu trúc; anim (DOTween, Animator) và effect giữ nguyên. Canvas `/design` và bản Unity đều sinh từ cùng một **reskin map**, không dựng tay hai lần.

| Bước | Lệnh |
|---|---|
| Khai báo màn/popup | `UIKit/surfaces.json` (root theo component, path hoặc prefab) |
| Tìm node code phụ thuộc | `UIKit/uikit scan` → `UIKit/protected.json` |
| Dữ liệu giả cố định | class `IUIKitFixture` trong game (mỗi surface một class) |
| Kiểm kê cấu trúc | Unity `Tools > UI Kit > Dump Inventory` → `UIKit/inventory/<surface>.json` |
| Kiểm cấu hình | `UIKit/uikit doctor` |
| Viết reskin map | `UIKit/reskin/<surface>.json` (node → sprite, màu, font, size; decoration) |
| Ảnh kỳ vọng | `UIKit/uikit preview` → `UIKit/previews/` |
| Chất lượng hiển thị | `UIKit/uikit lint` (9-slice bị ép, mờ, kéo dãn, viền dày mỏng khác nhau); `--fix` ghi cách sửa vào map |
| Canvas `/design` | `UIKit/uikit canvas` (rồi upload asset, `--blobs`) |
| Áp vào Unity | `Tools > UI Kit > Apply Reskin` (có dry run) |
| Chụp và kiểm | `Tools > UI Kit > Capture Surfaces`, `UIKit/uikit verify` |

Engine reskin chỉ đổi thuộc tính (sprite, kiểu Sliced, màu, font, kích thước, active) và chỉ thêm decoration vào cuối. Nó không đổi tên, đổi cha, đổi thứ tự hay xóa node; nếu có thay đổi cấu trúc ngoài ý muốn thì không lưu gì. Chi tiết định dạng ở skill (`Documentation~/skill/SKILL.md`).

Đã kiểm trên bản copy jigsaw (Unity 6000.0, URP): preview khớp ảnh chụp Unity với SSIM 0.97–0.999 trước khi reskin; sau khi reskin một popup, `verify` PASS (SSIM 0.974) và hai surface khác trong cùng scene vẫn PASS.

Lưu ý: lưu scene sau reskin làm Unity ghi lại các giá trị RectTransform do LayoutGroup điều khiển (diff lớn trong file scene). Các giá trị này được layout tính lại khi chạy; `verify` của các surface không bị reskin xác nhận không có gì đổi trên màn hình.

## Chia việc cho nhiều agent

`UIKit/uikit plan` đọc trạng thái file (screen nào đã có region, asset nào đã sinh, màn nào đã chụp, report nào trượt, checkpoint nào đã duyệt) và in ra các task đang sẵn sàng, chia theo lane:

- `parallel`: chạy song song bao nhiêu agent cũng được. Mỗi task chỉ ghi file của riêng nó (spec từng màn, vẽ từng SVG, review, compare).
- `unity`: mỗi lúc một task (build, fix), vì chỉ có một Unity Editor.
- `lead`: agent chính tự làm: gộp theme, chạy `gen`, hỏi mày duyệt.

Chạy `plan` lại sau mỗi task xong. Task nào vừa sẵn sàng thì giao ngay, nên compare màn A chạy trong lúc Unity đang build màn B. Skill hướng dẫn Claude dùng loại agent nào cho từng task.

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
