import type { MovePayload, ProjectData } from "./types";

// Attributes the server authors on the placement prim rather than in the
// component asset, and therefore the only ones a move can change. Mirrors
// PLACEMENT_ATTR_KEYS in server.py.
const PLACEMENT_ATTR_KEYS = [
  "pairedPost",
  "pairedHolder",
  "holderZOffset_mm",
  "laserOn",
] as const;

/**
 * Fold a move response into the scene the client already has.
 *
 * A move changes transforms and the beam, nothing else — so the server sends
 * only those (see `_move_payload`). Replacing `data` wholesale with a fresh
 * object, as the old `setData(updated)` did, gave every component and every
 * mesh a new identity, which made `UsdMesh`'s geometry `useMemo` rebuild all
 * of the BufferGeometry on every save. In hi mode that is ~790k vertices
 * re-uploaded after a drag that already looked finished.
 *
 * Merging keeps the mesh objects identical by reference, so the geometry memo
 * holds and only the moved parts' matrices change.
 */
export function mergeMove(prev: ProjectData, patch: MovePayload): ProjectData {
  const byName = new Map(patch.components.map((c) => [c.name, c]));

  const components = prev.components.map((c) => {
    const p = byName.get(c.name);
    if (!p) return c;

    // Untouched parts keep their identity, so their geometry memo survives.
    const moved =
      c.x !== p.x || c.y !== p.y || c.z !== p.z
      || c.rotX !== p.rotX || c.rotY !== p.rotY || c.rotZ !== p.rotZ;

    const attrs = { ...c.attrs };
    let attrsChanged = false;
    for (const key of PLACEMENT_ATTR_KEYS) {
      const next = p.attrs[key];
      if (next === undefined) {
        if (key in attrs) {
          delete attrs[key];
          attrsChanged = true;
        }
      } else if (attrs[key] !== next) {
        attrs[key] = next;
        attrsChanged = true;
      }
    }

    if (!moved && !attrsChanged) return c;

    return {
      ...c,
      x: p.x, y: p.y, z: p.z,
      rotX: p.rotX, rotY: p.rotY, rotZ: p.rotZ,
      ...(attrsChanged ? { attrs } : {}),
    };
  });

  return {
    ...prev,
    components,
    beam: patch.beam,
    canUndo: patch.canUndo,
    canRedo: patch.canRedo,
  };
}

/**
 * True when a component on screen is missing from the move response — the scene
 * has drifted (another user deleted or renamed a part) and merging would leave
 * a stale bench on screen. The caller refetches instead.
 *
 * Only checks that direction. The patch lists the components the *tracer* sees,
 * which is the `lo` set, and in `hi` mode the scene is a subset of it: the
 * server drops parts with no hi-res asset. So extra names in the patch are
 * normal and are ignored by the merge above. The cost is that a part another
 * user *added* does not appear until the next reload; a move never adds one.
 */
export function needsFullReload(prev: ProjectData, patch: MovePayload): boolean {
  const patched = new Set(patch.components.map((c) => c.name));
  return prev.components.some((c) => !patched.has(c.name));
}
