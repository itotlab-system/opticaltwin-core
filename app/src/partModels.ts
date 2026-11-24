// Each catalogue part's model, fetched on demand and shared between the part
// browser's tile forge and the placement ghost.
//
// The project payload carries only every part's metadata (`libraryPreviews`):
// a part's one model is its full CAD mesh, up to ~1 MB, and the catalogue is
// 70-odd parts. So the geometry is fetched per part, when something is about
// to draw it. Picking a part in the browser and then placing it is the common
// path, so the ghost usually finds the part the forge just fetched.

import { api } from "./api";
import type { Component } from "./types";

// A few parts, not the catalogue: each is up to ~1 MB of vertex data, and
// beyond the part being drawn and the next one the cache is only guessing.
const LIMIT = 4;
const cache = new Map<string, Promise<Component>>();

/** The part's model, fetched once and held while it is among the last few used. */
export function partModel(asset: string): Promise<Component> {
  const held = cache.get(asset);
  if (held) {
    // Most recently used moves to the end, so eviction drops the oldest.
    cache.delete(asset);
    cache.set(asset, held);
    return held;
  }
  const loading = api.libraryPreview(asset).then((r) => r.component);
  cache.set(asset, loading);
  // A failed fetch must not stay cached: the next ask tries again.
  loading.catch(() => {
    if (cache.get(asset) === loading) cache.delete(asset);
  });
  while (cache.size > LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return loading;
}
