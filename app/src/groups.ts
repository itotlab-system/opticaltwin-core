// Pure helpers for PowerPoint-style component grouping (#114).
//
// A group is a flat set of component names moved and rotated as one rigid
// body. A component belongs to at most one group and groups never nest, so
// every lookup here is a simple scan — kept out of React so the selection and
// transform maths stay testable on their own.

import type { Component, ComponentGroup, ComponentUpdate } from "./types";
import * as THREE from "three";

const DEG = Math.PI / 180;

// Palette for new groups — distinct from the blue selection highlight so a
// group outline never reads as "this part is selected".
export const GROUP_COLORS = [
  "#f5a623", "#b06bff", "#2ec4b6", "#ff6b8b", "#7ed321", "#4fc3f7",
] as const;

export function groupOf(
  groups: ComponentGroup[],
  name: string | null,
): ComponentGroup | undefined {
  if (!name) return undefined;
  return groups.find((g) => g.members.includes(name));
}

export function groupById(
  groups: ComponentGroup[],
  id: string | null,
): ComponentGroup | undefined {
  if (!id) return undefined;
  return groups.find((g) => g.id === id);
}

/** Names the click should act on: the whole group, unless we're drilled into it. */
function clickTargets(
  groups: ComponentGroup[],
  name: string,
  enteredGroupId: string | null,
): string[] {
  const group = groupOf(groups, name);
  if (!group || group.id === enteredGroupId) return [name];
  return [...group.members];
}

/**
 * The selection after clicking `name`.
 *
 * Plain click replaces the selection; Ctrl/Cmd-click toggles. Either way the
 * unit is the whole group unless the user has drilled into it (double-click),
 * which matches how PowerPoint treats grouped shapes.
 */
export function resolveClick(
  groups: ComponentGroup[],
  selection: string[],
  name: string,
  opts: { additive: boolean; enteredGroupId: string | null },
): string[] {
  const targets = clickTargets(groups, name, opts.enteredGroupId);
  if (!opts.additive) return targets;

  const alreadyIn = targets.every((t) => selection.includes(t));
  if (alreadyIn) return selection.filter((s) => !targets.includes(s));
  return [...selection, ...targets.filter((t) => !selection.includes(t))];
}

/** Every group that any of the selected components belongs to. */
export function groupsCovering(
  groups: ComponentGroup[],
  selection: string[],
): ComponentGroup[] {
  return groups.filter((g) => g.members.some((m) => selection.includes(m)));
}

export function nextGroupName(groups: ComponentGroup[]): string {
  return `Group ${groups.length + 1}`;
}

export function nextGroupColor(groups: ComponentGroup[]): string {
  return GROUP_COLORS[groups.length % GROUP_COLORS.length];
}

export function createGroupId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `g-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Add a group over `members`, first removing them from any group they were in.
 * A group stripped down to a single member is dissolved: it would behave
 * exactly like the bare component and the UI offers no way to ungroup it.
 * Returns the new full list plus the group that was created.
 */
export function withNewGroup(
  groups: ComponentGroup[],
  members: string[],
): { groups: ComponentGroup[]; created: ComponentGroup } {
  const kept = groups
    .map((g) => ({ ...g, members: g.members.filter((m) => !members.includes(m)) }))
    .filter((g) => g.members.length > 1);
  const created: ComponentGroup = {
    id: createGroupId(),
    name: nextGroupName(groups),
    members: [...members],
    color: nextGroupColor(groups),
  };
  return { groups: [...kept, created], created };
}

/** Drop every group that overlaps `selection` (Ctrl+Shift+G). */
export function withoutGroups(
  groups: ComponentGroup[],
  selection: string[],
): ComponentGroup[] {
  const dissolved = new Set(groupsCovering(groups, selection).map((g) => g.id));
  return groups.filter((g) => !dissolved.has(g.id));
}

export interface Pivot {
  x: number;
  y: number;
  z: number;
  minZ: number;
}

export interface TransformDelta {
  dx: number;
  dy: number;
  dz: number;
  dRotX: number;
  dRotY: number;
  dRotZ: number;
}

/**
 * Rotation centre for a multi-selection: the centroid of the member positions.
 * `minZ` is the lowest member, so a drag downward can be clamped for the group
 * as a whole instead of flattening the lower parts onto the board.
 */
export function groupPivot(components: Component[], members: string[]): Pivot {
  const picked = components.filter((c) => members.includes(c.name));
  if (picked.length === 0) return { x: 0, y: 0, z: 0, minZ: 0 };
  const sum = picked.reduce(
    (acc, c) => ({ x: acc.x + c.x, y: acc.y + c.y, z: acc.z + c.z }),
    { x: 0, y: 0, z: 0 },
  );
  return {
    x: sum.x / picked.length,
    y: sum.y / picked.length,
    z: sum.z / picked.length,
    minZ: Math.min(...picked.map((c) => c.z)),
  };
}

/**
 * Apply a rigid-body XYZ rotation about `pivot`, followed by translation.
 * The same quaternion is pre-multiplied onto every member's orientation, so
 * relative positions and orientations remain rigid in all three dimensions.
 */
export function rigidTransform(
  components: Component[],
  members: string[],
  delta: TransformDelta,
  pivot: Pivot,
): ComponentUpdate[] {
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    delta.dRotX * DEG,
    delta.dRotY * DEG,
    delta.dRotZ * DEG,
    "XYZ",
  ));
  const hasRotation = Boolean(delta.dRotX || delta.dRotY || delta.dRotZ);
  const pivotPosition = new THREE.Vector3(pivot.x, pivot.y, pivot.z);

  return components
    .filter((c) => members.includes(c.name))
    .map((c) => {
      const position = new THREE.Vector3(c.x, c.y, c.z)
        .sub(pivotPosition)
        .applyQuaternion(rotation)
        .add(pivotPosition);
      const euler = hasRotation
        ? new THREE.Euler().setFromQuaternion(
            rotation.clone().multiply(
              new THREE.Quaternion().setFromEuler(new THREE.Euler(
                c.rotX * DEG,
                c.rotY * DEG,
                c.rotZ * DEG,
                "XYZ",
              )),
            ),
            "XYZ",
          )
        : null;
      return {
        name: c.name,
        x: position.x + delta.dx,
        y: position.y + delta.dy,
        z: position.z + delta.dz,
        rotX: euler ? euler.x / DEG : c.rotX,
        rotY: euler ? euler.y / DEG : c.rotY,
        rotZ: euler ? euler.z / DEG : c.rotZ,
      };
    });
}

/** Positions the editor sends to the server: 0.5 mm for x/y, 0.1 mm for height. */
export function roundUpdate(update: ComponentUpdate): ComponentUpdate {
  return {
    name: update.name,
    x: Math.round(update.x * 2) / 2,
    y: Math.round(update.y * 2) / 2,
    z: Math.round(update.z * 10) / 10,
    rotX: Math.round(update.rotX),
    rotY: Math.round(update.rotY),
    rotZ: Math.round(update.rotZ),
  };
}

export interface GroupBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Axis-aligned box around a group's members, padded so it clears the parts. */
export function groupBounds(
  components: Component[],
  members: string[],
  pad = 22,
): GroupBounds | null {
  const picked = components.filter((c) => members.includes(c.name));
  if (picked.length === 0) return null;
  const xs = picked.map((c) => c.x);
  const ys = picked.map((c) => c.y);
  const zs = picked.map((c) => c.z);
  return {
    min: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.min(...zs) - pad],
    max: [Math.max(...xs) + pad, Math.max(...ys) + pad, Math.max(...zs) + pad],
  };
}
