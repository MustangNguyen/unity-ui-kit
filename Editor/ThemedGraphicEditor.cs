using System;
using System.Linq;
using UnityEditor;

namespace Mustang.UIKit.Editor
{
    /// <summary>Color token as a dropdown of the theme's colors instead of a free text field.</summary>
    [CustomEditor(typeof(ThemedGraphic)), CanEditMultipleObjects]
    class ThemedGraphicEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            serializedObject.Update();
            var themeProperty = serializedObject.FindProperty(nameof(ThemedGraphic.theme));
            var tokenProperty = serializedObject.FindProperty(nameof(ThemedGraphic.colorToken));
            EditorGUILayout.PropertyField(themeProperty);

            var theme = themeProperty.objectReferenceValue as UITheme;
            var names = theme != null ? theme.ColorNames.OrderBy(n => n).ToArray() : Array.Empty<string>();
            if (names.Length == 0)
            {
                EditorGUILayout.PropertyField(tokenProperty);
            }
            else
            {
                var index = Array.IndexOf(names, tokenProperty.stringValue);
                EditorGUI.showMixedValue = tokenProperty.hasMultipleDifferentValues;
                var picked = EditorGUILayout.Popup("Color Token", index, names);
                EditorGUI.showMixedValue = false;
                if (picked != index && picked >= 0) tokenProperty.stringValue = names[picked];
            }
            serializedObject.ApplyModifiedProperties();
        }
    }
}
