/**
 * Where each callout's part currently sits *on screen*.
 *
 * The callout layer is an SVG sibling of the canvas, so it has no camera; the
 * projection has to come out of the R3F tree. It travels through this tiny
 * store rather than through React state because it changes every frame of an
 * orbit — re-rendering the whole layer 60 times a second to move two numbers
 * would make dragging the camera stutter with a dozen labels up. The projector
 * writes here, the layer subscribes and moves its own DOM nodes.
 */
import type { AnchorPoint } from "../callouts";

export class AnchorStore {
  readonly points: Record<string, AnchorPoint> = {};
  private subscribers = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  emit(): void {
    for (const fn of this.subscribers) fn();
  }
}
