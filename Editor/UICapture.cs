using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;
using UnityEngine.UI;
using Object = UnityEngine.Object;

namespace Mustang.UIKit.Editor
{
    /// <summary>
    /// Renders screen-space canvases to PNG at fixed sizes in Edit mode (no Play mode, no Game view),
    /// and writes a layout dump next to each image. Canvas settings are restored afterwards.
    /// Output: UIKit/captures/&lt;scene&gt;/&lt;w&gt;x&lt;h&gt;.png + .layout.json, UIKit/captures/prefabs/&lt;name&gt;.png.
    /// </summary>
    public static class UICapture
    {
        const int PrefabPadding = 32;
        const float PlaneDistance = 100f;

        [MenuItem("Tools/UI Kit/Capture Open Scene")]
        static void CaptureOpenSceneMenu() => Debug.Log($"[UIKit] Captured to {CaptureOpenScene()}");

        [MenuItem("Assets/UI Kit/Capture Prefab", true)]
        static bool CapturePrefabValidate() => Selection.gameObjects.Any(PrefabUtility.IsPartOfPrefabAsset);

        [MenuItem("Assets/UI Kit/Capture Prefab")]
        static void CapturePrefabMenu()
        {
            foreach (var prefab in Selection.gameObjects.Where(PrefabUtility.IsPartOfPrefabAsset))
                Debug.Log($"[UIKit] Captured {CapturePrefab(prefab)}");
        }

        /// <summary>Captures the active scene at every size in uikit.json. Returns the output folder.</summary>
        public static string CaptureOpenScene(string outDir = null)
        {
            var config = UIKitConfig.Load();
            var scene = SceneManager.GetActiveScene();
            if (string.IsNullOrEmpty(scene.path))
                throw new InvalidOperationException("[UIKit] Save the scene first: captures are stored under the scene name");
            outDir ??= Path.Combine(UIKitConfig.CapturesDir, scene.name);
            Directory.CreateDirectory(outDir);

            var canvases = Object.FindObjectsByType<Canvas>(FindObjectsInactive.Exclude, FindObjectsSortMode.None)
                .Where(c => c.isRootCanvas && c.renderMode != RenderMode.WorldSpace && c.gameObject.scene == scene)
                .ToArray();
            if (canvases.Length == 0)
                throw new InvalidOperationException($"[UIKit] No screen-space canvas in scene '{scene.name}'");

            foreach (var size in config.captureSizes)
            {
                var file = Path.Combine(outDir, $"{size.width}x{size.height}");
                Render(canvases, new Vector2Int(size.width, size.height), config.BackgroundColor, file, scene.name);
            }
            return outDir;
        }

        /// <summary>
        /// Captures one UI prefab in a temporary additive scene (preview scenes do not render canvases). A stretched (full-screen) prefab uses the
        /// reference resolution; a fixed-size one is centered at 1:1 scale with padding. Returns the PNG path.
        /// </summary>
        public static string CapturePrefab(GameObject prefab, string outDir = null)
        {
            outDir ??= Path.Combine(UIKitConfig.CapturesDir, "prefabs");
            Directory.CreateDirectory(outDir);
            Scene temp;
            try
            {
                temp = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
            }
            catch (InvalidOperationException e)
            {
                throw new InvalidOperationException("[UIKit] Save the open scene first, then capture the prefab", e);
            }
            try
            {
                var canvasGo = new GameObject("UIKitCaptureCanvas", typeof(RectTransform), typeof(Canvas));
                SceneManager.MoveGameObjectToScene(canvasGo, temp);
                var canvas = canvasGo.GetComponent<Canvas>();
                canvas.renderMode = RenderMode.ScreenSpaceCamera;

                var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab, temp);
                instance.transform.SetParent(canvasGo.transform, false);
                canvasGo.layer = instance.layer;
                var size = PrefabCanvasSize(instance.transform as RectTransform);

                var file = Path.Combine(outDir, prefab.name);
                Render(new[] { canvas }, size, Color.clear, file, prefab.name);
                return file + ".png";
            }
            finally
            {
                EditorSceneManager.CloseScene(temp, true);
            }
        }

        /// <summary>Captures every prefab with a RectTransform under a folder, e.g. "Assets/UI/Prefabs".</summary>
        public static int CapturePrefabsIn(string folder)
        {
            var count = 0;
            var seen = new Dictionary<string, string>();
            foreach (var guid in AssetDatabase.FindAssets("t:Prefab", new[] { folder }))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (prefab.transform is not RectTransform) continue;
                if (seen.TryGetValue(prefab.name, out var other))
                    throw new InvalidOperationException($"[UIKit] Prefabs {other} and {path} share a name; captures would overwrite each other");
                seen[prefab.name] = path;
                CapturePrefab(prefab);
                count++;
            }
            return count;
        }

        /// <summary>
        /// Batch mode entry. Example:
        /// Unity -batchmode -projectPath . -executeMethod Mustang.UIKit.Editor.UICapture.CaptureFromCommandLine
        ///   -uikitScenes "Assets/Scenes/Home.unity;Assets/Scenes/Shop.unity" -uikitPrefabs Assets/UI/Prefabs -quit
        /// </summary>
        public static void CaptureFromCommandLine()
        {
            var args = Environment.GetCommandLineArgs();
            string Arg(string name)
            {
                var i = Array.IndexOf(args, name);
                return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
            }

            foreach (var scenePath in (Arg("-uikitScenes") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
            {
                EditorSceneManager.OpenScene(scenePath.Trim(), OpenSceneMode.Single);
                Debug.Log($"[UIKit] Captured {scenePath} to {CaptureOpenScene()}");
            }
            var prefabs = Arg("-uikitPrefabs");
            if (prefabs != null) Debug.Log($"[UIKit] Captured {CapturePrefabsIn(prefabs)} prefabs from {prefabs}");
        }

        static Vector2Int PrefabCanvasSize(RectTransform rect)
        {
            var reference = UIKitConfig.Load().referenceResolution;
            var fullScreen = new Vector2Int(reference.width, reference.height);
            if (rect == null || rect.anchorMin != rect.anchorMax) return fullScreen;

            LayoutRebuilder.ForceRebuildLayoutImmediate(rect);
            rect.anchorMin = rect.anchorMax = rect.pivot = new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = Vector2.zero;
            var size = rect.rect.size;
            if (size.x < 1 || size.y < 1) return fullScreen;
            return new Vector2Int(Mathf.CeilToInt(size.x) + PrefabPadding * 2, Mathf.CeilToInt(size.y) + PrefabPadding * 2);
        }

        /// <param name="beforeRender">Runs once the canvases have the capture size and layout, before drawing (e.g. to move a parked surface into view).</param>
        /// <param name="afterRender">Runs while the capture layout is still applied (camera, scale), e.g. to dump an inventory.</param>
        internal static void Render(Canvas[] canvases, Vector2Int size, Color background, string fileWithoutExtension, string source,
            Action<Camera> afterRender = null, Action<Camera> beforeRender = null)
        {
            RenderTexture rt = null;
            GameObject cameraGo = null;
            var states = new List<CanvasState>();
            try
            {
                rt = new RenderTexture(new RenderTextureDescriptor(size.x, size.y, GraphicsFormat.R8G8B8A8_SRGB, 24));
                cameraGo = new GameObject("UIKitCaptureCamera") { hideFlags = HideFlags.HideAndDontSave };
                // Far from scene content, with clip planes tight around the canvases, so only the UI is drawn.
                cameraGo.transform.position = new Vector3(0f, -100000f, 0f);

                var cam = cameraGo.AddComponent<Camera>();
                cam.enabled = false;
                cam.targetTexture = rt;
                cam.clearFlags = CameraClearFlags.SolidColor;
                cam.backgroundColor = background;
                cam.orthographic = true;
                cam.orthographicSize = size.y / 2f; // 1 world unit per pixel keeps precision at the far position
                cam.nearClipPlane = PlaneDistance - 50f;
                cam.farClipPlane = PlaneDistance + 50f;
                cam.cullingMask = canvases
                    .SelectMany(c => c.GetComponentsInChildren<Canvas>(true))
                    .Aggregate(0, (mask, c) => mask | 1 << c.gameObject.layer);

                foreach (var canvas in canvases)
                {
                    var state = new CanvasState(canvas);
                    states.Add(state);
                    state.Apply(cam, size);
                }

                // Two passes: the first resizes canvases for the new camera, the second settles layout groups and TMP.
                void Settle()
                {
                    for (var pass = 0; pass < 2; pass++)
                    {
                        Canvas.ForceUpdateCanvases();
                        foreach (var canvas in canvases) LayoutRebuilder.ForceRebuildLayoutImmediate((RectTransform)canvas.transform);
                    }
                    Canvas.ForceUpdateCanvases();
                }
                Settle();
                if (beforeRender != null)
                {
                    beforeRender(cam);
                    Settle();
                }

                RenderCamera(cam, rt);
                WritePng(rt, fileWithoutExtension + ".png");
                UILayoutDump.Write(canvases, cam, size, source, fileWithoutExtension + ".layout.json");
                afterRender?.Invoke(cam);
            }
            finally
            {
                for (var i = states.Count - 1; i >= 0; i--) states[i].Restore();
                if (cameraGo != null) Object.DestroyImmediate(cameraGo);
                if (rt != null)
                {
                    rt.Release();
                    Object.DestroyImmediate(rt);
                }
                Canvas.ForceUpdateCanvases();
            }
        }

        static void RenderCamera(Camera cam, RenderTexture rt)
        {
            var request = new RenderPipeline.StandardRequest { destination = rt };
            if (GraphicsSettings.currentRenderPipeline != null && RenderPipeline.SupportsRenderRequest(cam, request))
                RenderPipeline.SubmitRenderRequest(cam, request);
            else
                cam.Render();
        }

        /// <summary>
        /// UI shaders blend color with SrcAlpha over the cleared target, so semi-transparent pixels come out with
        /// premultiplied RGB. PNG and every comparison expect straight alpha: divide RGB by alpha.
        /// </summary>
        static void Unpremultiply(Texture2D texture)
        {
            // In a Linear project the blend happens on linear values and the target stores sRGB-encoded bytes:
            // decode, divide, encode. In Gamma space the bytes are the blended values themselves.
            var linear = PlayerSettings.colorSpace == ColorSpace.Linear;
            byte Fix(byte c, float a)
            {
                var v = c / 255f;
                v = linear ? Mathf.LinearToGammaSpace(Mathf.GammaToLinearSpace(v) / a) : v / a;
                return (byte)Mathf.Clamp(Mathf.RoundToInt(v * 255f), 0, 255);
            }
            var pixels = texture.GetPixels32();
            for (var i = 0; i < pixels.Length; i++)
            {
                var p = pixels[i];
                if (p.a == 0 || p.a == 255) continue;
                var a = p.a / 255f;
                pixels[i] = new Color32(Fix(p.r, a), Fix(p.g, a), Fix(p.b, a), p.a);
            }
            texture.SetPixels32(pixels);
        }

        static void WritePng(RenderTexture rt, string path)
        {
            var previous = RenderTexture.active;
            RenderTexture.active = rt;
            var texture = new Texture2D(rt.width, rt.height, TextureFormat.RGBA32, false);
            texture.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
            Unpremultiply(texture);
            texture.Apply();
            RenderTexture.active = previous;
            File.WriteAllBytes(path, texture.EncodeToPNG());
            Object.DestroyImmediate(texture);
        }

        /// <summary>
        /// Switches a canvas to camera space with the scale its CanvasScaler would use at the capture size,
        /// independent of the Game view size. Restore() puts every changed value back.
        /// </summary>
        readonly struct CanvasState
        {
            readonly Canvas _canvas;
            readonly RenderMode _mode;
            readonly Camera _camera;
            readonly float _planeDistance;
            readonly float _scaleFactor;
            readonly float _referencePixelsPerUnit;
            readonly CanvasScaler _scaler;
            readonly bool _scalerEnabled;

            public CanvasState(Canvas canvas)
            {
                _canvas = canvas;
                _mode = canvas.renderMode;
                _camera = canvas.worldCamera;
                _planeDistance = canvas.planeDistance;
                _scaleFactor = canvas.scaleFactor;
                _referencePixelsPerUnit = canvas.referencePixelsPerUnit;
                _scaler = canvas.GetComponent<CanvasScaler>();
                _scalerEnabled = _scaler != null && _scaler.enabled;
            }

            public void Apply(Camera cam, Vector2Int size)
            {
                var scale = ScaleFactor(_scaler, size, _canvas.scaleFactor);
                var ppu = _scaler != null ? _scaler.referencePixelsPerUnit : _canvas.referencePixelsPerUnit;
                if (_scaler != null) _scaler.enabled = false; // its OnDisable resets the canvas, so set values after

                _canvas.renderMode = RenderMode.ScreenSpaceCamera;
                _canvas.worldCamera = cam;
                _canvas.planeDistance = PlaneDistance;
                _canvas.scaleFactor = scale;
                _canvas.referencePixelsPerUnit = ppu;
            }

            public void Restore()
            {
                if (_canvas == null) return;
                _canvas.renderMode = _mode;
                _canvas.worldCamera = _camera;
                _canvas.planeDistance = _planeDistance;
                _canvas.scaleFactor = _scaleFactor;
                _canvas.referencePixelsPerUnit = _referencePixelsPerUnit;
                if (_scaler != null) _scaler.enabled = _scalerEnabled;
            }

            /// <summary>Same math as CanvasScaler, evaluated for the capture size instead of the screen.</summary>
            static float ScaleFactor(CanvasScaler scaler, Vector2Int size, float current)
            {
                if (scaler == null || !scaler.enabled) return current;
                switch (scaler.uiScaleMode)
                {
                    case CanvasScaler.ScaleMode.ConstantPixelSize:
                        return scaler.scaleFactor;
                    case CanvasScaler.ScaleMode.ScaleWithScreenSize:
                        var reference = scaler.referenceResolution;
                        switch (scaler.screenMatchMode)
                        {
                            case CanvasScaler.ScreenMatchMode.Expand:
                                return Mathf.Min(size.x / reference.x, size.y / reference.y);
                            case CanvasScaler.ScreenMatchMode.Shrink:
                                return Mathf.Max(size.x / reference.x, size.y / reference.y);
                            default:
                                var logWidth = Mathf.Log(size.x / reference.x, 2);
                                var logHeight = Mathf.Log(size.y / reference.y, 2);
                                return Mathf.Pow(2, Mathf.Lerp(logWidth, logHeight, scaler.matchWidthOrHeight));
                        }
                    default:
                        Debug.LogWarning("[UIKit] ConstantPhysicalSize canvas: captured at scale 1");
                        return 1f;
                }
            }
        }
    }
}
