// Where a dragged rod or cage mount should snap so that rods seat in mount
// holes and rod ends meet plates. Pure geometry on the component list; the
// viewport calls the three nearest* functions while a part is dragged.
import * as THREE from "three";
import type { Component } from "../types";
import { DEG, GUIDE_SNAP_MM } from "./snapping";

const ROD_MOUNT_EXACT_TOLERANCE_MM = 0.25;
const ROD_MOUNT_ANGLE_TOLERANCE_DEG = 3;
const ROD_ALIGNMENT_HALF_LENGTH_MM = 60;

type RodMountAlignment = {
  rootY: number;
  rootZ: number;
  guideY: number;
  guideZ: number;
};

type RodEndAlignment = RodMountAlignment & {
  rootX: number;
  guideX: number;
};

const isRod = (component: Component): boolean =>
  component.asset?.toLowerCase().startsWith("rod/") ?? false;

const isLcp35Mount = (component: Component): boolean =>
  component.asset?.toLowerCase().includes("lcp35_m-step") ?? false;

const rodMountAxesAligned = (
  rodRotZ: number,
  mountRotZ: number,
): boolean => {
  // A rod can enter either face, so rotations that differ by 180° are also
  // perpendicular to the mount side.
  const difference = Math.abs(
    ((rodRotZ - mountRotZ + 90) % 180 + 180) % 180 - 90,
  );
  return difference <= ROD_MOUNT_ANGLE_TOLERANCE_DEG;
};

type RodMountContact = {
  point: THREE.Vector3;
  normal: THREE.Vector3;
};

type RodHoleAxis = {
  point: THREE.Vector3;
  direction: THREE.Vector3;
  transverseY: THREE.Vector3;
  transverseZ: THREE.Vector3;
};

export type RodAlignmentState = {
  start: [number, number, number];
  end: [number, number, number];
  kind: "board" | "coordinate" | "center" | "endContact" | "combined";
};

const componentEuler = (
  component: Pick<Component, "rotX" | "rotY" | "rotZ">,
  rotZ = component.rotZ,
): THREE.Euler => new THREE.Euler(
  component.rotX * DEG,
  component.rotY * DEG,
  rotZ * DEG,
  "XYZ",
);

const componentQuaternion = (
  component: Pick<
    Component,
    "rotX" | "rotY" | "rotZ" | "modelRotation"
  >,
  rotZ = component.rotZ,
): THREE.Quaternion => {
  const placement = new THREE.Quaternion().setFromEuler(
    componentEuler(component, rotZ),
  );
  const model = component.modelRotation ?? [0, 0, 0];
  const modelRotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      model[0] * DEG,
      model[1] * DEG,
      model[2] * DEG,
      "XYZ",
    ),
  );
  // Component3D nests the model rotation inside the placement rotation.
  return placement.multiply(modelRotation);
};

const rodAxis = (
  rod: Component,
  rotZ = rod.rotZ,
): THREE.Vector3 => new THREE.Vector3(1, 0, 0)
  .applyQuaternion(componentQuaternion(rod, rotZ))
  .normalize();

const rodPerpendicularToFace = (
  axis: THREE.Vector3,
  normal: THREE.Vector3,
): boolean => Math.abs(axis.dot(normal))
  >= Math.cos(ROD_MOUNT_ANGLE_TOLERANCE_DEG * DEG);

const rodHoleOffsets = (component: Component): [number, number, number][] => {
  const value = component.attrs.rodHoleOffsets_mm;
  if (typeof value !== "string") return [];
  try {
    const offsets = JSON.parse(value);
    return Array.isArray(offsets)
      ? offsets.filter(
        (offset): offset is [number, number, number] =>
          Array.isArray(offset)
          && offset.length === 3
          && offset.every((coordinate) => typeof coordinate === "number"),
      )
      : [];
  } catch {
    return [];
  }
};

const rodContactPoints = (
  component: Component,
): [number, number, number][] => {
  const value = component.attrs.rodContactPoints_mm;
  if (typeof value !== "string") return [];
  try {
    const offsets = JSON.parse(value);
    return Array.isArray(offsets)
      ? offsets.filter(
        (offset): offset is [number, number, number] =>
          Array.isArray(offset)
          && offset.length === 3
          && offset.every((coordinate) => typeof coordinate === "number"),
      )
      : [];
  } catch {
    return [];
  }
};

const worldRodHoles = (
  mount: Component,
  x = mount.x,
  y = mount.y,
  z = mount.z,
  rotZ = mount.rotZ,
): [number, number, number][] => {
  const angle = rotZ * DEG;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return rodHoleOffsets(mount).map(([dx, dy, dz]) => [
    x + dx * cosine - dy * sine,
    y + dx * sine + dy * cosine,
    z + dz,
  ]);
};

const worldRodHoleAxes = (
  mount: Component,
  x = mount.x,
  y = mount.y,
  z = mount.z,
  rotZ = mount.rotZ,
): RodHoleAxis[] => {
  const rotation = componentQuaternion(mount, rotZ);
  const origin = new THREE.Vector3(x, y, z);
  const direction = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(rotation)
    .normalize();
  const transverseY = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(rotation)
    .normalize();
  const transverseZ = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(rotation)
    .normalize();
  return rodHoleOffsets(mount).map(([dx, dy, dz]) => ({
    point: new THREE.Vector3(dx, dy, dz)
      .applyQuaternion(rotation)
      .add(origin),
    direction: direction.clone(),
    transverseY: transverseY.clone(),
    transverseZ: transverseZ.clone(),
  }));
};

const rodEnds = (
  rod: Component,
  x = rod.x,
  y = rod.y,
  z = rod.z,
  rotZ = rod.rotZ,
): [number, number, number][] => {
  const minimum = rod.attrs.rodEndMinX_mm;
  const maximum = rod.attrs.rodEndMaxX_mm;
  if (typeof minimum !== "number" || typeof maximum !== "number") return [];
  const angle = rotZ * DEG;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [minimum, maximum].map((offset) => [
    x + offset * cosine,
    y + offset * sine,
    z,
  ]);
};

const localRodMountContacts = (
  component: Component,
): RodMountContact[] => {
  const authored = rodContactPoints(component);
  if (!authored.length) return [];

  // CM1-DCH has four corner holes on each of its four vertical faces. Existing
  // metadata describes the ±X faces; their dimensions also define ±Y faces.
  if (component.asset?.toLowerCase().includes("cm1-dch_m-step")) {
    const face = Math.max(...authored.map(([x]) => Math.abs(x)));
    const corner = Math.max(...authored.map(([, y]) => Math.abs(y)));
    const model = component.modelRotation ?? [0, 0, 0];
    const modelQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        model[0] * DEG,
        model[1] * DEG,
        model[2] * DEG,
        "XYZ",
      ),
    );
    const axes = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
    ];
    // Select the two local axes whose model-rotated normals are horizontal.
    // Their ± directions are the four side faces; the remaining axis is top
    // and bottom. CM1-DCH's authored rotateX=90° therefore selects X and Z.
    const sideAxes = [0, 1, 2]
      .sort((left, right) =>
        Math.abs(axes[left].clone().applyQuaternion(modelQuaternion).z)
        - Math.abs(axes[right].clone().applyQuaternion(modelQuaternion).z),
      )
      .slice(0, 2);
    const contacts: RodMountContact[] = [];
    for (const normalAxis of sideAxes) {
      const tangentAxes = [0, 1, 2].filter((axis) => axis !== normalAxis);
      for (const sign of [-1, 1]) {
        for (const first of [-1, 1]) {
          for (const second of [-1, 1]) {
            const coordinates = [0, 0, 0];
            coordinates[normalAxis] = sign * face;
            coordinates[tangentAxes[0]] = first * corner;
            coordinates[tangentAxes[1]] = second * corner;
            const normal = new THREE.Vector3();
            normal.setComponent(normalAxis, sign);
            contacts.push({
              point: new THREE.Vector3(
                coordinates[0], coordinates[1], coordinates[2],
              ),
              normal,
            });
          }
        }
      }
    }
    return contacts;
  }

  return authored.map(([x, y, z]) => ({
    point: new THREE.Vector3(x, y, z),
    normal: new THREE.Vector3(Math.sign(x) || 1, 0, 0),
  }));
};

const worldRodMountContacts = (
  component: Component,
  x = component.x,
  y = component.y,
  z = component.z,
  rotZ = component.rotZ,
): RodMountContact[] => {
  const rotation = componentQuaternion(component, rotZ);
  const origin = new THREE.Vector3(x, y, z);
  return localRodMountContacts(component).map(({ point, normal }) => ({
    point: point.clone().applyQuaternion(rotation).add(origin),
    normal: normal.clone().applyQuaternion(rotation).normalize(),
  }));
};

const rodLoEndOffsets = (rod: Component): number[] => {
  const minimum = rod.attrs.rodLoEndMinX_mm;
  const maximum = rod.attrs.rodLoEndMaxX_mm;
  return typeof minimum === "number" && typeof maximum === "number"
    ? [minimum, maximum]
    : [];
};

const mountPlateEndAlignments = (
  rod: Component,
  rodPosition: THREE.Vector3,
  rodRotZ: number,
  mount: Component,
  mountPosition: THREE.Vector3,
  mountRotZ: number,
): RodAlignmentState[] => {
  if (!mount.asset?.toLowerCase().includes("cm1-dch_m-step")) return [];

  const mountRotation = componentQuaternion(mount, mountRotZ);
  const inverseMountRotation = mountRotation.clone().invert();
  const axis = rodAxis(rod, rodRotZ);
  const model = mount.modelRotation ?? [0, 0, 0];
  const modelRotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      model[0] * DEG, model[1] * DEG, model[2] * DEG, "XYZ",
    ),
  );
  const localAxes = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  const sideAxes = [0, 1, 2]
    .sort((left, right) =>
      Math.abs(localAxes[left].clone().applyQuaternion(modelRotation).z)
      - Math.abs(localAxes[right].clone().applyQuaternion(modelRotation).z),
    )
    .slice(0, 2);
  const verticalAxis = [0, 1, 2].find(
    (index) => !sideAxes.includes(index),
  )!;
  const mountContacts = localRodMountContacts(mount);
  const results: RodAlignmentState[] = [];

  // Test both Rod ends against both signs of every vertical side axis. This
  // keeps the contact rule symmetric for the near/opposite housing faces.
  for (const endOffset of rodLoEndOffsets(rod)) {
    const endpoint = rodPosition.clone().addScaledVector(axis, endOffset);
    const localEndpoint = endpoint.clone()
      .sub(mountPosition)
      .applyQuaternion(inverseMountRotation);
    for (const plateSign of [-1, 1]) {
      for (const normalAxis of sideAxes) {
        const tangentAxis = sideAxes.find(
          (index) => index !== normalAxis,
        )!;
        const faceOffset = Math.max(
          ...mountContacts.map(({ point }) =>
            Math.abs(point.getComponent(normalAxis))),
        );
        for (const faceSign of [-1, 1]) {
          const localNormal = localAxes[normalAxis].clone()
            .multiplyScalar(faceSign);
          const worldNormal = localNormal.clone()
            .applyQuaternion(mountRotation)
            .normalize();
          if (!rodPerpendicularToFace(axis, worldNormal)) continue;

          // The saved matsu2 pose is the reference relationship: the lo Rod
          // endpoint meets the actual housing face. Apply that same
          // face-relative relationship for every side and world orientation.
          const plane = faceSign * faceOffset;
          const touchesPlane = Math.abs(
            localEndpoint.getComponent(normalAxis) - plane,
          ) <= ROD_MOUNT_EXACT_TOLERANCE_MM;
          const insidePlateThickness = Math.abs(
            localEndpoint.getComponent(verticalAxis) - plateSign * 15,
          ) <= 3;
          const insidePlateWidth = Math.abs(
            localEndpoint.getComponent(tangentAxis),
          ) <= faceOffset;
          if (!touchesPlane || !insidePlateThickness || !insidePlateWidth) {
            continue;
          }

          const localContact = localEndpoint.clone();
          localContact.setComponent(normalAxis, plane);
          const contact = localContact.applyQuaternion(mountRotation)
            .add(mountPosition);
          const start = contact.clone().addScaledVector(
            worldNormal, -ROD_ALIGNMENT_HALF_LENGTH_MM,
          );
          const end = contact.clone().addScaledVector(
            worldNormal, ROD_ALIGNMENT_HALF_LENGTH_MM,
          );
          results.push({
            start: [start.x, start.y, start.z],
            end: [end.x, end.y, end.z],
            kind: "endContact",
          });
        }
      }
    }
  }
  return results;
};

export function nearestRodAlignmentState(
  moving: Component,
  components: Component[],
  position: THREE.Vector3,
  rotZ: number,
): RodAlignmentState[] {
  const matches: (RodAlignmentState & { key: string })[] = [];

  const evaluate = (
    rod: Component,
    rodPosition: THREE.Vector3,
    rodRotZ: number,
    contacts: RodMountContact[],
    mountCenter: THREE.Vector3,
  ) => {
    const axis = rodAxis(rod, rodRotZ);
    for (const contact of contacts) {
      if (!rodPerpendicularToFace(axis, contact.normal)) continue;

      const relative = rodPosition.clone().sub(contact.point);
      const transverseAxes = [0, 1, 2].filter(
        (index) => Math.abs(contact.normal.getComponent(index)) < 0.5,
      );
      const matchingAxes = transverseAxes.filter(
        (index) => Math.abs(relative.getComponent(index)) <= GUIDE_SNAP_MM,
      );
      if (!matchingAxes.length) continue;
      const exactAxes = transverseAxes.filter(
        (index) =>
          Math.abs(relative.getComponent(index))
          <= ROD_MOUNT_EXACT_TOLERANCE_MM,
      );
      const kind = exactAxes.length === transverseAxes.length
        ? "center"
        : "coordinate";
      const lineCenter = contact.point.clone().addScaledVector(
        contact.normal,
        mountCenter.clone().sub(contact.point).dot(contact.normal),
      );
      const start = lineCenter.clone().addScaledVector(
        contact.normal, -ROD_ALIGNMENT_HALF_LENGTH_MM,
      );
      const end = lineCenter.clone().addScaledVector(
        contact.normal, ROD_ALIGNMENT_HALF_LENGTH_MM,
      );
      const lineAxis = [0, 1, 2].sort(
        (left, right) =>
          Math.abs(contact.normal.getComponent(right))
          - Math.abs(contact.normal.getComponent(left)),
      )[0];
      const lineCoordinates = [0, 1, 2]
        .filter((index) => index !== lineAxis)
        .map((index) => contact.point.getComponent(index).toFixed(3));
      matches.push({
        start: [start.x, start.y, start.z],
        end: [end.x, end.y, end.z],
        kind,
        key: `${lineAxis}:${lineCoordinates.join(":")}`,
      });
    }
  };

  const evaluateHoleAxes = (
    rod: Component,
    rodPosition: THREE.Vector3,
    rodRotZ: number,
    holes: RodHoleAxis[],
  ) => {
    const axis = rodAxis(rod, rodRotZ);
    for (const hole of holes) {
      const parallel = Math.abs(axis.dot(hole.direction))
        >= Math.cos(ROD_MOUNT_ANGLE_TOLERANCE_DEG * DEG);
      if (!parallel) continue;

      // Compare the two center axes only in the plane perpendicular to the
      // hole. Longitudinal position is intentionally ignored: the Rod may
      // slide through LCP35_M, and no collision/contact rule is needed.
      const centerOffset = rodPosition.clone().sub(hole.point);
      const offsetY = Math.abs(centerOffset.dot(hole.transverseY));
      const offsetZ = Math.abs(centerOffset.dot(hole.transverseZ));
      // Treat both transverse coordinates independently, like CM1-DCH_M.
      // Merely having a parallel direction is not enough to display a guide:
      // at least one of the hole's Y/Z coordinates must be near the Rod axis.
      const matchingCoordinates = [
        offsetY <= ROD_MOUNT_EXACT_TOLERANCE_MM,
        offsetZ <= ROD_MOUNT_EXACT_TOLERANCE_MM,
      ];
      if (!matchingCoordinates.some(Boolean)) continue;
      const exact = (
        offsetY <= ROD_MOUNT_EXACT_TOLERANCE_MM
        && offsetZ <= ROD_MOUNT_EXACT_TOLERANCE_MM
      );

      const start = hole.point.clone().addScaledVector(
        hole.direction, -ROD_ALIGNMENT_HALF_LENGTH_MM,
      );
      const end = hole.point.clone().addScaledVector(
        hole.direction, ROD_ALIGNMENT_HALF_LENGTH_MM,
      );
      const lineAxis = [0, 1, 2].sort(
        (left, right) =>
          Math.abs(hole.direction.getComponent(right))
          - Math.abs(hole.direction.getComponent(left)),
      )[0];
      const lineCoordinates = [0, 1, 2]
        .filter((index) => index !== lineAxis)
        .map((index) => hole.point.getComponent(index).toFixed(3));
      matches.push({
        start: [start.x, start.y, start.z],
        end: [end.x, end.y, end.z],
        kind: exact ? "center" : "coordinate",
        key: `hole:${lineAxis}:${lineCoordinates.join(":")}`,
      });
    }
  };

  if (isRod(moving)) {
    const axis = rodAxis(moving, rotZ);
    if (Math.abs(axis.z) <= Math.sin(ROD_MOUNT_ANGLE_TOLERANCE_DEG * DEG)) {
      const start = position.clone().addScaledVector(
        axis, -ROD_ALIGNMENT_HALF_LENGTH_MM,
      );
      const end = position.clone().addScaledVector(
        axis, ROD_ALIGNMENT_HALF_LENGTH_MM,
      );
      matches.push({
        start: [start.x, start.y, start.z],
        end: [end.x, end.y, end.z],
        kind: "board",
        key: "board",
      });
    }
    for (const mount of components) {
      if (mount.name === moving.name) continue;
      if (isLcp35Mount(mount)) {
        evaluateHoleAxes(
          moving,
          position,
          rotZ,
          worldRodHoleAxes(mount),
        );
      }
      for (const alignment of mountPlateEndAlignments(
        moving,
        position,
        rotZ,
        mount,
        new THREE.Vector3(mount.x, mount.y, mount.z),
        mount.rotZ,
      )) {
        matches.push({
          ...alignment,
          key: `end:${alignment.start.map((value) =>
            value.toFixed(3)).join(":")}`,
        });
      }
      evaluate(
        moving,
        position,
        rotZ,
        worldRodMountContacts(mount),
        new THREE.Vector3(mount.x, mount.y, mount.z),
      );
    }
  } else if (
    localRodMountContacts(moving).length
    || isLcp35Mount(moving)
  ) {
    const holes = isLcp35Mount(moving)
      ? worldRodHoleAxes(
        moving, position.x, position.y, position.z, rotZ,
      )
      : [];
    const contacts = worldRodMountContacts(
      moving, position.x, position.y, position.z, rotZ,
    );
    for (const rod of components) {
      if (!isRod(rod) || rod.name === moving.name) continue;
      evaluateHoleAxes(
        rod,
        new THREE.Vector3(rod.x, rod.y, rod.z),
        rod.rotZ,
        holes,
      );
      for (const alignment of mountPlateEndAlignments(
        rod,
        new THREE.Vector3(rod.x, rod.y, rod.z),
        rod.rotZ,
        moving,
        position,
        rotZ,
      )) {
        matches.push({
          ...alignment,
          key: `end:${alignment.start.map((value) =>
            value.toFixed(3)).join(":")}`,
        });
      }
      evaluate(
        rod,
        new THREE.Vector3(rod.x, rod.y, rod.z),
        rod.rotZ,
        contacts,
        position,
      );
    }
  }

  const unique = new Map<string, RodAlignmentState>();
  for (const match of matches) {
    const existing = unique.get(match.key);
    if (!existing || match.kind === "center") {
      unique.set(match.key, match);
    }
  }
  const states = [...unique.values()];
  const centeredStates = states.filter((state) => state.kind === "center");
  const touchingStates = states.filter(
    (state) => state.kind === "endContact",
  );
  for (const centered of centeredStates) {
    const centerStart = new THREE.Vector3(...centered.start);
    const centerDirection = new THREE.Vector3(...centered.end)
      .sub(centerStart)
      .normalize();
    for (const touching of touchingStates) {
      const touchStart = new THREE.Vector3(...touching.start);
      const touchDirection = new THREE.Vector3(...touching.end)
        .sub(touchStart)
        .normalize();
      const parallel = Math.abs(centerDirection.dot(touchDirection))
        >= Math.cos(ROD_MOUNT_ANGLE_TOLERANCE_DEG * DEG);
      const lineDistance = touchStart.clone()
        .sub(centerStart)
        .cross(centerDirection)
        .length();
      // Center and face contact have already passed their independent
      // ±0.25 mm checks. Here the distance only associates both results with
      // the same hole; using the exact tolerance again would reject a Rod
      // that is within the allowed angle (e.g. matsu2's 1° pose).
      if (parallel && lineDistance <= GUIDE_SNAP_MM) {
        return [{
          start: centered.start,
          end: centered.end,
          kind: "combined",
        }];
      }
    }
  }
  return states;
}

export function nearestRodEndAlignment(
  moving: Component,
  components: Component[],
  position: THREE.Vector3,
  rotZ: number,
): RodEndAlignment | null {
  if (!isRod(moving)) return null;
  const movingMinimum = moving.attrs.rodEndMinX_mm;
  const movingMaximum = moving.attrs.rodEndMaxX_mm;
  if (
    typeof movingMinimum !== "number"
    || typeof movingMaximum !== "number"
  ) return null;

  const angle = rotZ * DEG;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const candidates: (RodEndAlignment & { distance: number })[] = [];
  for (const rod of components) {
    if (!isRod(rod) || rod.name === moving.name) continue;
    for (const target of rodEnds(rod)) {
      for (const offset of [movingMinimum, movingMaximum]) {
        const rootX = target[0] - offset * cosine;
        const rootY = target[1] - offset * sine;
        const rootZ = target[2];
        const dx = Math.abs(rootX - position.x);
        const dy = Math.abs(rootY - position.y);
        const dz = Math.abs(rootZ - position.z);
        if (
          dx <= GUIDE_SNAP_MM
          && dy <= GUIDE_SNAP_MM
          && dz <= GUIDE_SNAP_MM
        ) {
          candidates.push({
            rootX,
            rootY,
            rootZ,
            guideX: target[0],
            guideY: target[1],
            guideZ: target[2],
            distance: Math.hypot(dx, dy, dz),
          });
        }
      }
    }
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0] ?? null;
}

export function nearestRodMountAlignment(
  moving: Component,
  components: Component[],
  position: THREE.Vector3,
  rotZ: number,
): RodMountAlignment | null {
  const candidates: (RodMountAlignment & { distance: number })[] = [];

  if (isRod(moving)) {
    for (const mount of components) {
      if (
        mount.name === moving.name
        || localRodMountContacts(mount).length
        || !rodMountAxesAligned(rotZ, mount.rotZ)
      ) continue;
      for (const [, holeY, holeZ] of worldRodHoles(mount)) {
        const dy = Math.abs(holeY - position.y);
        const dz = Math.abs(holeZ - position.z);
        if (dy <= GUIDE_SNAP_MM && dz <= GUIDE_SNAP_MM) {
          candidates.push({
            rootY: holeY,
            rootZ: holeZ,
            guideY: holeY,
            guideZ: holeZ,
            distance: Math.hypot(dy, dz),
          });
        }
      }
    }
  } else if (
    rodHoleOffsets(moving).length
    && !localRodMountContacts(moving).length
  ) {
    const angle = rotZ * DEG;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (const rod of components) {
      if (
        !isRod(rod)
        || rod.name === moving.name
        || !rodMountAxesAligned(rod.rotZ, rotZ)
      ) continue;
      for (const [dx, dy, dz] of rodHoleOffsets(moving)) {
        const offsetY = dx * sine + dy * cosine;
        const rootY = rod.y - offsetY;
        const rootZ = rod.z - dz;
        const deltaY = Math.abs(rootY - position.y);
        const deltaZ = Math.abs(rootZ - position.z);
        if (deltaY <= GUIDE_SNAP_MM && deltaZ <= GUIDE_SNAP_MM) {
          candidates.push({
            rootY,
            rootZ,
            guideY: rod.y,
            guideZ: rod.z,
            distance: Math.hypot(deltaY, deltaZ),
          });
        }
      }
    }
  }

  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0] ?? null;
}
