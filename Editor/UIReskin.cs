using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;
using Object = UnityEngine.Object;

namespace Mustang.UIKit.Editor
{
    /// <summary>
    /// Applies UIKit/reskin/&lt;surface&gt;.json to the real scene or prefab, in place.
    /// It only changes properties (sprite, image type, color, text style, size, active) and may append
    /// decoration children. It never renames, reparents, reorders or deletes a game node, so DOTween targets,
    /// serialized references, Find-by-name lookups and particle setups keep working. A structure check
    /// runs after every surface; if any original node moved, or anything failed, nothing is saved.
    /// </summary>
    public static class UIReskin
    {
        [Serializable]
        class TextStyle
        {
            public string font;
            public float size;
            public string color;
            public string material;
        }

        [Serializable]
        class NodeChange
        {
            public string path;
            public string sprite;       // generated asset id, or an asset path ("Assets/...png", "path#spriteName")
            public string type;         // Simple | Sliced | Tiled | Filled
            public string color;        // theme token or #hex
            public float[] size;        // [w, h] design px; only on axes with equal anchors
            public float[] position;    // anchoredPosition [x, y] in the parent's local units; only on axes with equal anchors
            public string active;       // "true" | "false" | "" (unchanged)
            public string preserveAspect; // "true" | "false" | ""
            public float ppuMultiplier;   // Image.pixelsPerUnitMultiplier; > 0 to set (bigger = thinner borders, smaller tiles)
            public TextStyle text;
        }

        [Serializable]
        class Decoration
        {
            public string parent;       // node path; the decoration is appended as its last child
            public string name;
            public string sprite;
            public string type;
            public string color;
            public float[] rect;        // [x, y, w, h] from the parent's top-left, design px
        }

        [Serializable]
        class Map
        {
            public string surface;
            public NodeChange[] nodes;
            public Decoration[] add;
        }

        [Serializable]
        class Report
        {
            public string surface;
            public bool dryRun;
            public bool saved;
            public List<string> applied = new();
            public List<string> warnings = new();
            public List<string> errors = new();
        }

        public static string MapDir => Path.Combine(UIKitConfig.KitDir, "reskin");

        [MenuItem("Tools/UI Kit/Apply Reskin (all surfaces)")]
        static void ApplyMenu() => Apply();

        [MenuItem("Tools/UI Kit/Apply Reskin (dry run)")]
        static void DryRunMenu() => Apply(dryRun: true);

        /// <summary>Applies every map (or one surface's). Returns the number of surfaces that failed.</summary>
        public static int Apply(string surface = null, bool dryRun = false)
        {
            UIKitSurfaces.EnsureNoUnsavedScenes();
            var surfaces = UIKitSurfaces.Load().Where(s => surface == null || s.name == surface).ToArray();
            if (surface != null && surfaces.Length == 0) throw new ArgumentException($"[UIKit] No surface named '{surface}'");
            var setup = EditorSceneManager.GetSceneManagerSetup();
            var failed = 0;
            try
            {
                foreach (var s in surfaces)
                {
                    var mapPath = Path.Combine(MapDir, s.name + ".json");
                    if (!File.Exists(mapPath)) continue;
                    Report report;
                    try
                    {
                        report = ApplyOne(s, JsonUtility.FromJson<Map>(File.ReadAllText(mapPath)), dryRun);
                    }
                    catch (Exception e)
                    {
                        report = new Report { surface = s.name, dryRun = dryRun };
                        report.errors.Add(e.Message);
                    }
                    var reportPath = Path.Combine(UIKitConfig.KitDir, "reports", "reskin", s.name + ".json");
                    Directory.CreateDirectory(Path.GetDirectoryName(reportPath) ?? ".");
                    File.WriteAllText(reportPath, JsonUtility.ToJson(report, true));
                    var summary = $"[UIKit] Reskin {s.name}: {report.applied.Count} changes, {report.warnings.Count} warnings, {report.errors.Count} errors, " +
                        (report.saved ? "saved" : dryRun ? "dry run" : "NOT saved") + $" ({reportPath})";
                    if (report.errors.Count > 0)
                    {
                        failed++;
                        Debug.LogError(summary + "\n" + string.Join("\n", report.errors));
                    }
                    else Debug.Log(summary);
                }
            }
            finally
            {
                UIKitSurfaces.RestoreScenes(setup);
            }
            return failed;
        }

        static Report ApplyOne(UIKitSurfaces.Surface surface, Map map, bool dryRun)
        {
            var report = new Report { surface = surface.name, dryRun = dryRun };
            var root = UIKitSurfaces.OpenRoot(surface, out var close, out var save);
            try
            {
                var protection = UIKitProtected.Load();
                var theme = LoadTheme();
                var before = Snapshot(root.transform);

                foreach (var change in map.nodes ?? Array.Empty<NodeChange>())
                {
                    var node = Resolve(root.transform, change.path);
                    if (node == null)
                    {
                        report.errors.Add($"{change.path}: node not found");
                        continue;
                    }
                    try
                    {
                        ApplyChange(node, change, theme, report);
                    }
                    catch (Exception e)
                    {
                        report.errors.Add($"{change.path}: {e.Message}");
                    }
                }

                var keep = new HashSet<UIKitDecoration>();
                foreach (var deco in map.add ?? Array.Empty<Decoration>())
                {
                    try
                    {
                        keep.Add(AddDecoration(root.transform, surface.name, deco, theme, protection, report));
                    }
                    catch (Exception e)
                    {
                        report.errors.Add($"add {deco.parent}/{deco.name}: {e.Message}");
                    }
                }
                // Decorations this surface added that are no longer in its map are removed. Never another surface's,
                // and never one that comes from a prefab asset (it belongs to that prefab's own surface).
                var stales = root.GetComponentsInChildren<UIKitDecoration>(true)
                    .Where(d => !keep.Contains(d) && d.owner == surface.name)
                    .Where(d => !PrefabUtility.IsPartOfPrefabInstance(d.gameObject) || PrefabUtility.IsAddedGameObjectOverride(d.gameObject))
                    .ToArray();
                foreach (var stale in stales)
                {
                    report.applied.Add($"removed decoration {stale.key}");
                    Undo.DestroyObjectImmediate(stale.gameObject);
                }

                // Structure guard: every original node keeps its name, parent and sibling index.
                foreach (var problem in CompareStructure(before, root.transform)) report.errors.Add("structure: " + problem);

                if (report.errors.Count == 0 && !dryRun)
                {
                    if (save()) report.saved = true;
                    else report.errors.Add("saving failed (file read-only or locked?)");
                }
            }
            finally
            {
                close();
            }
            return report;
        }

        /// <summary>Path relative to the root, as written by the inventory ("" = root, "Item[1]" = second "Item").</summary>
        static Transform Resolve(Transform root, string path)
        {
            if (string.IsNullOrEmpty(path)) return root;
            var current = root;
            foreach (var segment in path.Split('/'))
            {
                var name = segment;
                var index = 0;
                var open = segment.LastIndexOf('[');
                if (open > 0 && segment.EndsWith("]") && int.TryParse(segment.Substring(open + 1, segment.Length - open - 2), out var n))
                {
                    name = segment.Substring(0, open);
                    index = n;
                }
                Transform match = null;
                var seen = 0;
                foreach (Transform child in current)
                {
                    if (child.name != name) continue;
                    if (seen++ == index)
                    {
                        match = child;
                        break;
                    }
                }
                if (match == null) return null;
                current = match;
            }
            return current;
        }

        /// <summary>Records an object before a change, so the change becomes a prefab override when the node is in a prefab instance.</summary>
        static void Record(Object target) => Undo.RecordObject(target, "UIKit reskin");

        static void Commit(Object target)
        {
            EditorUtility.SetDirty(target);
            if (PrefabUtility.IsPartOfPrefabInstance(target)) PrefabUtility.RecordPrefabInstancePropertyModifications(target);
        }

        static void ApplyChange(Transform node, NodeChange change, UITheme theme, Report report)
        {
            var rect = node as RectTransform;
            var image = node.GetComponent<Image>();

            if (!string.IsNullOrEmpty(change.sprite) || !string.IsNullOrEmpty(change.type) || !string.IsNullOrEmpty(change.preserveAspect) || change.ppuMultiplier > 0)
            {
                if (image == null) throw new InvalidOperationException("has no Image for \"sprite\"/\"type\"/\"preserveAspect\"/\"ppuMultiplier\"");
                Record(image);
                if (!string.IsNullOrEmpty(change.sprite))
                {
                    image.sprite = LoadSprite(change.sprite);
                    report.applied.Add($"{change.path}: sprite {change.sprite}");
                    if (string.IsNullOrEmpty(change.type) && image.sprite.border != Vector4.zero && image.type == Image.Type.Simple)
                    {
                        image.type = Image.Type.Sliced;
                        report.applied.Add($"{change.path}: type Sliced (sprite has a border)");
                    }
                }
                if (!string.IsNullOrEmpty(change.type))
                {
                    image.type = (Image.Type)Enum.Parse(typeof(Image.Type), change.type, true);
                    report.applied.Add($"{change.path}: type {change.type}");
                }
                if (!string.IsNullOrEmpty(change.preserveAspect)) image.preserveAspect = change.preserveAspect == "true";
                if (change.ppuMultiplier > 0)
                {
                    image.pixelsPerUnitMultiplier = change.ppuMultiplier;
                    report.applied.Add($"{change.path}: ppuMultiplier {change.ppuMultiplier}");
                }
                Commit(image);
            }

            if (!string.IsNullOrEmpty(change.color))
            {
                var graphic = node.GetComponent<Graphic>() ?? throw new InvalidOperationException("has no Graphic for \"color\"");
                SetColor(graphic, change.color, theme, report, change.path);
            }

            if (change.text != null && (!string.IsNullOrEmpty(change.text.font) || change.text.size > 0 || !string.IsNullOrEmpty(change.text.color) || !string.IsNullOrEmpty(change.text.material)))
            {
                var text = node.GetComponent<TMP_Text>() ?? throw new InvalidOperationException("has no TMP text for \"text\"");
                Record(text);
                if (!string.IsNullOrEmpty(change.text.font)) text.font = LoadFont(change.text.font);
                if (!string.IsNullOrEmpty(change.text.material)) text.fontSharedMaterial = LoadMaterial(change.text.material, text.font);
                if (change.text.size > 0)
                {
                    if (text.enableAutoSizing) text.fontSizeMax = change.text.size;
                    else text.fontSize = change.text.size;
                }
                Commit(text);
                if (!string.IsNullOrEmpty(change.text.color)) SetColor(text, change.text.color, theme, report, change.path);
                report.applied.Add($"{change.path}: text style");
            }

            if ((change.size is { Length: 2 } || change.position is { Length: 2 }) && rect != null)
            {
                Record(rect);
                if (change.size is { Length: 2 })
                {
                    // "size" is in design px, like the inventory rects: undo any scale between the node and the canvas.
                    var scale = DesignScale(rect);
                    var delta = rect.sizeDelta;
                    if (Mathf.Approximately(rect.anchorMin.x, rect.anchorMax.x)) delta.x = change.size[0] / scale.x;
                    else report.warnings.Add($"{change.path}: width ignored, anchors stretch on X");
                    if (Mathf.Approximately(rect.anchorMin.y, rect.anchorMax.y)) delta.y = change.size[1] / scale.y;
                    else report.warnings.Add($"{change.path}: height ignored, anchors stretch on Y");
                    rect.sizeDelta = delta;
                    report.applied.Add($"{change.path}: size {change.size[0]}x{change.size[1]}");
                }
                if (change.position is { Length: 2 })
                {
                    var pos = rect.anchoredPosition;
                    if (Mathf.Approximately(rect.anchorMin.x, rect.anchorMax.x)) pos.x = change.position[0];
                    if (Mathf.Approximately(rect.anchorMin.y, rect.anchorMax.y)) pos.y = change.position[1];
                    rect.anchoredPosition = pos;
                    report.applied.Add($"{change.path}: position {change.position[0]},{change.position[1]}");
                }
                Commit(rect);
            }

            if (!string.IsNullOrEmpty(change.active))
            {
                Record(node.gameObject);
                node.gameObject.SetActive(change.active == "true");
                Commit(node.gameObject);
                report.applied.Add($"{change.path}: active {change.active}");
                report.warnings.Add($"{change.path}: active state set; game code may still toggle it at runtime");
            }
        }

        /// <summary>
        /// Design px per local unit: the product of local scales from the node up to the root canvas.
        /// (The root canvas's own scale is driven and may be stored as 0, so it is left out.)
        /// </summary>
        static Vector2 DesignScale(RectTransform rect)
        {
            var canvas = rect.GetComponentInParent<Canvas>(true);
            var stop = canvas != null ? canvas.rootCanvas.transform : null;
            var s = Vector2.one;
            for (var t = (Transform)rect; t != null && t != stop; t = t.parent)
                s = Vector2.Scale(s, new Vector2(Mathf.Abs(t.localScale.x), Mathf.Abs(t.localScale.y)));
            if (!(s.x > 0f) || !(s.y > 0f) || float.IsInfinity(s.x) || float.IsInfinity(s.y))
                throw new InvalidOperationException($"node or a parent has scale 0 ({s}); cannot convert design px");
            return s;
        }

        static void SetColor(Graphic graphic, string value, UITheme theme, Report report, string path)
        {
            Record(graphic);
            if (value.StartsWith("#"))
            {
                if (!ColorUtility.TryParseHtmlString(value, out var color)) throw new FormatException($"bad color {value}");
                graphic.color = color;
                // A token binding would overwrite the hex color; remove it (recorded, so it works on prefab instances).
                if (graphic.TryGetComponent<ThemedGraphic>(out var stale)) Undo.DestroyObjectImmediate(stale);
            }
            else
            {
                if (theme == null) throw new InvalidOperationException($"color token \"{value}\" but no UITheme.asset in the generated folder (run uikit gen)");
                if (!theme.TryGetColor(value, out _)) throw new InvalidOperationException($"unknown color token \"{value}\"");
                var themed = graphic.GetComponent<ThemedGraphic>() ?? Undo.AddComponent<ThemedGraphic>(graphic.gameObject);
                Record(themed);
                themed.theme = theme;
                themed.colorToken = value;
                themed.Apply();
                Commit(themed);
            }
            Commit(graphic);
            report.applied.Add($"{path}: color {value}");
        }

        static UIKitDecoration AddDecoration(Transform root, string owner, Decoration deco, UITheme theme, UIKitProtected protection, Report report)
        {
            var parent = Resolve(root, deco.parent) ?? throw new InvalidOperationException("parent not found");
            if (protection.ChildrenIterated(parent)) throw new InvalidOperationException("game code iterates this node's children; a new child would change what it sees");
            var iterator = IteratorReferencing(root, parent, protection);
            if (iterator != null) throw new InvalidOperationException($"{iterator} references this node and walks children by index; a new child would change what it sees");
            if (parent.GetComponent<LayoutGroup>() != null) throw new InvalidOperationException("parent has a LayoutGroup; a new child would move its siblings");
            if (deco.rect is not { Length: 4 }) throw new InvalidOperationException("\"rect\" must be [x, y, w, h]");

            // Decorations made before owners were recorded (owner empty) are adopted by the surface that names them.
            var existing = parent.Cast<Transform>().Select(c => c.GetComponent<UIKitDecoration>())
                .FirstOrDefault(d => d != null && d.key == deco.name && (d.owner == owner || string.IsNullOrEmpty(d.owner)));
            GameObject go;
            if (existing != null)
            {
                go = existing.gameObject;
                if (existing.owner != owner)
                {
                    Record(existing);
                    existing.owner = owner;
                    Commit(existing);
                }
            }
            else
            {
                go = new GameObject("UIKit_" + deco.name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Image), typeof(UIKitDecoration));
                Undo.RegisterCreatedObjectUndo(go, "UIKit decoration");
                go.layer = parent.gameObject.layer;
                go.transform.SetParent(parent, false);
                go.transform.SetAsLastSibling();
                var marker = go.GetComponent<UIKitDecoration>();
                marker.key = deco.name;
                marker.owner = owner;
            }

            // rect is in design px from the parent's top-left; the child lives in the parent's local units.
            var rect = (RectTransform)go.transform;
            var scale = DesignScale((RectTransform)parent);
            Record(rect);
            rect.anchorMin = rect.anchorMax = rect.pivot = new Vector2(0f, 1f);
            rect.anchoredPosition = new Vector2(deco.rect[0] / scale.x, -deco.rect[1] / scale.y);
            rect.sizeDelta = new Vector2(deco.rect[2] / scale.x, deco.rect[3] / scale.y);
            Commit(rect);

            var image = go.GetComponent<Image>();
            Record(image);
            image.raycastTarget = false;
            if (!string.IsNullOrEmpty(deco.sprite)) image.sprite = LoadSprite(deco.sprite);
            image.type = !string.IsNullOrEmpty(deco.type)
                ? (Image.Type)Enum.Parse(typeof(Image.Type), deco.type, true)
                : image.sprite != null && image.sprite.border != Vector4.zero ? Image.Type.Sliced : Image.Type.Simple;
            Commit(image);
            if (!string.IsNullOrEmpty(deco.color)) SetColor(image, deco.color, theme, report, $"{deco.parent}/UIKit_{deco.name}");
            report.applied.Add($"{deco.parent}: decoration {deco.name}");
            return go.GetComponent<UIKitDecoration>();
        }

        /// <summary>
        /// A component of a class that walks children by index, holding a serialized reference to this node
        /// (e.g. a controller with [SerializeField] Transform content; content.GetChild(i)). Null when none.
        /// </summary>
        static string IteratorReferencing(Transform root, Transform node, UIKitProtected protection)
        {
            // The whole scene (or prefab contents): a manager on another root may hold the container.
            var scene = root.gameObject.scene;
            var roots = scene.IsValid() && scene.isLoaded ? scene.GetRootGameObjects() : new[] { root.root.gameObject };
            foreach (var component in roots.SelectMany(r => r.GetComponentsInChildren<MonoBehaviour>(true)))
            {
                if (component == null || !protection.iterates.Contains(component.GetType().Name)) continue;
                using var serialized = new SerializedObject(component);
                var property = serialized.GetIterator();
                while (property.Next(true))
                {
                    if (property.propertyType != SerializedPropertyType.ObjectReference) continue;
                    var value = property.objectReferenceValue;
                    if (value == node || value == node.gameObject || (value is Component c && c.transform == node))
                        return $"{component.GetType().Name}.{property.propertyPath}";
                }
            }
            return null;
        }

        static Sprite LoadSprite(string value)
        {
            string path, name = null;
            if (value.Contains('/'))
            {
                var hash = value.IndexOf('#');
                path = hash >= 0 ? value.Substring(0, hash) : value;
                if (hash >= 0) name = value.Substring(hash + 1);
            }
            else path = $"{UIKitConfig.Load().generatedDir}/{value}.png";
            var sprites = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Sprite>().ToArray();
            var sprite = name == null ? sprites.FirstOrDefault() : sprites.FirstOrDefault(s => s.name == name);
            return sprite ? sprite : throw new FileNotFoundException($"sprite \"{value}\" not found ({path})");
        }

        static TMP_FontAsset LoadFont(string value)
        {
            if (value.Contains('/'))
                return AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(value) ?? throw new FileNotFoundException($"font {value} not found");
            foreach (var guid in AssetDatabase.FindAssets($"{value} t:TMP_FontAsset"))
            {
                var font = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(AssetDatabase.GUIDToAssetPath(guid));
                if (font != null && font.name == value) return font;
            }
            throw new FileNotFoundException($"TMP font asset \"{value}\" not found");
        }

        static Material LoadMaterial(string value, TMP_FontAsset font)
        {
            if (value.Contains('/'))
                return AssetDatabase.LoadAssetAtPath<Material>(value) ?? throw new FileNotFoundException($"material {value} not found");
            foreach (var guid in AssetDatabase.FindAssets($"{value} t:Material"))
            {
                var material = AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(guid));
                if (material != null && material.name == value) return material;
            }
            throw new FileNotFoundException($"material \"{value}\" not found (font {font?.name})");
        }

        static UITheme LoadTheme() => AssetDatabase.LoadAssetAtPath<UITheme>($"{UIKitConfig.Load().generatedDir}/UITheme.asset");

        struct Entry
        {
            public string name;
            public Transform parent;
            public int sibling;
        }

        // Keyed by the Transform objects themselves (instance IDs are obsolete in newer Unity versions).
        static Dictionary<Transform, Entry> Snapshot(Transform root) =>
            root.GetComponentsInChildren<Transform>(true)
                .Where(t => t.GetComponentInParent<UIKitDecoration>(true) == null)
                .ToDictionary(t => t, t => new Entry { name = t.name, parent = t.parent, sibling = SiblingWithoutDecorations(t) });

        /// <summary>Sibling index ignoring decorations, so adding/removing decorations is not reported as a reorder.</summary>
        static int SiblingWithoutDecorations(Transform t)
        {
            if (t.parent == null) return t.GetSiblingIndex();
            var index = 0;
            foreach (Transform sibling in t.parent)
            {
                if (sibling == t) return index;
                if (sibling.GetComponent<UIKitDecoration>() == null) index++;
            }
            return index;
        }

        static IEnumerable<string> CompareStructure(Dictionary<Transform, Entry> before, Transform root)
        {
            var after = Snapshot(root);
            foreach (var (node, entry) in before)
            {
                if (node == null || !after.TryGetValue(node, out var now))
                {
                    yield return $"\"{entry.name}\" was removed";
                    continue;
                }
                if (now.name != entry.name) yield return $"\"{entry.name}\" was renamed to \"{now.name}\"";
                if (now.parent != entry.parent) yield return $"\"{entry.name}\" moved to another parent";
                if (now.sibling != entry.sibling) yield return $"\"{entry.name}\" changed order ({entry.sibling} -> {now.sibling})";
            }
        }
    }
}
