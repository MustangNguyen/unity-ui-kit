using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

namespace Mustang.UIKit.Editor
{
    /// <summary>
    /// UIKit/surfaces.json: the screens and popups of the game, each found by component type, path or prefab.
    /// Opens their scenes, isolates one surface, applies its fixture, and captures or inventories it.
    /// Scene changes made for a capture are always discarded (the scene is reloaded from disk).
    /// </summary>
    public static class UIKitSurfaces
    {
        [Serializable]
        public class Surface
        {
            public string name;
            public string scene;      // scene asset path, with component or path
            public string component;  // type name of a component on the root (first match, inactive included)
            public string path;       // hierarchy path from a scene root, e.g. "Canvas/Popups/Shop"
            public string prefab;     // or a prefab asset path
            public string show;       // "popup": also undo popup open-animation start states (scale 0, alpha 0)
            public bool center;       // always move the root to the canvas center (else only when it is parked off-screen)
            public string[] states;
        }

        [Serializable]
        class SurfaceFile
        {
            public Surface[] surfaces;
        }

        public static string FilePath => Path.Combine(UIKitConfig.KitDir, "surfaces.json");
        public static string InventoryDir => Path.Combine(UIKitConfig.KitDir, "inventory");
        public static string SurfaceCapturesDir => Path.Combine(UIKitConfig.CapturesDir, "surfaces");

        public static Surface[] Load()
        {
            if (!File.Exists(FilePath)) throw new FileNotFoundException($"[UIKit] Missing {FilePath}");
            var list = JsonUtility.FromJson<SurfaceFile>(File.ReadAllText(FilePath)).surfaces ?? Array.Empty<Surface>();
            foreach (var s in list)
                if (string.IsNullOrEmpty(s.name) || (string.IsNullOrEmpty(s.prefab) && string.IsNullOrEmpty(s.scene)))
                    throw new InvalidDataException($"[UIKit] surfaces.json: every surface needs a name and a scene or prefab ({s.name})");
            return list;
        }

        static IEnumerable<Surface> Select(string name)
        {
            var all = Load();
            if (string.IsNullOrEmpty(name)) return all;
            var picked = all.Where(s => s.name == name).ToArray();
            if (picked.Length == 0) throw new ArgumentException($"[UIKit] No surface named '{name}' in surfaces.json");
            return picked;
        }

        [MenuItem("Tools/UI Kit/Dump Inventory (all surfaces)")]
        static void DumpInventoryMenu() => DumpInventory();

        [MenuItem("Tools/UI Kit/Capture Surfaces")]
        static void CaptureMenu() => Capture();

        /// <summary>
        /// Baseline inventory: UIKit/inventory/&lt;surface&gt;.json, at the canvas scaler's reference resolution.
        /// This is the "before" the reskin map and the canvas are built from.
        /// </summary>
        public static int DumpInventory(string surface = null) =>
            Run(Select(surface), (s, state) => Shoot(s, state, inventoryOnly: true), defaultStateOnly: true);

        /// <summary>
        /// Captures each surface (and each listed state) at the reference resolution and every capture size:
        /// UIKit/captures/surfaces/&lt;surface[@state]&gt;/&lt;w&gt;x&lt;h&gt;.png, plus an inventory of the reference-size capture.
        /// </summary>
        public static int Capture(string surface = null, string state = null) =>
            Run(Select(surface), (s, st) => Shoot(s, st, inventoryOnly: false), defaultStateOnly: false, onlyState: state);

        /// <summary>Batch mode: -executeMethod Mustang.UIKit.Editor.UIKitSurfaces.FromCommandLine -uikitAction inventory|capture|reskin [-uikitSurface X] [-uikitState s] [-uikitDryRun]</summary>
        public static void FromCommandLine()
        {
            var args = Environment.GetCommandLineArgs();
            string Arg(string key)
            {
                var i = Array.IndexOf(args, key);
                return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
            }
            var surface = Arg("-uikitSurface");
            var failed = Arg("-uikitAction") switch
            {
                "inventory" => DumpInventory(surface),
                "capture" => Capture(surface, Arg("-uikitState")),
                "reskin" => UIReskin.Apply(surface, Array.IndexOf(args, "-uikitDryRun") >= 0),
                _ => throw new ArgumentException("[UIKit] -uikitAction must be inventory, capture or reskin"),
            };
            // A non-zero exit code lets scripts and agents see failures without reading the log.
            if (Application.isBatchMode) EditorApplication.Exit(failed > 0 ? 1 : 0);
        }

        delegate void SurfaceAction(Surface surface, string state);

        /// <summary>Runs the action per surface and state; returns how many failed (each failure is logged).</summary>
        static int Run(IEnumerable<Surface> surfaces, SurfaceAction action, bool defaultStateOnly, string onlyState = null)
        {
            EnsureNoUnsavedScenes();
            var setup = EditorSceneManager.GetSceneManagerSetup();
            var failed = 0;
            try
            {
                foreach (var surface in surfaces)
                {
                    var states = defaultStateOnly || surface.states == null || surface.states.Length == 0
                        ? new[] { "default" }
                        : surface.states;
                    foreach (var state in states)
                    {
                        if (onlyState != null && state != onlyState) continue;
                        try
                        {
                            action(surface, state);
                        }
                        catch (Exception e)
                        {
                            failed++;
                            Debug.LogError($"[UIKit] {surface.name}@{state}: {e.Message}\n{e.StackTrace}");
                        }
                    }
                }
            }
            finally
            {
                RestoreScenes(setup);
            }
            return failed;
        }

        /// <summary>
        /// Reopens the scenes the user had open, from disk. An empty scene first makes sure a scene that was
        /// changed for a capture (hidden siblings, fixture data) is reloaded rather than kept in memory.
        /// </summary>
        internal static void RestoreScenes(SceneSetup[] setup)
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            if (setup.Length > 0) EditorSceneManager.RestoreSceneManagerSetup(setup);
        }

        internal static void EnsureNoUnsavedScenes()
        {
            for (var i = 0; i < SceneManager.sceneCount; i++)
                if (SceneManager.GetSceneAt(i).isDirty)
                    throw new InvalidOperationException("[UIKit] Save or discard the open scenes first: surfaces are opened from disk and their temporary changes discarded");
        }

        /// <summary>
        /// Opens the surface fresh from disk and returns its root. A prefab is loaded as prefab contents for
        /// editing, but for rendering it is instantiated under a canvas in a new scene (preview scenes do not render canvases).
        /// </summary>
        internal static GameObject OpenRoot(Surface surface, out Action close, out Func<bool> save, bool forRendering = false)
        {
            if (!string.IsNullOrEmpty(surface.prefab) && forRendering)
            {
                var temp = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                var canvasGo = new GameObject("UIKitSurfaceCanvas", typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler));
                SceneManager.MoveGameObjectToScene(canvasGo, temp);
                var reference = UIKitConfig.Load().referenceResolution;
                var scaler = canvasGo.GetComponent<CanvasScaler>();
                scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
                scaler.referenceResolution = new Vector2(reference.width, reference.height);
                scaler.matchWidthOrHeight = 0.5f;
                var asset = AssetDatabase.LoadAssetAtPath<GameObject>(surface.prefab)
                    ?? throw new FileNotFoundException($"[UIKit] {surface.name}: prefab {surface.prefab} not found");
                var instance = (GameObject)PrefabUtility.InstantiatePrefab(asset, temp);
                instance.transform.SetParent(canvasGo.transform, false);
                canvasGo.layer = instance.layer;
                close = () => { };
                save = () => throw new InvalidOperationException("[UIKit] a rendering instance is never saved");
                return string.IsNullOrEmpty(surface.component) && string.IsNullOrEmpty(surface.path) ? instance : Locate(new[] { instance }, surface);
            }
            if (!string.IsNullOrEmpty(surface.prefab))
            {
                var contents = PrefabUtility.LoadPrefabContents(surface.prefab);
                var prefabRoot = string.IsNullOrEmpty(surface.component) && string.IsNullOrEmpty(surface.path)
                    ? contents
                    : Locate(new[] { contents }, surface);
                close = () => PrefabUtility.UnloadPrefabContents(contents);
                save = () =>
                {
                    PrefabUtility.SaveAsPrefabAsset(contents, surface.prefab, out var ok);
                    return ok;
                };
                return prefabRoot;
            }

            var scene = EditorSceneManager.OpenScene(surface.scene, OpenSceneMode.Single);
            close = () => { };
            save = () => EditorSceneManager.SaveScene(scene);
            return Locate(scene.GetRootGameObjects(), surface);
        }

        static GameObject Locate(GameObject[] roots, Surface surface)
        {
            if (!string.IsNullOrEmpty(surface.path))
            {
                var parts = surface.path.Split('/');
                var top = roots.FirstOrDefault(r => r.name == parts[0]);
                var found = top == null ? null : parts.Length == 1 ? top.transform : top.transform.Find(string.Join("/", parts.Skip(1)));
                if (found == null) throw new InvalidOperationException($"[UIKit] {surface.name}: path '{surface.path}' not found");
                return found.gameObject;
            }
            foreach (var root in roots)
            foreach (var component in root.GetComponentsInChildren<Component>(true))
                if (component != null && component.GetType().Name == surface.component)
                    return component.gameObject;
            throw new InvalidOperationException($"[UIKit] {surface.name}: no component '{surface.component}' found");
        }

        static void Shoot(Surface surface, string state, bool inventoryOnly)
        {
            var root = OpenRoot(surface, out var close, out _, forRendering: true);
            try
            {
                var canvas = PrepareForCapture(root, surface, state);
                var reference = ReferenceSize(canvas);
                var label = state == "default" ? surface.name : $"{surface.name}@{state}";

                if (inventoryOnly)
                {
                    Directory.CreateDirectory(InventoryDir);
                    var temp = Path.Combine(Path.GetTempPath(), $"uikit-inv-{Guid.NewGuid():N}");
                    UICapture.Render(new[] { canvas }, reference, Color.clear, temp, label,
                        cam => UIInventory.Write(root.transform, canvas, cam, reference, surface, Path.Combine(InventoryDir, surface.name + ".json")),
                        _ => Recenter(root.transform as RectTransform, (RectTransform)canvas.transform, surface.center));
                    File.Delete(temp + ".png");
                    File.Delete(temp + ".layout.json");
                    Debug.Log($"[UIKit] Inventory {surface.name}: {Path.Combine(InventoryDir, surface.name + ".json")}");
                    return;
                }

                var dir = Path.Combine(SurfaceCapturesDir, label);
                Directory.CreateDirectory(dir);
                var sizes = new List<Vector2Int> { reference };
                foreach (var s in UIKitConfig.Load().captureSizes)
                {
                    var size = new Vector2Int(s.width, s.height);
                    if (!sizes.Contains(size)) sizes.Add(size);
                }
                foreach (var size in sizes)
                {
                    var file = Path.Combine(dir, $"{size.x}x{size.y}");
                    var isReference = size == reference;
                    UICapture.Render(new[] { canvas }, size, Color.clear, file, label,
                        isReference ? cam => UIInventory.Write(root.transform, canvas, cam, size, surface, file + ".inventory.json") : null,
                        _ => Recenter(root.transform as RectTransform, (RectTransform)canvas.transform, surface.center));
                }
                Debug.Log($"[UIKit] Captured {label} to {dir}");
            }
            finally
            {
                close();
            }
        }

        /// <summary>
        /// Shows only this surface: activates it and its parents, hides their siblings, undoes open-animation
        /// start states, then runs the project's fixture. Returns the root canvas to render.
        /// </summary>
        static Canvas PrepareForCapture(GameObject root, Surface surface, string state)
        {
            var canvas = root.GetComponentInParent<Canvas>(true);
            if (canvas == null) throw new InvalidOperationException($"[UIKit] {surface.name}: not under a Canvas");
            canvas = canvas.rootCanvas;

            for (var t = root.transform; t != null && t != canvas.transform.parent; t = t.parent)
            {
                t.gameObject.SetActive(true);
                if (t.localScale == Vector3.zero) t.localScale = Vector3.one;
                if (t.TryGetComponent<CanvasGroup>(out var group)) group.alpha = 1f;
                if (t == canvas.transform || t.parent == null) continue;
                foreach (Transform sibling in t.parent)
                    if (sibling != t) sibling.gameObject.SetActive(false);
            }

            if (surface.show == "popup")
            {
                foreach (var t in root.GetComponentsInChildren<Transform>(true))
                    if (t.localScale == Vector3.zero) t.localScale = Vector3.one;
                foreach (var group in root.GetComponentsInChildren<CanvasGroup>(true))
                    if (group.alpha <= 0f) group.alpha = 1f;
            }

            var fixture = FindFixture(surface.name);
            if (fixture != null) fixture.Apply(root, state);
            else if (state != "default") Debug.LogWarning($"[UIKit] {surface.name}: state '{state}' but no IUIKitFixture for this surface");

            Canvas.ForceUpdateCanvases();
            return canvas;
        }

        /// <summary>
        /// Games often park closed screens and popups outside the visible area and slide them in on Show().
        /// Moves the root so its center is the canvas center when it lies outside the canvas (or always with "center").
        /// A root placed by its parent's LayoutGroup (a page in a horizontal pager) cannot be moved itself:
        /// the first ancestor the layout does not control is moved instead (usually the pager's content).
        /// </summary>
        static void Recenter(RectTransform root, RectTransform canvas, bool always)
        {
            if (root == null || root == canvas) return;
            var rootCenter = (Vector2)canvas.InverseTransformPoint(root.TransformPoint(root.rect.center));
            var bounds = canvas.rect;
            var rootRect = new Rect(rootCenter - root.rect.size / 2f, root.rect.size);
            if (!always && rootRect.Overlaps(bounds)) return;
            var offset = rootCenter - bounds.center;
            var world = canvas.TransformVector(offset);
            var mover = root;
            while (mover.parent is RectTransform parent && parent != canvas && parent.GetComponent<LayoutGroup>() != null)
                mover = parent;
            mover.position -= world;
        }

        static IUIKitFixture FindFixture(string surface)
        {
            foreach (var type in TypeCache.GetTypesDerivedFrom<IUIKitFixture>())
            {
                if (type.IsAbstract || type.GetConstructor(Type.EmptyTypes) == null) continue;
                var fixture = (IUIKitFixture)Activator.CreateInstance(type);
                if (fixture.Surface == surface) return fixture;
            }
            return null;
        }

        /// <summary>The CanvasScaler's reference resolution (the design size), else the uikit.json one.</summary>
        internal static Vector2Int ReferenceSize(Canvas canvas)
        {
            var scaler = canvas.GetComponent<CanvasScaler>();
            if (scaler != null && scaler.uiScaleMode == CanvasScaler.ScaleMode.ScaleWithScreenSize)
                return new Vector2Int(Mathf.RoundToInt(scaler.referenceResolution.x), Mathf.RoundToInt(scaler.referenceResolution.y));
            var config = UIKitConfig.Load().referenceResolution;
            return new Vector2Int(config.width, config.height);
        }
    }
}
