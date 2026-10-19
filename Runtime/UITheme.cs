using System;
using System.Collections.Generic;
using UnityEngine;

namespace Mustang.UIKit
{
    /// <summary>
    /// Color and metric tokens read from the theme.json that `uikit gen` copies into the project.
    /// The JSON file stays the single source of truth; this asset only caches and serves it.
    /// </summary>
    [CreateAssetMenu(menuName = "UI Kit/Theme", fileName = "UITheme")]
    public class UITheme : ScriptableObject
    {
        [Serializable] class ColorToken { public string name; public string value; }
        [Serializable] class MetricToken { public string name; public float value; }
        [Serializable] class ThemeFile { public ColorToken[] colors; public MetricToken[] metrics; }

        [Tooltip("ui-theme.json written by `uikit gen`.")]
        public TextAsset source;

        readonly Dictionary<string, Color> _colors = new();
        readonly Dictionary<string, float> _metrics = new();
        bool _loaded;

        /// <summary>Raised after the theme file changes, so bound graphics can re-apply their tokens.</summary>
        public static event Action<UITheme> Changed;

        public IEnumerable<string> ColorNames
        {
            get { EnsureLoaded(); return _colors.Keys; }
        }

        void OnEnable() => _loaded = false;

        void OnValidate() => Reload();

        public void Reload()
        {
            _loaded = false;
            Changed?.Invoke(this);
        }

        public bool TryGetColor(string token, out Color color)
        {
            EnsureLoaded();
            color = default;
            return !string.IsNullOrEmpty(token) && _colors.TryGetValue(token, out color);
        }

        public float GetMetric(string token, float fallback = 0f)
        {
            EnsureLoaded();
            return token != null && _metrics.TryGetValue(token, out var value) ? value : fallback;
        }

        void EnsureLoaded()
        {
            if (_loaded) return;
            _loaded = true;
            _colors.Clear();
            _metrics.Clear();
            if (source == null) return;

            var file = JsonUtility.FromJson<ThemeFile>(source.text);
            foreach (var token in file.colors ?? Array.Empty<ColorToken>())
            {
                if (ColorUtility.TryParseHtmlString(token.value, out var color)) _colors[token.name] = color;
                else Debug.LogWarning($"[UIKit] {name}: color token '{token.name}' has invalid value '{token.value}'", this);
            }
            foreach (var token in file.metrics ?? Array.Empty<MetricToken>())
                _metrics[token.name] = token.value;
        }
    }
}
