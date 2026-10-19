using System;
using System.Collections.Generic;
using System.IO;
using Mustang.UIKit;
using Mustang.UIKit.Editor;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;
using Object = UnityEngine.Object;

// Batch mode: -executeMethod UIKitSmokeTest.Run (or RunUrp). Exits 0 when every check passes.
// The test project path must not contain "~": Unity then hides package scripts and saved prefabs lose their MonoScripts.
public static class UIKitSmokeTest
{
    const string Generated = "Assets/UI/Generated/";
    static readonly List<string> Failures = new();

    // Same checks with URP active: -executeMethod UIKitSmokeTest.RunUrp
    public static void RunUrp()
    {
        var asset = UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset.Create(
            UnityEngine.Rendering.Universal.ScriptableRendererData.CreateInstance<UnityEngine.Rendering.Universal.UniversalRendererData>());
        UnityEngine.Rendering.GraphicsSettings.defaultRenderPipeline = asset;
        Debug.Log("[SMOKE] URP active: " + (UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline != null));
        Run();
    }

    // Waits a few editor updates first: right after startup in batch mode, components created by
    // script can serialize without their MonoScript (m_Script fileID 0), which breaks saved prefabs.
    // Same checks in Linear color space (captures un-premultiply differently there).
    public static void RunLinear()
    {
        PlayerSettings.colorSpace = ColorSpace.Linear;
        Debug.Log("[SMOKE] color space: " + PlayerSettings.colorSpace);
        Run();
    }

    public static void Run()
    {
        var frames = 0;
        void Tick()
        {
            if (++frames < 10) return;
            EditorApplication.update -= Tick;
            RunNow();
        }
        EditorApplication.update += Tick;
    }

    static void RunNow()
    {
        try { RunChecks(); }
        catch (Exception e) { Failures.Add("exception: " + e); }
        foreach (var f in Failures) Debug.LogError("[SMOKE] FAIL " + f);
        Debug.Log(Failures.Count == 0 ? "[SMOKE] ALL PASS" : $"[SMOKE] {Failures.Count} FAILED");
        EditorApplication.Exit(Failures.Count == 0 ? 0 : 1);
    }

    static void Check(bool ok, string what)
    {
        if (ok) Debug.Log("[SMOKE] ok " + what);
        else Failures.Add(what);
    }

    static void RunChecks()
    {
        // Importer: 9-slice border and PPU from _uikit_import.json.
        var importer = (TextureImporter)AssetImporter.GetAtPath(Generated + "btn_primary_normal.png");
        Check(importer.textureType == TextureImporterType.Sprite, "button imported as sprite");
        Check(importer.spriteBorder == new Vector4(27, 45, 27, 39), $"button border {importer.spriteBorder}");

        // Theme asset created next to ui-theme.json and readable.
        var theme = AssetDatabase.LoadAssetAtPath<UITheme>(Generated + "UITheme.asset");
        Check(theme != null, "UITheme.asset created by importer");
        if (theme == null) return;
        Check(theme.TryGetColor("bg", out var bg) && ColorUtility.ToHtmlStringRGB(bg) == "2B1B4A", "theme token bg = #2B1B4A");
        Check(Mathf.Approximately(theme.GetMetric("radius.md"), 26), "theme metric radius.md = 26");

        // Scene: overlay canvas scaled 1080x1920, themed background, sliced button at a known place.
        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        theme = AssetDatabase.LoadAssetAtPath<UITheme>(Generated + "UITheme.asset"); // NewScene unloads unused assets
        var canvasGo = new GameObject("Canvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        canvasGo.GetComponent<Canvas>().renderMode = RenderMode.ScreenSpaceOverlay;
        var scaler = canvasGo.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1080, 1920);
        scaler.matchWidthOrHeight = 0.5f;

        var background = NewImage("Background", canvasGo.transform, null);
        Stretch(background.rectTransform);
        var themed = background.gameObject.AddComponent<ThemedGraphic>();
        themed.theme = theme;
        themed.colorToken = "bg";
        themed.Apply();
        Check(ColorUtility.ToHtmlStringRGB(background.color) == "2B1B4A", $"ThemedGraphic applied bg color (got #{ColorUtility.ToHtmlStringRGB(background.color)})");

        var button = NewImage("PlayButton", canvasGo.transform, AssetDatabase.LoadAssetAtPath<Sprite>(Generated + "btn_primary_normal.png"));
        button.type = Image.Type.Sliced;
        var rect = button.rectTransform;
        rect.anchorMin = rect.anchorMax = new Vector2(0.5f, 0f);
        rect.pivot = new Vector2(0.5f, 0f);
        rect.sizeDelta = new Vector2(500, 170);
        rect.anchoredPosition = new Vector2(0, 330); // design rect x 290..790, y 1420..1590 from top

        Directory.CreateDirectory("Assets/Scenes");
        EditorSceneManager.SaveScene(scene, "Assets/Scenes/Home.unity");

        // Capture at every configured size, then read pixels back.
        var outDir = UICapture.CaptureOpenScene();
        Check(Directory.Exists(outDir), "capture folder " + outDir);
        foreach (var size in UIKitConfig.Load().captureSizes)
        {
            var png = Path.Combine(outDir, $"{size.width}x{size.height}.png");
            Check(File.Exists(png), "captured " + png);
            Check(File.Exists(png.Replace(".png", ".layout.json")), "layout dump for " + size.label);
        }

        var tex = new Texture2D(2, 2);
        tex.LoadImage(File.ReadAllBytes(Path.Combine(outDir, "1080x1920.png")));
        Check(tex.width == 1080 && tex.height == 1920, $"capture size {tex.width}x{tex.height}");
        var corner = tex.GetPixel(20, 1900); // PNG rows are bottom-up in Texture2D
        // ±2 per channel: Linear projects round-trip sRGB through 8-bit linear; a gamma error would be off by tens.
        Color32 bgPixel = corner;
        var bgOk = Mathf.Abs(bgPixel.r - 0x2B) <= 2 && Mathf.Abs(bgPixel.g - 0x1B) <= 2 && Mathf.Abs(bgPixel.b - 0x4A) <= 2;
        Check(bgOk, $"background pixel #{ColorUtility.ToHtmlStringRGB(corner)} (expect 2B1B4A ±2, checks gamma)");
        var face = tex.GetPixel(540, 1920 - 1480);
        Check(face.r > 0.9f && face.g > 0.5f && face.b < 0.4f, $"button face pixel #{ColorUtility.ToHtmlStringRGB(face)} is orange");

        var layout = File.ReadAllText(Path.Combine(outDir, "1080x1920.layout.json"));
        Check(layout.Contains("\"path\": \"Canvas/PlayButton\"") && layout.Contains("\"x\": 290.0") && layout.Contains("\"y\": 1420.0"),
            "layout dump has PlayButton at 290,1420");

        // Canvas settings restored after capture.
        Check(canvasGo.GetComponent<Canvas>().renderMode == RenderMode.ScreenSpaceOverlay && scaler.enabled, "canvas restored");

        // Prefab capture in a preview scene.
        Directory.CreateDirectory("Assets/UI/Prefabs");
        var prefab = PrefabUtility.SaveAsPrefabAsset(button.gameObject, "Assets/UI/Prefabs/PlayButton.prefab");
        var prefabPng = UICapture.CapturePrefab(prefab);
        var ptex = new Texture2D(2, 2);
        ptex.LoadImage(File.ReadAllBytes(prefabPng));
        Check(ptex.width == 564 && ptex.height == 234, $"prefab capture size {ptex.width}x{ptex.height} (expect 500+64 x 170+64)");
        Check(ptex.GetPixel(2, 2).a < 0.01f, "prefab capture background transparent");
        var prefabFace = ptex.GetPixel(ptex.width / 2, ptex.height / 2);
        Check(prefabFace.a > 0.9f && prefabFace.r > 0.9f && prefabFace.b < 0.4f, $"prefab capture shows the button (center #{ColorUtility.ToHtmlStringRGBA(prefabFace)})");

        // Prefab with its own Canvas on the UI layer still renders.
        var popupGo = new GameObject("Popup", typeof(RectTransform), typeof(Canvas));
        popupGo.layer = LayerMask.NameToLayer("UI");
        ((RectTransform)popupGo.transform).sizeDelta = new Vector2(200, 100);
        var popupImage = NewImage("Body", popupGo.transform, null);
        popupImage.gameObject.layer = popupGo.layer;
        Stretch(popupImage.rectTransform);
        popupImage.color = Color.red;
        var popup = PrefabUtility.SaveAsPrefabAsset(popupGo, "Assets/UI/Prefabs/Popup.prefab");
        Object.DestroyImmediate(popupGo);
        var popTex = new Texture2D(2, 2);
        popTex.LoadImage(File.ReadAllBytes(UICapture.CapturePrefab(popup)));
        var mid = popTex.GetPixel(popTex.width / 2, popTex.height / 2);
        Check(mid.r > 0.9f && mid.g < 0.1f, $"nested-canvas prefab on UI layer rendered (center #{ColorUtility.ToHtmlStringRGB(mid)})");

        // Semi-transparent pixels keep their color (captures are un-premultiplied).
        var ghostGo = new GameObject("Ghost", typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
        ((RectTransform)ghostGo.transform).sizeDelta = new Vector2(100, 100);
        ghostGo.GetComponent<Image>().color = new Color(0.5f, 0.5f, 0.5f, 0.5f); // mid-grey: wrong color-space math shows here
        var ghost = PrefabUtility.SaveAsPrefabAsset(ghostGo, "Assets/UI/Prefabs/Ghost.prefab");
        Object.DestroyImmediate(ghostGo);
        var ghostTex = new Texture2D(2, 2);
        ghostTex.LoadImage(File.ReadAllBytes(UICapture.CapturePrefab(ghost)));
        var g = ghostTex.GetPixel(ghostTex.width / 2, ghostTex.height / 2);
        Check(Mathf.Abs(g.r - 0.5f) < 0.03f && Mathf.Abs(g.a - 0.5f) < 0.03f, $"50% grey stays #808080 with alpha 0.5 (got #{ColorUtility.ToHtmlStringRGBA(g)})");

        // Border-only change in the manifest reimports the sprite.
        const string manifestPath = Generated + "_uikit_import.json";
        var original = File.ReadAllText(manifestPath);
        try
        {
            File.WriteAllText(manifestPath, System.Text.RegularExpressions.Regex.Replace(original,
                "(\"file\": \"bar_track.png\",\\s*\"border\": )\\[[^\\]]*\\]", "$1[5, 6, 7, 8]"));
            AssetDatabase.Refresh();
            var badge = (TextureImporter)AssetImporter.GetAtPath(Generated + "bar_track.png");
            Check(badge.spriteBorder == new Vector4(5, 6, 7, 8), $"border-only manifest change reimported sprite ({badge.spriteBorder})");
        }
        finally
        {
            File.WriteAllText(manifestPath, original);
            AssetDatabase.Refresh();
        }
    }

    static Image NewImage(string name, Transform parent, Sprite sprite)
    {
        var go = new GameObject(name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
        go.transform.SetParent(parent, false);
        var image = go.GetComponent<Image>();
        image.sprite = sprite;
        return image;
    }

    static void Stretch(RectTransform rect)
    {
        rect.anchorMin = Vector2.zero;
        rect.anchorMax = Vector2.one;
        rect.offsetMin = rect.offsetMax = Vector2.zero;
    }
}
