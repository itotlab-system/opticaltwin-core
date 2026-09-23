/**
 * Shapes a bench into the tree the Outliner shows.
 *
 * A bench is a line: the beam enters at one end and leaves at the other through
 * an ordered chain of optics, and that order is the model every lab member
 * already carries. The Outliner used to sort by x and then bucket by type,
 * which turns the real setup into "Cage 14 / Holder 7 / Post 7" — an asset
 * inventory, with the three lenses that matter outnumbered 4:1 by their own
 * scaffolding. This module derives the chain instead, from the beam the tracer
 * already computed server-side.
 *
 * Pure, like `groups.ts` and `callouts.ts`: no React, no fetching.
 */
import type { BeamSegment, Component } from "./types";

/** Types that hold optics rather than act on the beam. */
export const HARDWARE_TYPES = new Set(["mount", "holder", "post", "rod"]);

/**
 * How close a piece of hardware must sit to an optic, in mm, before we claim it
 * holds it, and how much nearer than the runner-up.
 *
 * There is no authored link from a holder to the optic it carries — only
 * holder↔post pairs — so attachment is positional, and positional attachment
 * has to be honest about its own limits. On the real lab bench a cage rod sits
 * 77 mm from the nearest optic with a 13 mm gap to the second nearest: any
 * threshold loose enough to adopt it files it under whichever lens happens to
 * be marginally closer. A part filed under the wrong optic is worse than a part
 * filed under nothing, so anything short of certain stays loose.
 */
const ATTACH_MAX_MM = 25;
const ATTACH_MARGIN_MM = 20;

export interface BeamNode {
  /** The optic itself. */
  component: Component;
  /** Mounting hardware confidently holding it, nearest first. */
  hardware: Component[];
}

export interface OutlinerTree {
  /** Optics in the order the beam reaches them. */
  chain: BeamNode[];
  /** Everything not on the beam and not confidently attached to an optic. */
  loose: Component[];
}

/** Names of the components the beam touches, in first-visit order.
 *
 *  First visit, not every visit: the 4f bench folds back through its
 *  beamsplitter, so `BSW10R` appears in four legs and must still be one row.
 */
export function beamOrder(beam: BeamSegment[]): string[] {
  const seen: string[] = [];
  const add = (name: string | null | undefined) => {
    if (!name || name === "*") return;
    if (!seen.includes(name)) seen.push(name);
  };
  for (const segment of beam) {
    add(segment.from);
    add(segment.to);
  }
  return seen;
}

const distanceXY = (a: Component, b: Component) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The optic a piece of hardware holds, or null when that cannot be told apart
 * from the optic beside it.
 */
function holderTarget(part: Component, optics: Component[]): Component | null {
  if (optics.length === 0) return null;
  const ranked = optics
    .map((optic) => ({ optic, distance: distanceXY(part, optic) }))
    .sort((left, right) => left.distance - right.distance);
  const [nearest, runnerUp] = ranked;
  if (nearest.distance > ATTACH_MAX_MM) return null;
  if (runnerUp && runnerUp.distance - nearest.distance < ATTACH_MARGIN_MM) {
    return null;
  }
  return nearest.optic;
}

/** Groups a bench into the beam chain plus whatever the beam never reaches. */
export function buildOutlinerTree(
  components: Component[],
  beam: BeamSegment[],
): OutlinerTree {
  const byName = new Map(components.map((c) => [c.name, c]));
  const isHardware = (c: Component) =>
    HARDWARE_TYPES.has(c.type.trim().toLowerCase());

  // The chain is the beam's own order; an optic the beam never reaches (a
  // switched-off laser, a part parked off to one side) still belongs at the
  // top level, appended in bench order rather than dropped.
  const ordered = beamOrder(beam)
    .map((name) => byName.get(name))
    .filter((c): c is Component => c != null && !isHardware(c));
  const trailing = components
    .filter((c) => !isHardware(c) && !ordered.includes(c))
    .sort((left, right) => left.x - right.x);
  const optics = [...ordered, ...trailing];

  const hardware = components.filter(isHardware);
  const attached = new Map<string, Component[]>();
  const claimed = new Set<string>();

  for (const part of hardware) {
    const target = holderTarget(part, optics);
    if (!target) continue;
    attached.set(target.name, [...(attached.get(target.name) ?? []), part]);
    claimed.add(part.name);
  }

  // A holder names its post outright. When one of a pair is confidently placed
  // the other belongs beside it, whatever the arithmetic says — they are bolted
  // together, and splitting them across two sections would be a worse answer
  // than either placement alone.
  for (const part of hardware) {
    if (claimed.has(part.name)) continue;
    const partnerName = part.attrs.pairedHolder ?? part.attrs.pairedPost;
    if (typeof partnerName !== "string") continue;
    const partner = byName.get(partnerName);
    if (!partner || !claimed.has(partner.name)) continue;
    for (const [opticName, parts] of attached) {
      if (!parts.includes(partner)) continue;
      attached.set(opticName, [...parts, part]);
      claimed.add(part.name);
      break;
    }
  }

  for (const [opticName, parts] of attached) {
    const optic = byName.get(opticName);
    if (!optic) continue;
    attached.set(
      opticName,
      [...parts].sort((left, right) =>
        distanceXY(left, optic) - distanceXY(right, optic)),
    );
  }

  return {
    chain: optics.map((component) => ({
      component,
      hardware: attached.get(component.name) ?? [],
    })),
    loose: hardware.filter((part) => !claimed.has(part.name)),
  };
}
