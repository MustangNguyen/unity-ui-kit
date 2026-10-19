using UnityEngine;
using UnityEngine.UI;

namespace Mustang.UIKit
{
    /// <summary>
    /// Binds a Graphic (Image, RawImage, TMP text) color to a theme token,
    /// so a theme change recolors every bound element without touching prefabs.
    /// </summary>
    [ExecuteAlways, DisallowMultipleComponent, RequireComponent(typeof(Graphic))]
    public class ThemedGraphic : MonoBehaviour
    {
        public UITheme theme;
        public string colorToken;

        void OnEnable()
        {
            UITheme.Changed += OnThemeChanged;
            Apply();
        }

        void OnDisable() => UITheme.Changed -= OnThemeChanged;

        void OnValidate() => Apply();

        void OnThemeChanged(UITheme changed)
        {
            if (changed == theme) Apply();
        }

        public void Apply()
        {
            if (theme == null || !theme.TryGetColor(colorToken, out var color)) return;
            var graphic = GetComponent<Graphic>();
            if (graphic.color != color) graphic.color = color;
        }
    }
}
