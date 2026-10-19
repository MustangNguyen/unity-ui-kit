using UnityEngine;

namespace Mustang.UIKit
{
    /// <summary>
    /// Puts a surface into a known state with fake data before it is captured or inventoried in Edit mode,
    /// so the design canvas, the preview and the Unity capture all show the same content
    /// (same level, names, numbers). Implement one per surface in the game project, in any assembly;
    /// the kit finds it by <see cref="Surface"/>. Changes are discarded afterwards (the scene is reloaded).
    /// </summary>
    public interface IUIKitFixture
    {
        /// <summary>Surface name as written in UIKit/surfaces.json.</summary>
        string Surface { get; }

        /// <param name="root">The surface root.</param>
        /// <param name="state">State name from surfaces.json ("default" when none is given).</param>
        void Apply(GameObject root, string state);
    }
}
