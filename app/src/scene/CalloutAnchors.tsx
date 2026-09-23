/**
 * Projects every callout's anchor point to screen pixels, once per frame.
 *
 * It reads the same `refs` map the gizmos use, so an anchor tracks a part
 * through a drag without waiting for the save to come back — the label stays
 * glued to the part while it is being moved.
 *
 * Keyed by **callout id**, not by part name: the anchor is a point on the part
 * chosen for that one label (`ax`/`ay`/`az` in the part's own frame), so two
 * labels on the same part would not share a projection.
 */
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Group } from "three";
import type { FigureCallout } from "../types";
import type { AnchorStore } from "./anchors";

const point = new THREE.Vector3();

export default function CalloutAnchors({
  store,
  callouts,
  refs,
}: {
  store: AnchorStore;
  callouts: FigureCallout[];
  refs: React.MutableRefObject<Record<string, Group | null>>;
}) {
  useFrame(({ camera, size }) => {
    let changed = false;
    const live = new Set<string>();
    for (const callout of callouts) {
      const object = refs.current[callout.target];
      if (!object) continue;
      live.add(callout.id);
      // The offset is in the part's local frame, so `localToWorld` carries the
      // dot through the part's own rotation and position.
      point.set(callout.ax ?? 0, callout.ay ?? 0, callout.az ?? 0);
      object.localToWorld(point);
      point.project(camera);
      // NDC -> CSS pixels. `size` is the canvas in CSS px, which is the
      // coordinate system the SVG overlay is laid out in, so the two agree
      // whatever the device pixel ratio is.
      const x = (point.x * 0.5 + 0.5) * size.width;
      const y = (-point.y * 0.5 + 0.5) * size.height;
      // z > 1 after projection means the point is behind the near plane; the
      // projection flips it to the opposite corner, so it must be skipped
      // rather than drawn.
      const behind = point.z > 1;
      const previous = store.points[callout.id];
      if (!previous
          || Math.abs(previous.x - x) > 0.05
          || Math.abs(previous.y - y) > 0.05
          || previous.behind !== behind) {
        store.points[callout.id] = { x, y, behind };
        changed = true;
      }
    }
    for (const id of Object.keys(store.points)) {
      if (!live.has(id)) {
        delete store.points[id];
        changed = true;
      }
    }
    if (changed) store.emit();
  });
  return null;
}
