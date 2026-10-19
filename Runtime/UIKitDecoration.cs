using UnityEngine;

namespace Mustang.UIKit
{
    /// <summary>
    /// Marks a child added by the reskin engine (a ribbon, a glow, a frame). The engine updates it
    /// on the next run instead of adding a duplicate, and leaves every other node untouched.
    /// </summary>
    [DisallowMultipleComponent]
    public class UIKitDecoration : MonoBehaviour
    {
        [Tooltip("Decoration name from the reskin map.")]
        public string key;

        [Tooltip("Surface whose reskin map added it; only that surface updates or removes it.")]
        public string owner;
    }
}
