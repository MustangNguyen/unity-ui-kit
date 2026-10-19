using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace Mustang.UIKit.Editor
{
    /// <summary>
    /// Inventory of one surface: every node under its root with its on-screen rect (design px at the
    /// reference resolution, origin top-left), how it draws (sprite source, 9-slice, tint, text and font)
    /// and whether game code depends on it. The reskin map, the design canvas and the preview are all
    /// built from this file, so they share the game's real structure.
    /// </summary>
    public static class UIInventory
    {
        [Serializable]
        public class Node
        {
            public string path;           // relative to the root ("" = root); duplicate sibling names get "[1]", "[2]"
            public string name;
            public int depth;
            public int sibling;
            public bool active;           // activeInHierarchy
            public bool activeSelf;
            public float x, y, width, height;
            public float pivotX, pivotY;
            public float anchoredX, anchoredY; // RectTransform.anchoredPosition (Unity y up), in the parent's local units
            public float scaleX, scaleY;       // design px per local unit of this node (its scale relative to the canvas)
            public float parentScaleX, parentScaleY;
            public bool fixedWidth, fixedHeight; // anchors equal on that axis: size can be set directly
            public float alpha;           // product of CanvasGroup alphas
            public float[] clip;          // [x, y, w, h] of the nearest Mask / RectMask2D ancestor, else empty
            public string kind;           // Button, Toggle, Slider, ScrollRect, InputField, Text, Image, RawImage, Container
            public string[] components;
            public string protectedBy;    // why game code depends on this node, else empty

            public bool drawsImage;
            public string color;          // #RRGGBBAA of the Graphic
            public string sprite;         // sprite name
            public string spritePath;     // source texture asset path
            public float[] spriteRect;    // [x, y, w, h] in source texture pixels, origin top-left
            public int[] textureSize;     // source texture [w, h]
            public float[] slice;         // 9-slice border in source texture pixels [left, bottom, right, top]
            public float[] sliceUnits;    // the same border in design px as Unity draws it (local border x node scale)
            public float pixelsPerUnitMultiplier;
            public string imageType;
            public bool preserveAspect;
            public bool fillCenter;
            public string fillMethod;
            public float fillAmount;
            public int fillOrigin;
            public string texturePath;    // RawImage texture asset (empty when set at runtime)

            public bool drawsText;
            public string text;           // parsed text (rich tags removed)
            public string font;
            public string fontFamily;
            public string fontFile;       // source font file asset path
            public float fontSize;        // design px (the size TMP actually used, after auto-size)
            public string fontStyle;
            public string alignment;
            public string textColor;
            public bool wrap;
            public float lineSpacing;
            public float characterSpacing;
            public bool masks;
        }

        [Serializable]
        class File
        {
            public string surface;
            public string source;
            public string capturedAt;
            public int width, height;
            public int[] referenceResolution;
            public float matchWidthOrHeight;
            public float referencePixelsPerUnit;
            public List<Node> nodes = new();
        }

        public static void Write(Transform root, Canvas canvas, Camera cam, Vector2Int size, UIKitSurfaces.Surface surface, string path)
        {
            var scaler = canvas.GetComponent<CanvasScaler>();
            var reference = UIKitSurfaces.ReferenceSize(canvas);
            var protection = UIKitProtected.Load();
            var file = new File
            {
                surface = surface.name,
                source = !string.IsNullOrEmpty(surface.prefab) ? surface.prefab : surface.scene,
                capturedAt = DateTime.UtcNow.ToString("o"),
                width = size.x,
                height = size.y,
                referenceResolution = new[] { reference.x, reference.y },
                matchWidthOrHeight = scaler != null ? scaler.matchWidthOrHeight : 0f,
                referencePixelsPerUnit = canvas.referencePixelsPerUnit,
            };

            // Design px per screen px: captures at other sizes still report rects in design units.
            var designScale = 1f / canvas.scaleFactor;
            var paths = new Dictionary<Transform, string> { [root] = "" };
            Walk(root, 0);

            void Walk(Transform t, int depth)
            {
                var rect = t as RectTransform;
                var node = new Node
                {
                    path = paths[t],
                    name = t.name,
                    depth = depth,
                    sibling = t.GetSiblingIndex(),
                    active = t.gameObject.activeInHierarchy,
                    activeSelf = t.gameObject.activeSelf,
                    components = t.GetComponents<Component>()
                        .Where(c => c != null && c is not Transform && c is not CanvasRenderer)
                        .Select(c => c.GetType().Name).ToArray(),
                    alpha = EffectiveAlpha(t),
                    clip = ClipRect(t, cam, size, designScale),
                    protectedBy = protection.Reason(t, paths[t]),
                    kind = Kind(t),
                };
                if (rect != null)
                {
                    var r = ScreenRect(rect, cam, size, designScale);
                    (node.x, node.y, node.width, node.height) = (r[0], r[1], r[2], r[3]);
                    (node.pivotX, node.pivotY) = (rect.pivot.x, rect.pivot.y);
                    (node.anchoredX, node.anchoredY) = (R(rect.anchoredPosition.x), R(rect.anchoredPosition.y));
                    var canvasScale = canvas.transform.lossyScale;
                    (node.scaleX, node.scaleY) = (rect.lossyScale.x / canvasScale.x, rect.lossyScale.y / canvasScale.y);
                    var parentScale = t.parent != null ? t.parent.lossyScale : canvasScale;
                    (node.parentScaleX, node.parentScaleY) = (parentScale.x / canvasScale.x, parentScale.y / canvasScale.y);
                    node.fixedWidth = Mathf.Approximately(rect.anchorMin.x, rect.anchorMax.x);
                    node.fixedHeight = Mathf.Approximately(rect.anchorMin.y, rect.anchorMax.y);
                }
                node.masks = t.GetComponent<RectMask2D>() != null || t.GetComponent<Mask>() != null;
                DescribeGraphic(t, node, canvas);
                file.nodes.Add(node);

                var seen = new Dictionary<string, int>();
                foreach (Transform child in t)
                {
                    seen.TryGetValue(child.name, out var n);
                    seen[child.name] = n + 1;
                    var segment = n == 0 ? child.name : $"{child.name}[{n}]";
                    paths[child] = string.IsNullOrEmpty(paths[t]) ? segment : $"{paths[t]}/{segment}";
                    Walk(child, depth + 1);
                }
            }

            Directory.CreateDirectory(Path.GetDirectoryName(path) ?? ".");
            System.IO.File.WriteAllText(path, JsonUtility.ToJson(file, true));
        }

        static float[] ScreenRect(RectTransform rect, Camera cam, Vector2Int size, float designScale)
        {
            var corners = new Vector3[4];
            rect.GetWorldCorners(corners);
            var min = new Vector2(float.MaxValue, float.MaxValue);
            var max = new Vector2(float.MinValue, float.MinValue);
            foreach (var corner in corners)
            {
                var p = RectTransformUtility.WorldToScreenPoint(cam, corner);
                min = Vector2.Min(min, p);
                max = Vector2.Max(max, p);
            }
            return new[] { R(min.x * designScale), R((size.y - max.y) * designScale), R((max.x - min.x) * designScale), R((max.y - min.y) * designScale) };
        }

        static float R(float v) => Mathf.Round(v * 10f) / 10f;

        static float EffectiveAlpha(Transform t)
        {
            var alpha = 1f;
            for (var p = t; p != null; p = p.parent)
            {
                if (!p.TryGetComponent<CanvasGroup>(out var group) || !group.enabled) continue;
                alpha *= group.alpha;
                if (group.ignoreParentGroups) break;
            }
            return R(alpha * 1000f) / 1000f;
        }

        static float[] ClipRect(Transform t, Camera cam, Vector2Int size, float designScale)
        {
            for (var p = t.parent; p != null; p = p.parent)
            {
                var mask = p.GetComponent<Mask>();
                if ((p.GetComponent<RectMask2D>() is { enabled: true } || mask is { enabled: true }) && p is RectTransform rect)
                    return ScreenRect(rect, cam, size, designScale);
            }
            return Array.Empty<float>();
        }

        static string Kind(Transform t)
        {
            if (t.GetComponent<Button>()) return "Button";
            if (t.GetComponent<Toggle>()) return "Toggle";
            if (t.GetComponent<Slider>()) return "Slider";
            if (t.GetComponent<ScrollRect>()) return "ScrollRect";
            if (t.GetComponent<TMP_InputField>() || t.GetComponent<InputField>()) return "InputField";
            if (t.GetComponent<TMP_Text>() || t.GetComponent<Text>()) return "Text";
            if (t.GetComponent<Image>()) return "Image";
            if (t.GetComponent<RawImage>()) return "RawImage";
            return "Container";
        }

        static void DescribeGraphic(Transform t, Node node, Canvas canvas)
        {
            var graphic = t.GetComponent<Graphic>();
            if (graphic == null || !graphic.enabled) return;
            node.color = "#" + ColorUtility.ToHtmlStringRGBA(graphic.color);

            switch (graphic)
            {
                case Image image:
                    node.drawsImage = image.sprite != null || image.color.a > 0f;
                    node.imageType = image.type.ToString();
                    node.preserveAspect = image.preserveAspect;
                    node.fillCenter = image.fillCenter;
                    node.fillMethod = image.fillMethod.ToString();
                    node.fillAmount = image.fillAmount;
                    node.fillOrigin = image.fillOrigin;
                    node.pixelsPerUnitMultiplier = image.pixelsPerUnitMultiplier;
                    if (image.sprite != null) DescribeSprite(image, node);
                    break;
                case RawImage raw:
                    node.drawsImage = true;
                    node.imageType = "Simple";
                    node.texturePath = raw.texture != null ? AssetDatabase.GetAssetPath(raw.texture) : "";
                    break;
                case TMP_Text text:
                    node.drawsText = true;
                    node.text = text.GetParsedText();
                    if (string.IsNullOrEmpty(node.text)) node.text = text.text;
                    node.font = text.font != null ? text.font.name : "";
                    node.fontFamily = text.font != null ? text.font.faceInfo.familyName : "";
                    node.fontFile = text.font != null && text.font.sourceFontFile != null ? AssetDatabase.GetAssetPath(text.font.sourceFontFile) : "";
                    node.fontSize = text.fontSize;
                    node.fontStyle = text.fontStyle.ToString();
                    node.alignment = text.alignment.ToString();
                    node.textColor = "#" + ColorUtility.ToHtmlStringRGBA(text.color);
                    node.wrap = text.textWrappingMode != TextWrappingModes.NoWrap;
                    node.lineSpacing = text.lineSpacing;
                    node.characterSpacing = text.characterSpacing;
                    break;
                case Text legacy:
                    node.drawsText = true;
                    node.text = legacy.text;
                    node.font = legacy.font != null ? legacy.font.name : "";
                    node.fontFamily = node.font;
                    node.fontFile = legacy.font != null ? AssetDatabase.GetAssetPath(legacy.font) : "";
                    node.fontSize = legacy.fontSize;
                    node.fontStyle = legacy.fontStyle.ToString();
                    node.alignment = legacy.alignment.ToString();
                    node.textColor = node.color;
                    node.wrap = legacy.horizontalOverflow == HorizontalWrapMode.Wrap;
                    break;
            }
        }

        static void DescribeSprite(Image image, Node node)
        {
            var sprite = image.sprite;
            node.sprite = sprite.name;
            node.spritePath = AssetDatabase.GetAssetPath(sprite);
            // With a SpriteAtlas, sprite.texture is the atlas while sprite.rect stays in the source texture:
            // take the size from the texture asset the sprite was imported from.
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(node.spritePath) ?? sprite.texture;
            var (sourceW, sourceH) = (texture.width, texture.height);
            if (AssetImporter.GetAtPath(node.spritePath) is TextureImporter importer)
                importer.GetSourceTextureWidthAndHeight(out sourceW, out sourceH);
            // sprite.rect is in imported pixels (origin bottom-left); the PNG on disk may be larger.
            var sx = (float)sourceW / texture.width;
            var sy = (float)sourceH / texture.height;
            var r = sprite.rect;
            node.textureSize = new[] { sourceW, sourceH };
            node.spriteRect = new[] { R(r.x * sx), R((texture.height - r.y - r.height) * sy), R(r.width * sx), R(r.height * sy) };
            var b = sprite.border;
            node.slice = new[] { R(b.x * sx), R(b.y * sy), R(b.z * sx), R(b.w * sy) };
            var perUnit = image.pixelsPerUnit * image.pixelsPerUnitMultiplier; // what Image uses to size borders (local units)
            var (kx, ky) = (node.scaleX > 0 ? node.scaleX : 1f, node.scaleY > 0 ? node.scaleY : 1f);
            node.sliceUnits = new[] { R(b.x / perUnit * kx), R(b.y / perUnit * ky), R(b.z / perUnit * kx), R(b.w / perUnit * ky) };
        }
    }

    /// <summary>UIKit/protected.json, written by `uikit scan`: names and paths game code finds, and classes that iterate children.</summary>
    [Serializable]
    public class UIKitProtected
    {
        public string[] names = Array.Empty<string>();
        public string[] paths = Array.Empty<string>();
        public string[] iterates = Array.Empty<string>();

        public static UIKitProtected Load()
        {
            var file = Path.Combine(UIKitConfig.KitDir, "protected.json");
            return System.IO.File.Exists(file) ? JsonUtility.FromJson<UIKitProtected>(System.IO.File.ReadAllText(file)) : new UIKitProtected();
        }

        public string Reason(Transform t, string path)
        {
            var reasons = new List<string>();
            if (names.Contains(t.name)) reasons.Add($"found by name \"{t.name}\"");
            var hit = paths.FirstOrDefault(p => path == p || path.EndsWith("/" + p));
            if (hit != null) reasons.Add($"found by path \"{hit}\"");
            var iterating = t.GetComponents<Component>().Where(c => c != null && iterates.Contains(c.GetType().Name)).Select(c => c.GetType().Name).ToArray();
            if (iterating.Length > 0) reasons.Add($"children iterated by {string.Join(", ", iterating)}");
            return string.Join("; ", reasons);
        }

        /// <summary>True when code on this node walks its children by index: adding a child would change what it sees.</summary>
        public bool ChildrenIterated(Transform t) => t.GetComponents<Component>().Any(c => c != null && iterates.Contains(c.GetType().Name));
    }
}
