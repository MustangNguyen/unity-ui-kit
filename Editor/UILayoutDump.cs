using System;
using System.Collections.Generic;
using System.IO;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Mustang.UIKit.Editor
{
    /// <summary>
    /// Flat list of every active RectTransform with its on-screen rect (pixels, origin top-left)
    /// and visual properties. `uikit compare` matches nodes by path to regions on the reference.
    /// </summary>
    public static class UILayoutDump
    {
        [Serializable]
        public class Node
        {
            public string path;
            public float x, y, width, height;
            public string color;
            public string sprite;
            public string text;
            public float fontSize;
            public float fontPixels;
            public string font;
            public string token;
        }

        [Serializable]
        class Dump
        {
            public string source;
            public int width, height;
            public List<Node> nodes = new();
        }

        public static void Write(IEnumerable<Canvas> canvases, Camera cam, Vector2Int size, string source, string path)
        {
            var dump = new Dump { source = source, width = size.x, height = size.y };
            var corners = new Vector3[4];
            foreach (var canvas in canvases)
            foreach (var rect in canvas.GetComponentsInChildren<RectTransform>(false))
            {
                rect.GetWorldCorners(corners);
                var min = new Vector2(float.MaxValue, float.MaxValue);
                var max = new Vector2(float.MinValue, float.MinValue);
                foreach (var corner in corners)
                {
                    var p = RectTransformUtility.WorldToScreenPoint(cam, corner);
                    min = Vector2.Min(min, p);
                    max = Vector2.Max(max, p);
                }

                var node = new Node
                {
                    path = PathOf(rect),
                    x = Round(min.x),
                    y = Round(size.y - max.y),
                    width = Round(max.x - min.x),
                    height = Round(max.y - min.y),
                };
                if (rect.TryGetComponent<Graphic>(out var graphic))
                {
                    node.color = "#" + ColorUtility.ToHtmlStringRGBA(graphic.color);
                    if (graphic is Image image && image.sprite != null) node.sprite = image.sprite.name;
                }
                if (rect.TryGetComponent<TMP_Text>(out var text))
                {
                    node.text = text.text;
                    node.fontSize = text.fontSize;
                    node.fontPixels = Round(text.fontSize * canvas.scaleFactor * rect.lossyScale.y / canvas.transform.lossyScale.y);
                    node.font = text.font != null ? text.font.name : null;
                }
                if (rect.TryGetComponent<ThemedGraphic>(out var themed)) node.token = themed.colorToken;
                dump.nodes.Add(node);
            }
            File.WriteAllText(path, JsonUtility.ToJson(dump, true));
        }

        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t != null; t = t.parent) parts.Add(t.name);
            parts.Reverse();
            return string.Join("/", parts);
        }

        static float Round(float v) => Mathf.Round(v * 10f) / 10f;
    }
}
