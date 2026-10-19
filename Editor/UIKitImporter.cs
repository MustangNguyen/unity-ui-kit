using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Mustang.UIKit.Editor
{
    /// <summary>
    /// Applies sprite settings written by `uikit gen` (_uikit_import.json next to the PNGs):
    /// sprite type, 9-slice border, pixels per unit. Also keeps a UITheme asset bound to ui-theme.json.
    /// </summary>
    class UIKitImporter : AssetPostprocessor
    {
        const string ImportManifest = "_uikit_import.json";
        const string ThemeFile = "ui-theme.json";

        [Serializable]
        class SpriteEntry
        {
            public string file;
            public float[] border; // left, bottom, right, top (pixels), same order as Vector4 spriteBorder
            public float pixelsPerUnit = 100f;
        }

        [Serializable]
        class Manifest
        {
            public SpriteEntry[] sprites;
        }

        void OnPreprocessTexture()
        {
            var manifestPath = Path.Combine(Path.GetDirectoryName(assetPath) ?? "", ImportManifest).Replace('\\', '/');
            if (!File.Exists(manifestPath)) return;
            // Reimport this texture whenever the manifest changes (borders can change while the PNG does not).
            context.DependsOnSourceAsset(manifestPath);

            var manifest = JsonUtility.FromJson<Manifest>(File.ReadAllText(manifestPath));
            var fileName = Path.GetFileName(assetPath);
            var entry = manifest.sprites?.FirstOrDefault(s => s.file == fileName);
            if (entry == null) return;

            var importer = (TextureImporter)assetImporter;
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.mipmapEnabled = false;
            importer.alphaIsTransparency = true;
            importer.wrapMode = TextureWrapMode.Clamp;
            importer.spritePixelsPerUnit = entry.pixelsPerUnit;
            if (entry.border is { Length: 4 })
                importer.spriteBorder = new Vector4(entry.border[0], entry.border[1], entry.border[2], entry.border[3]);
        }

        static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
        {
            foreach (var path in imported)
            {
                var fileName = Path.GetFileName(path);
                if (fileName == ImportManifest) ReimportListedSprites(path);
                else if (fileName == ThemeFile) SyncTheme(path);
            }
        }

        /// <summary>
        /// Textures imported before they recorded the manifest dependency would keep old borders,
        /// so force a reimport of every sprite the manifest lists.
        /// </summary>
        static void ReimportListedSprites(string manifestPath)
        {
            var folder = Path.GetDirectoryName(manifestPath)?.Replace('\\', '/');
            var manifest = JsonUtility.FromJson<Manifest>(File.ReadAllText(manifestPath));
            foreach (var sprite in manifest.sprites ?? Array.Empty<SpriteEntry>())
            {
                var path = $"{folder}/{sprite.file}";
                if (File.Exists(path)) AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
            }
        }

        /// <summary>Repairs theme bindings, e.g. after a UITheme.asset was deleted.</summary>
        [MenuItem("Tools/UI Kit/Sync Theme")]
        public static void SyncAllThemes()
        {
            foreach (var guid in AssetDatabase.FindAssets("ui-theme t:TextAsset"))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (Path.GetFileName(path) == ThemeFile) SyncTheme(path);
            }
        }

        static void SyncTheme(string jsonPath)
        {
            var json = AssetDatabase.LoadAssetAtPath<TextAsset>(jsonPath);
            if (json == null) return;
            var themes = AssetDatabase.FindAssets("t:UITheme")
                .Select(guid => AssetDatabase.LoadAssetAtPath<UITheme>(AssetDatabase.GUIDToAssetPath(guid)))
                .Where(theme => theme != null && theme.source == json)
                .ToList();

            if (themes.Count == 0)
            {
                var assetPath = Path.Combine(Path.GetDirectoryName(jsonPath) ?? "Assets", "UITheme.asset").Replace('\\', '/');
                var theme = AssetDatabase.LoadAssetAtPath<UITheme>(assetPath);
                if (theme != null)
                {
                    // ui-theme.json got a new GUID (deleted and regenerated): rebind instead of replacing the
                    // asset, so every ThemedGraphic that references UITheme.asset keeps working.
                    theme.source = json;
                    EditorUtility.SetDirty(theme);
                    AssetDatabase.SaveAssetIfDirty(theme);
                    Debug.Log($"[UIKit] Rebound {assetPath} to {jsonPath}");
                }
                else
                {
                    theme = ScriptableObject.CreateInstance<UITheme>();
                    theme.source = json;
                    AssetDatabase.CreateAsset(theme, AssetDatabase.GenerateUniqueAssetPath(assetPath));
                    Debug.Log($"[UIKit] Created {AssetDatabase.GetAssetPath(theme)}");
                }
                themes.Add(theme);
            }
            foreach (var theme in themes) theme.Reload();
        }
    }
}
