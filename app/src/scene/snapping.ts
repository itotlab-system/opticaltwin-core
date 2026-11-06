// Snapping and camera-plane maths for dragging parts in the viewport.
import * as THREE from "three";

export const DEG = Math.PI / 180;
// How close a dragged part must come to a guide (a rod hole, a rod end) before
// it snaps onto it.
export const GUIDE_SNAP_MM = 2.5;
const CARDINAL_ROTATION_SNAP_DEG = 5;
// Rotation snaps to eighth turns, not quarter turns: 45° is the angle that
// folds a beam, and turning a mirror to it by eye was the step users missed.
const ROTATION_SNAP_STEP_DEG = 45;

/**
 * Return screen-right and camera-forward directions projected onto the
 * breadboard. OrbitControls keeps the camera Z-up, so these form an intuitive
 * camera-relative XY basis. Looking straight down makes forward degenerate;
 * in that case the camera's screen-up direction is the useful fallback.
 */
export function cameraPlaneBasis(camera: THREE.Camera | null) {
  if (!camera) {
    return {
      right: new THREE.Vector3(1, 0, 0),
      forward: new THREE.Vector3(0, 1, 0),
    };
  }

  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  right.z = 0;
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.z = 0;
  if (forward.lengthSq() < 1e-8) {
    forward.set(0, 1, 0).applyQuaternion(camera.quaternion);
    forward.z = 0;
  }
  if (forward.lengthSq() < 1e-8) forward.set(0, 1, 0);
  forward.normalize();

  return { right, forward };
}

/** Snap to 45° steps only inside the magnetic ±5° tolerance. */
export type RotationAxis = "X" | "Y" | "Z";

export function rotationAxis(axis: string): RotationAxis | null {
  return axis === "X" || axis === "Y" || axis === "Z" ? axis : null;
}

function snapCardinalAngle(angleRad: number): number | null {
  const angleDeg = angleRad / DEG;
  const nearest = Math.round(angleDeg / ROTATION_SNAP_STEP_DEG) * ROTATION_SNAP_STEP_DEG;
  return Math.abs(angleDeg - nearest) <= CARDINAL_ROTATION_SNAP_DEG
    ? nearest * DEG
    : null;
}

export function snapActiveRotation(object: THREE.Object3D, axis: RotationAxis | null) {
  if (!axis) return null;
  const current = axis === "X"
    ? object.rotation.x
    : axis === "Y" ? object.rotation.y : object.rotation.z;
  const snapped = snapCardinalAngle(current);
  if (snapped === null) return null;
  if (axis === "X") object.rotation.x = snapped;
  if (axis === "Y") object.rotation.y = snapped;
  if (axis === "Z") object.rotation.z = snapped;
  return snapped / DEG;
}
