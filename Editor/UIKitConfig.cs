using System;
using System.IO;
using UnityEngine;

namespace Mustang.UIKit.Editor
{
    /// <summary>UIKit/uikit.json at the project root, shared with the Node CLI.</summary>
    [Serializable]
    public class UIKitConfig
    {
        [Serializable]
        public class Size
        {
            public int width;
            public int height;
            public string label;
        }

        public Size referenceResolution = new() { width = 1080, height = 1920 };
        public Size[] captureSizes = { new() { width = 1080, height = 1920, label = "16x9" } };
        public string generatedDir = "Assets/UI/Generated";
        public string background = "#000000";

        public static string ProjectRoot => Path.GetDirectoryName(Application.dataPath);
        public static string KitDir => Path.Combine(ProjectRoot, "UIKit");
        public static string CapturesDir => Path.Combine(KitDir, "captures");

        public Color BackgroundColor => ColorUtility.TryParseHtmlString(background, out var color) ? color : Color.black;

        public static UIKitConfig Load()
        {
            var path = Path.Combine(KitDir, "uikit.json");
            var config = new UIKitConfig();
            if (File.Exists(path)) JsonUtility.FromJsonOverwrite(File.ReadAllText(path), config);
            return config;
        }
    }
}
