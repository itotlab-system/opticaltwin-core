/**
 * HTML cards floated into the 3D scene with drei's `<Html>` — today the beam-leg
 * editor — carry this class.
 *
 * They have to be marked because drei portals them into the very element R3F
 * listens on, so a click on a card still runs a raycast into the scene behind
 * it. Worse, R3F computes the pointer from `offsetX/offsetY`, which for a click
 * on the card is measured against the card, not the canvas — so the ray lands in
 * some unrelated corner of the viewport. Unguarded, touching a slider reads as a
 * click out in the world and closes the very card being used.
 */
export const OVERLAY_CLASS = "viewport-overlay";

/** True when a viewport pointer event actually landed on one of those cards. */
export function fromOverlay(target: EventTarget | null | undefined): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.(`.${OVERLAY_CLASS}`);
}
