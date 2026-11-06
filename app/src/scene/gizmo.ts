import type { ElementRef, MutableRefObject } from "react";
import type { TransformControls } from "@react-three/drei";
import type * as THREE from "three";

export type GizmoControl = ElementRef<typeof TransformControls>;
export type GizmoRef = MutableRefObject<GizmoControl | null>;

/**
 * TransformControls includes two axis-free rotation handles by default:
 * `E` (screen-space rotation) and `XYZE` (free/trackball rotation). Remove
 * both their visible geometry and invisible pickers, leaving only X/Y/Z.
 */
export function removeAxisFreeRotationHandles(control: GizmoControl | null) {
  if (!control) return;

  // TransformControls keeps the visible handles and raycast pickers in
  // private-but-runtime-accessible maps. Target the rotate containers
  // directly so removal does not depend on scene traversal timing.
  const internals = control as unknown as {
    gizmo?: {
      gizmo?: Record<string, THREE.Object3D>;
      picker?: Record<string, THREE.Object3D>;
    };
    axis?: string | null;
  };
  const rotateContainers = [
    internals.gizmo?.gizmo?.rotate,
    internals.gizmo?.picker?.rotate,
  ];
  for (const container of rotateContainers) {
    if (!container) continue;
    for (const handle of [...container.children]) {
      if (handle.name === "E" || handle.name === "XYZE") {
        container.remove(handle);
      }
    }
  }

  // A control must never retain an axis-free hover left over from the frame
  // before the handles were removed.
  if (internals.axis === "E" || internals.axis === "XYZE") internals.axis = null;
}
