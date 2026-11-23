/**
 * Where to put the editor camera so a bench fills a gallery card.
 *
 * The card picture is a 16:10 crop out of the middle of the editor's canvas
 * (see galleryThumbnail.ts). Taken from wherever the camera happened to be,
 * that crop cut the parts off at the top of the card. This keeps the viewing
 * direction the user chose and works out the camera distance at which every
 * corner of the parts' box lands inside that crop — the perspective version of
 * the exact silhouette fit `benchThumbs.tsx` does for its orthographic forge.
 */
import * as THREE from "three";

export interface CardFrame {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/**
 * @param box          what must be visible (world space)
 * @param viewDir      direction the camera looks along (need not be unit)
 * @param up           camera up (Z-up in this app)
 * @param fovDeg       vertical field of view of the editor camera
 * @param canvasAspect width / height of the editor canvas
 * @param cardAspect   width / height of the card the frame is cropped to
 * @param margin       breathing room around the parts (1.1 = 10 %)
 */
export function frameBoxForCard(
  box: THREE.Box3,
  viewDir: THREE.Vector3,
  up: THREE.Vector3,
  fovDeg: number,
  canvasAspect: number,
  cardAspect: number,
  margin = 1.12,
): CardFrame {
  const target = box.getCenter(new THREE.Vector3());
  const forward = viewDir.clone().normalize();
  const right = new THREE.Vector3().crossVectors(forward, up);
  // Looking straight down, forward and up coincide; any horizontal right will do.
  if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
  right.normalize();
  const camUp = new THREE.Vector3().crossVectors(right, forward).normalize();

  // Half-angle tangents of the crop, not of the whole canvas: a canvas wider
  // than the card loses its sides to the crop, a taller one its top and bottom.
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const tanH = tanV * canvasAspect;
  const cropTanH = canvasAspect > cardAspect ? tanV * cardAspect : tanH;
  const cropTanV = canvasAspect > cardAspect ? tanV : tanH / cardAspect;

  // A corner at offset o from the target, seen from target - forward * d, sits
  // at depth d + o·forward; it is inside the crop when |o·right| and |o·camUp|
  // are within that depth times the tangents. The smallest d meeting this for
  // all eight corners is the snug fit.
  let distance = 1;
  const offset = new THREE.Vector3();
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        offset.set(x, y, z).sub(target);
        const along = offset.dot(forward);
        const needH = Math.abs(offset.dot(right)) * margin / cropTanH - along;
        const needV = Math.abs(offset.dot(camUp)) * margin / cropTanV - along;
        distance = Math.max(distance, needH, needV);
      }
    }
  }
  return {
    position: target.clone().addScaledVector(forward, -distance),
    target,
  };
}
