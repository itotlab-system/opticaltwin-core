import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import type { ElementRef, MutableRefObject } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, GizmoHelper, GizmoViewport, Line, TransformControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

// Before:
// import type { BeamSegment, Board, Component, ParaxialSegment } from "../types";

// Added PinAnnotation so this viewport can render shared 3D pin annotations.
import type {
  BeamSegment, Board, Component, ComponentGroup, ComponentUpdate,
  PinAnnotation,
} from "../types";

import { useSettings } from "../settings";
import Component3D from "./Component3D";
import Breadboard from "./Breadboard";
import Beam from "./Beam";
import Pin3D from "./Pin3D";
import GroupOutline from "./GroupOutline";
import { groupPivot, rigidTransform } from "../groups";
import type { TransformDelta } from "../groups";

const DEG = Math.PI / 180;
const MOUSE_TRANSLATION_SNAP_MM = 0.5;
const GUIDE_SNAP_MM = 2.5;
const ROD_MOUNT_EXACT_TOLERANCE_MM = 0.25;
const ROD_MOUNT_ANGLE_TOLERANCE_DEG = 3;
const ROD_ALIGNMENT_HALF_LENGTH_MM = 60;
const CARDINAL_ROTATION_SNAP_DEG = 5;
// Components may be lifted above the board but not sunk into it; the ceiling is
// a sanity bound so a runaway drag can't push a part out of the scene.
const Z_MAX_MM = 300;

/**
 * Return screen-right and camera-forward directions projected onto the
 * breadboard. OrbitControls keeps the camera Z-up, so these form an intuitive
 * camera-relative XY basis. Looking straight down makes forward degenerate;
 * in that case the camera's screen-up direction is the useful fallback.
 */
function cameraPlaneBasis(camera: THREE.Camera | null) {
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

/** Snap to quarter turns only inside the magnetic ±5° tolerance. */
type RotationAxis = "X" | "Y" | "Z";

function rotationAxis(axis: string): RotationAxis | null {
  return axis === "X" || axis === "Y" || axis === "Z" ? axis : null;
}

function snapCardinalAngle(angleRad: number): number | null {
  const angleDeg = angleRad / DEG;
  const nearestQuarterTurn = Math.round(angleDeg / 90) * 90;
  return Math.abs(angleDeg - nearestQuarterTurn) <= CARDINAL_ROTATION_SNAP_DEG
    ? nearestQuarterTurn * DEG
    : null;
}

function snapActiveRotation(object: THREE.Object3D, axis: RotationAxis | null) {
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

// Library asset names describe catalogue variants, while Component3D renders
// the optics:type stored inside each USD asset. Keep that distinction here so
// e.g. lens_collimating.usda previews as a lens instead of the fallback cube.
function componentTypeFromAsset(asset: string): string {
  const name = asset.replace(/\.usda$/i, "").toLowerCase();
  if (name.startsWith("rod/")) return "mount";
  const cadTypes: Record<string, string> = {
    "la4380-a-step": "lens",
    "cp20d-step": "iris",
    "exulus-hd2hp-step": "slm",
  };
  if (cadTypes[name]) return cadTypes[name];
  if (name.startsWith("lens_cylindrical") || name.startsWith("cylindrical_lens")) {
    return "cylindrical_lens";
  }
  if (name.startsWith("beamsplitter")) return "beamsplitter";
  if (name.startsWith("polarizer")) return "polarizer";
  if (name.startsWith("detector")) return "detector";
  if (name.startsWith("eyepiece")) return "eyepiece";
  if (name.startsWith("camera")) return "camera";
  if (name.startsWith("mirror")) return "mirror";
  if (name.startsWith("laser")) return "laser";
  if (name.startsWith("iris")) return "iris";
  if (name.startsWith("lens")) return "lens";
  if (name.startsWith("slm")) return "slm";
  return name;
}

function modelNumber(asset: string, type: "holder" | "post"): number {
  const prefix = type === "holder" ? "PH" : "TR";
  const match = new RegExp(`(?:^|/)${prefix}(\\d+)`, "i").exec(asset);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

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

type RodAlignmentState = {
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

const rodShoulderOffsets = (rod: Component): number[] => {
  const minimum = rod.attrs.rodShoulderMinX_mm
    ?? rod.attrs.rodEndMinX_mm;
  const maximum = rod.attrs.rodShoulderMaxX_mm
    ?? rod.attrs.rodEndMaxX_mm;
  return typeof minimum === "number" && typeof maximum === "number"
    ? [minimum, maximum]
    : [];
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

const outwardRodShoulderOffsets = (
  rod: Component,
  axis: THREE.Vector3,
  faceNormal: THREE.Vector3,
): number[] => {
  const direction = axis.dot(faceNormal);
  return rodShoulderOffsets(rod).filter((offset) =>
    offset * direction < 0,
  );
};

function nearestRodAlignmentState(
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

function nearestRodContactAlignment(
  moving: Component,
  components: Component[],
  position: THREE.Vector3,
  rotZ: number,
): RodEndAlignment | null {
  const candidates: (RodEndAlignment & { distance: number })[] = [];

  if (isRod(moving)) {
    const axis = rodAxis(moving, rotZ);
    for (const component of components) {
      if (
        component.name === moving.name
        || !localRodMountContacts(component).length
      ) continue;
      for (const contact of worldRodMountContacts(component)) {
        if (!rodPerpendicularToFace(axis, contact.normal)) continue;
        const mountCenter = new THREE.Vector3(
          component.x, component.y, component.z,
        );
        if (
          position.clone().sub(mountCenter).dot(contact.normal) <= 0
        ) continue;
        for (const offset of outwardRodShoulderOffsets(
          moving, axis, contact.normal,
        )) {
          const root = contact.point.clone().addScaledVector(axis, -offset);
          const rootX = root.x;
          const rootY = root.y;
          const rootZ = root.z;
          const dx = Math.abs(rootX - position.x);
          const dy = Math.abs(rootY - position.y);
          const dz = Math.abs(rootZ - position.z);
          const shoulder = position.clone().addScaledVector(axis, offset);
          const separation = shoulder.clone()
            .sub(contact.point)
            .dot(contact.normal);
          const centerOffset = position.clone()
            .sub(contact.point)
            .addScaledVector(
              axis,
              -position.clone().sub(contact.point).dot(axis),
            )
            .length();
          if (
            separation <= GUIDE_SNAP_MM
            && centerOffset <= GUIDE_SNAP_MM
          ) {
            candidates.push({
              rootX,
              rootY,
              rootZ,
              guideX: contact.point.x,
              guideY: contact.point.y,
              guideZ: contact.point.z,
              distance: Math.hypot(dx, dy, dz),
            });
          }
        }
      }
    }
  } else if (localRodMountContacts(moving).length) {
    for (const rod of components) {
      if (!isRod(rod) || rod.name === moving.name) continue;
      const axis = rodAxis(rod);
      const rodPosition = new THREE.Vector3(rod.x, rod.y, rod.z);
      for (const contact of worldRodMountContacts(
        moving, position.x, position.y, position.z, rotZ,
      )) {
        if (!rodPerpendicularToFace(axis, contact.normal)) continue;
        if (
          rodPosition.clone().sub(position).dot(contact.normal) <= 0
        ) continue;
        for (const shoulderOffset of outwardRodShoulderOffsets(
          rod, axis, contact.normal,
        )) {
        const shoulder = new THREE.Vector3(rod.x, rod.y, rod.z)
          .addScaledVector(axis, shoulderOffset);
          const localContacts = localRodMountContacts(moving);
          const worldContacts = worldRodMountContacts(
            moving, position.x, position.y, position.z, rotZ,
          );
          const index = worldContacts.findIndex(({ point }) =>
            point.distanceTo(contact.point) < 1e-6,
          );
          if (index < 0) continue;
          const rotation = componentQuaternion(moving, rotZ);
          const localPoint = localContacts[index].point;
          const rotatedOffset = localPoint.clone().applyQuaternion(rotation);
          const root = shoulder.clone().sub(rotatedOffset);
          const rootX = root.x;
          const rootY = root.y;
          const rootZ = root.z;
          const deltaX = Math.abs(rootX - position.x);
          const deltaY = Math.abs(rootY - position.y);
          const deltaZ = Math.abs(rootZ - position.z);
          const separation = shoulder.clone()
            .sub(contact.point)
            .dot(contact.normal);
          const centerOffset = rodPosition.clone()
            .sub(contact.point)
            .addScaledVector(
              axis,
              -rodPosition.clone().sub(contact.point).dot(axis),
            )
            .length();
          if (
            separation <= GUIDE_SNAP_MM
            && centerOffset <= GUIDE_SNAP_MM
          ) {
            candidates.push({
              rootX,
              rootY,
              rootZ,
              guideX: shoulder.x,
              guideY: shoulder.y,
              guideZ: shoulder.z,
              distance: Math.hypot(deltaX, deltaY, deltaZ),
            });
          }
        }
      }
    }
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0] ?? null;
}

function nearestRodEndAlignment(
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

function nearestRodMountAlignment(
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

type GizmoControl = ElementRef<typeof TransformControls>;
type GizmoRef = MutableRefObject<GizmoControl | null>;

/**
 * TransformControls includes two axis-free rotation handles by default:
 * `E` (screen-space rotation) and `XYZE` (free/trackball rotation). Remove
 * both their visible geometry and invisible pickers, leaving only X/Y/Z.
 */
function removeAxisFreeRotationHandles(control: GizmoControl | null) {
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

export type ViewportHandle = {
  // Captures the current canvas as a PNG blob (null if the renderer isn't ready).
  captureSnapshot(): Promise<Blob | null>;
};

export type TransformMode = "translate" | "rotate";

const Viewport = forwardRef<ViewportHandle, {
  components: Component[];
  beam: BeamSegment[];
  board: Board;
  // Names of every selected component — one part, or all members of a group.
  selection: string[];
  groups: ComponentGroup[];
  // Group the user has drilled into, whose members select individually.
  enteredGroupId: string | null;
  isPlacing: boolean;
  placingAsset: string;
  libraryPreviews?: Record<string, Component>;
  library: string[];
  transformMode: TransformMode;
  onSelect: (name: string | null, additive?: boolean) => void;
  onDrillIn: (name: string) => void;
  onMove: (
    name: string,
    x: number,
    y: number,
    z: number,
    rotX: number,
    rotY: number,
    rotZ: number,
  ) => void;
  // Rigid move of the whole selection, saved in a single request.
  onMoveMany: (updates: ComponentUpdate[]) => void;
  onChangeModel: (asset: string) => void;
  onPlace?: (point: THREE.Vector3) => void;
  /** Beam leg being edited, and the editor anchored beside it in 3D. */
  selectedSegmentKey?: string | null;
  onSelectSegment?: (seg: BeamSegment | null) => void;
  beamEditor?: React.ReactNode;

  // List of pin annotations to render in the viewport.
  pins?: PinAnnotation[];

  // When true, clicking the breadboard creates a new pin.
  pinMode?: boolean;

  // The currently selected pin id.
  selectedPinId?: string | null;

  // Called when the user clicks the breadboard in Add pin mode.
  onAddPinAt?: (x: number, y: number, z: number) => void;

  // Called when the user selects or clears a pin.
  onSelectPin?: (id: string | null) => void;

  // Called when the user deletes a pin.
  onDeletePin?: (id: string) => void;

  // Called when the user edits the selected pin label.
  onEditPin?: (id: string) => void;

  // Persists a pin position after it is dragged.
  onMovePin?: (id: string, x: number, y: number, z: number) => void;

  // Appearance of the pin currently being placed.
  pinPreview?: { authorName: string; color: string };

  // Called once the WebGL renderer has completed its first frame, so
  // callers know captureSnapshot() has something real to capture.
  onReady?: () => void;
}>(function Viewport({
  components, beam, board, selection, groups, enteredGroupId,
  isPlacing, placingAsset, libraryPreviews, library, transformMode,
  onSelect, onDrillIn, onMove, onMoveMany, onChangeModel, onPlace,
  selectedSegmentKey = null, onSelectSegment, beamEditor,
  pins = [],
  pinMode = false,
  selectedPinId = null,
  onAddPinAt,
  onSelectPin,
  onDeletePin,
  onEditPin,
  onMovePin,
  pinPreview,
  onReady,
}, ref) {
  // Frame on the breadboard (Z-up world, units = mm).
  const bb = board.bbox ?? { min: [0, 0, 0] as const, max: [400, 300, 0] as const };
  const cx = (bb.min[0] + bb.max[0]) / 2;
  const cy = (bb.min[1] + bb.max[1]) / 2;
  const cz = 0;
  const span = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]) || 400;
  const center = new THREE.Vector3(cx, cy, cz);
  const zFloor = bb.max[2];   // board top surface — parts rest on or above it
  const clampZ = (z: number) => Math.min(Z_MAX_MM, Math.max(zFloor, z));
  // Canvas background — dark / gray / light, picked in the toolbar (#156).
  const { bgColor } = useSettings();
  // The move/rotate gizmo drives one object, so it only appears for a
  // single-part selection; groups get their own gizmo.
  const selected = selection.length === 1 ? selection[0] : null;
  const selectedComponent = selected
    ? components.find((component) => component.name === selected)
    : null;
  const singleGizmoOffsetZ = selectedComponent?.type === "holder"
    ? 0
    : selectedComponent?.type === "post"
      ? 2
      : 0;
  const holderGizmoOffsetX = selectedComponent?.type === "holder"
    && !/(?:^|\/)PH(?:20|30)E/i.test(selectedComponent.asset ?? "")
    ? 1
    : 0;
  const singleGizmoOffset = new THREE.Vector3(holderGizmoOffsetX, 0, 0)
    .applyEuler(new THREE.Euler(
      (selectedComponent?.rotX ?? 0) * DEG,
      (selectedComponent?.rotY ?? 0) * DEG,
      (selectedComponent?.rotZ ?? 0) * DEG,
    ));
  singleGizmoOffset.z += singleGizmoOffsetZ;
  const [selectedRef, setSelectedRef] = useState<THREE.Group | null>(null);
  const refs = useRef<Record<string, THREE.Group | null>>({});
  // Invisible object the group gizmos drive; state (not a ref) so mounting it
  // re-renders the TransformControls that attach to it.
  const [groupProxy, setGroupProxy] = useState<THREE.Group | null>(null);
  const [selectedPinRef, setSelectedPinRef] = useState<THREE.Group | null>(null);
  const pinRefs = useRef<Record<string, THREE.Group | null>>({});
  const [previewPoint, setPreviewPoint] = useState<THREE.Vector3 | null>(null);
  const [pinPreviewPoint, setPinPreviewPoint] = useState<THREE.Vector3 | null>(null);
  // The axis triad is editor furniture, not part of the setup, so it is hidden
  // for the duration of a snapshot (#154). Hidden rather than unmounted:
  // GizmoHelper's renderPriority makes it the one driving the render loop, so
  // taking it out mid-capture would leave the frame unpainted.
  const [hideAxisTriad, setHideAxisTriad] = useState(false);
  const [smartGuideX, setSmartGuideX] = useState<number | null>(null);
  const [smartGuideY, setSmartGuideY] = useState<number | null>(null);
  // Height guide carries the y of the dragged part too, so the line is drawn
  // alongside it instead of somewhere arbitrary on the board.
  const [smartGuideZ, setSmartGuideZ] = useState<{ z: number; y: number } | null>(null);
  const [rodAlignments, setRodAlignments] = useState<RodAlignmentState[]>([]);
  const [rotationSnapGuide, setRotationSnapGuide] = useState<{
    axis: RotationAxis;
    center: [number, number, number];
  } | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  // The move and rotate gizmos are two independent TransformControls, and each
  // raycasts the same pointerdown against its own handles. Where they overlap
  // on screen one drag would start both, so a Z move also nudged rotZ. Arm only
  // whichever was grabbed first: three fires "mouseDown" synchronously inside
  // its pointerdown handler, before the other control's listener runs.
  const translateGizmo = useRef<GizmoControl | null>(null);
  const rotateGizmo = useRef<GizmoControl | null>(null);
  // The group gizmos drive a proxy object at the selection's pivot; only one
  // pair is mounted at a time (single part vs. group) but they share the
  // same arming rule.
  const groupTranslateGizmo = useRef<GizmoControl | null>(null);
  const groupRotateGizmo = useRef<GizmoControl | null>(null);
  const singleRotationAxis = useRef<RotationAxis | null>(null);
  const groupRotationAxis = useRef<RotationAxis | null>(null);
  const gizmos = [translateGizmo, rotateGizmo, groupTranslateGizmo, groupRotateGizmo];
  const setRotateGizmoRef = useCallback((control: GizmoControl | null) => {
    rotateGizmo.current = control;
    removeAxisFreeRotationHandles(control);
  }, []);
  const setGroupRotateGizmoRef = useCallback((control: GizmoControl | null) => {
    groupRotateGizmo.current = control;
    removeAxisFreeRotationHandles(control);
  }, []);

  // three-stdlib types `enabled` as private even though drei drives it as a
  // prop, so reach the live field through a narrow cast.
  const setArmed = (gizmo: GizmoRef, armed: boolean) => {
    const control = gizmo.current as unknown as { enabled: boolean } | null;
    if (control) control.enabled = armed;
  };

  // Handle currently grabbed on a gizmo: "X", "Y", "Z", "XY", … or "" if none.
  const activeAxis = (gizmo: GizmoRef): string =>
    (gizmo.current as unknown as { axis: string | null } | null)?.axis ?? "";

  const armOnly = (gizmo: GizmoRef) => {
    for (const g of gizmos) setArmed(g, g === gizmo);
  };

  const armAll = () => {
    for (const g of gizmos) setArmed(g, true);
  };

  // Safety net: a pointerup that never reaches the dragging control (lost
  // capture, cursor off-canvas) must not leave the other gizmo disabled.
  useEffect(() => {
    document.addEventListener("pointerup", armAll);
    document.addEventListener("pointercancel", armAll);
    return () => {
      document.removeEventListener("pointerup", armAll);
      document.removeEventListener("pointercancel", armAll);
    };
  }, []);

  // Drei does not expose switches for TransformControls' E/XYZE handles.
  // Remove them after each rotation control mounts (single part or group).
  useEffect(() => {
    removeAxisFreeRotationHandles(rotateGizmo.current);
    removeAxisFreeRotationHandles(groupRotateGizmo.current);
  }, [transformMode, selectedRef, groupProxy]);

  useImperativeHandle(ref, () => ({
    captureSnapshot: () =>
      new Promise<Blob | null>((resolve) => {
        setHideAxisTriad(true);
        // Wait two frames so a selection cleared just before this call has
        // actually unmounted its gizmo/guides and painted before we capture.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // toBlob reads the drawing buffer synchronously, so the triad can
            // come back as soon as it returns.
            const done = (blob: Blob | null) => {
              setHideAxisTriad(false);
              resolve(blob);
            };
            const renderer = rendererRef.current;
            if (!renderer) { done(null); return; }
            renderer.domElement.toBlob(done, "image/png");
          });
        });
      }),
  }), []);

  useEffect(() => {
    if (!isPlacing) setPreviewPoint(null);
  }, [isPlacing]);

  useEffect(() => {
    if (!pinMode) setPinPreviewPoint(null);
  }, [pinMode]);


  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (selection.length === 0) return;
      // Arrow keys belong to the text cursor while a field has focus (e.g.
      // renaming a group in the Inspector), not to the selected parts.
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target?.tagName ?? "")) {
        return;
      }

      // Several parts selected: nudge them as one rigid body so the layout
      // inside the selection is preserved.
      if (selection.length > 1) {
        const step = e.ctrlKey ? 10 : 1;
        const delta: TransformDelta = {
          dx: 0, dy: 0, dz: 0, dRotX: 0, dRotY: 0, dRotZ: 0,
        };
        if (e.shiftKey) {
          if (e.altKey) {
            if (e.key === "ArrowUp" || e.key === "PageUp") delta.dRotY = 1;
            else if (e.key === "ArrowDown" || e.key === "PageDown") delta.dRotY = -1;
            else return;
          } else if (e.key === "ArrowUp") delta.dRotX = 1;
          else if (e.key === "ArrowDown") delta.dRotX = -1;
          else if (e.key === "ArrowLeft") delta.dRotZ = -1;
          else if (e.key === "ArrowRight") delta.dRotZ = 1;
          else return;
        } else if (e.altKey) {
          if (e.key === "ArrowUp" || e.key === "PageUp") delta.dz = step;
          else if (e.key === "ArrowDown" || e.key === "PageDown") delta.dz = -step;
          else return;
        } else {
          const { right, forward } = cameraPlaneBasis(cameraRef.current);
          switch (e.key) {
            case "ArrowUp":
              delta.dx = forward.x * step;
              delta.dy = forward.y * step;
              break;
            case "ArrowDown":
              delta.dx = -forward.x * step;
              delta.dy = -forward.y * step;
              break;
            case "ArrowLeft":
              delta.dx = -right.x * step;
              delta.dy = -right.y * step;
              break;
            case "ArrowRight":
              delta.dx = right.x * step;
              delta.dy = right.y * step;
              break;
            // Keep PageUp/PageDown as legacy aliases where those keys exist.
            case "PageUp":     delta.dz = step; break;
            case "PageDown":   delta.dz = -step; break;
            default: return;
          }
        }
        e.preventDefault();
        const pivot = groupPivot(components, selection);
        // Clamp the group's descent as a whole — clamping members one by one
        // would flatten the lower parts onto the board and break the layout.
        delta.dz = Math.max(delta.dz, zFloor - pivot.minZ);
        onMoveMany(rigidTransform(components, selection, delta, pivot));
        return;
      }

      const component = components.find((c) => c.name === selected);
      if (!component) return;
      const isPairedPost = component.type === "post"
        && typeof component.attrs.pairedHolder === "string";

      let { x, y, z, rotX, rotY, rotZ } = component;

      if (e.shiftKey) {
        if (isPairedPost) return;
        // All rotations remain available on keyboards without PageUp/PageDown.
        const rotStep = 1;
        if (e.altKey) {
          if (e.key === "ArrowUp" || e.key === "PageUp") rotY += rotStep;
          else if (e.key === "ArrowDown" || e.key === "PageDown") rotY -= rotStep;
          else return;
        } else {
          switch (e.key) {
            case "ArrowUp":    rotX += rotStep; break;
            case "ArrowDown":  rotX -= rotStep; break;
            case "ArrowLeft":  rotZ -= rotStep; break;
            case "ArrowRight": rotZ += rotStep; break;
            default: return;
          }
        }
      } else if (e.altKey) {
        // Height remains world-Z relative, independent of the camera.
        const step = e.ctrlKey ? 10 : 1;
        if (e.key === "ArrowUp" || e.key === "PageUp") z += step;
        else if (e.key === "ArrowDown" || e.key === "PageDown") z -= step;
        else return;
      } else {
        // A holder-owned post stays on the insertion-hole axis. PageUp/Down
        // remain available as Z-only aliases.
        if (isPairedPost && e.key !== "PageUp" && e.key !== "PageDown") return;
        // Move in the camera-relative breadboard plane. Ctrl keeps the existing
        // coarse 10 mm step; ordinary arrows move by 1 mm.
        const step = e.ctrlKey ? 10 : 1;
        const { right, forward } = cameraPlaneBasis(cameraRef.current);
        switch (e.key) {
          case "ArrowUp":
            x += forward.x * step;
            y += forward.y * step;
            break;
          case "ArrowDown":
            x -= forward.x * step;
            y -= forward.y * step;
            break;
          case "ArrowLeft":
            x -= right.x * step;
            y -= right.y * step;
            break;
          case "ArrowRight":
            x += right.x * step;
            y += right.y * step;
            break;
          // Keep the old keys as aliases, without requiring them.
          case "PageUp":     z += step; break;
          case "PageDown":   z -= step; break;
          default: return;
        }
      }
      e.preventDefault();
      onMove(component.name, x, y, clampZ(z), rotX, rotY, rotZ);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [selected, selection, components, onMove, onMoveMany, zFloor]);

  useEffect(() => {
    setSelectedRef(refs.current[selected!] ?? null);
    setSmartGuideX(null);
    setSmartGuideY(null);
    setSmartGuideZ(null);
    setRodAlignments([]);
  }, [selected]);

  useEffect(() => {
    setSelectedPinRef(selectedPinId ? pinRefs.current[selectedPinId] ?? null : null);
  }, [selectedPinId, pins]);

  const nearestGuideY = (y: number, excludedName?: string): number | null => {
    const nearest = components
      .filter((component) => component.name !== excludedName)
      .map((component) => ({ y: component.y, distance: Math.abs(component.y - y) }))
      .filter(({ distance }) => distance <= GUIDE_SNAP_MM)
      .sort((a, b) => a.distance - b.distance)[0];
    return nearest?.y ?? null;
  };

  const nearestGuideX = (x: number, excludedName?: string): number | null => {
    const nearest = components
      .filter((component) => component.name !== excludedName)
      .map((component) => ({ x: component.x, distance: Math.abs(component.x - x) }))
      .filter(({ distance }) => distance <= GUIDE_SNAP_MM)
      .sort((a, b) => a.distance - b.distance)[0];
    return nearest?.x ?? null;
  };

  const nearestGuideZ = (z: number, excludedName?: string): number | null => {
    const nearest = components
      .filter((component) => component.name !== excludedName)
      .map((component) => ({ z: component.z, distance: Math.abs(component.z - z) }))
      .filter(({ distance }) => distance <= GUIDE_SNAP_MM)
      .sort((a, b) => a.distance - b.distance)[0];
    return nearest?.z ?? null;
  };

  const handlePreviewMove = (point: THREE.Vector3 | null) => {
    if (!point) {
      setPreviewPoint(null);
      setSmartGuideX(null);
      setSmartGuideY(null);
      return;
    }

    const guideX = nearestGuideX(point.x);
    const guideY = nearestGuideY(point.y);
    const preview = point.clone();
    if (guideX !== null) preview.x = guideX;
    if (guideY !== null) preview.y = guideY;
    setPreviewPoint(preview);
    setSmartGuideX(guideX);
    setSmartGuideY(guideY);
  };

  const handlePlace = (point: THREE.Vector3) => {
    const guideX = nearestGuideX(point.x);
    const guideY = nearestGuideY(point.y);
    const placement = point.clone();
    if (guideX !== null) placement.x = guideX;
    if (guideY !== null) placement.y = guideY;
    onPlace?.(placement);
  };

  const handleTransformChange = () => {
    if (!selectedRef || !selected) return;

    // Snap only along the handle being dragged: a Z drag must not slide the
    // part sideways onto a neighbour's X/Y line.
    const axis = activeAxis(translateGizmo);
    const moving = components.find((component) => component.name === selected);
    const rodMountAlignment = moving
      ? nearestRodMountAlignment(
        moving,
        components,
        selectedRef.position,
        selectedRef.rotation.z / DEG,
      )
      : null;
    const rodEndAlignment = moving
      ? nearestRodEndAlignment(
        moving,
        components,
        selectedRef.position,
        selectedRef.rotation.z / DEG,
      )
      : null;
    setRodAlignments(
      moving
        ? nearestRodAlignmentState(
          moving,
          components,
          selectedRef.position,
          selectedRef.rotation.z / DEG,
        )
        : [],
    );
    const guideX = axis.includes("X")
      ? rodEndAlignment?.guideX
        ?? nearestGuideX(selectedRef.position.x, selected)
      : null;
    const guideY = axis.includes("Y")
      ? rodMountAlignment?.guideY
        ?? rodEndAlignment?.guideY
        ?? nearestGuideY(selectedRef.position.y, selected)
      : null;
    // Clamp before snapping so the guide we report is the height we keep.
    selectedRef.position.z = clampZ(selectedRef.position.z);
    const guideZ = axis.includes("Z")
      ? rodMountAlignment?.guideZ
        ?? rodEndAlignment?.guideZ
        ?? nearestGuideZ(selectedRef.position.z, selected)
      : null;

    if (guideX !== null) {
      selectedRef.position.x = rodEndAlignment?.rootX
        ?? guideX;
    }
    if (guideY !== null) {
      selectedRef.position.y = rodMountAlignment?.rootY
        ?? rodEndAlignment?.rootY
        ?? guideY;
    }
    if (guideZ !== null) {
      selectedRef.position.z = rodMountAlignment?.rootZ
        ?? rodEndAlignment?.rootZ
        ?? guideZ;
    }
    setSmartGuideX(guideX);
    setSmartGuideY(guideY);
    setSmartGuideZ(guideZ === null ? null : { z: guideZ, y: selectedRef.position.y });
  };

  const handleRotationChange = () => {
    if (!selectedRef) return;
    const axis = rotationAxis(activeAxis(rotateGizmo)) ?? singleRotationAxis.current;
    const snapped = snapActiveRotation(selectedRef, axis);
    // Re-evaluate Rod/Mount alignment after cardinal-angle snapping so the
    // guide reflects the orientation that will actually be saved.
    handleTransformChange();
    const center = selectedRef.getWorldPosition(new THREE.Vector3());
    setRotationSnapGuide(snapped === null || !axis ? null : {
      axis,
      center: [center.x, center.y, center.z],
    });
  };

  const handleTransformEnd = () => {
    setSmartGuideX(null);
    setSmartGuideY(null);
    setSmartGuideZ(null);
    setRodAlignments([]);
    setRotationSnapGuide(null);
    if (!selectedRef || !selected) return;
    const x = selectedRef.position.x;
    const y = selectedRef.position.y;
    const z = clampZ(selectedRef.position.z);
    const rotX = Math.round(selectedRef.rotation.x / DEG);
    const rotY = Math.round(selectedRef.rotation.y / DEG);
    const rotZ = Math.round(selectedRef.rotation.z / DEG);
    onMove(selected, x, y, z, rotX, rotY, rotZ);
  };

  const setRef = (name: string, ref: THREE.Group | null) => {
    refs.current[name] = ref;
  };

  // ----- group transform -----
  //
  // TransformControls drives a single object, so a multi-selection is moved
  // through an invisible proxy parked at the selection's pivot. Every frame of
  // the drag re-derives each member's pose from the pose it had when the drag
  // started, which keeps the group rigid however far it is dragged and leaves
  // no rounding to accumulate.

  // Poses captured at pointerdown; null whenever no group drag is in flight.
  const groupDrag = useRef<{
    pivot: ReturnType<typeof groupPivot>;
    origin: THREE.Vector3;
    members: {
      name: string;
      x: number;
      y: number;
      z: number;
      rotX: number;
      rotY: number;
      rotZ: number;
    }[];
    outline: THREE.Group | null;
  } | null>(null);

  // Park the proxy on the pivot whenever the selection or the parts move —
  // never mid-drag, which would fight the gizmo.
  useEffect(() => {
    if (!groupProxy || selection.length < 2 || groupDrag.current) return;
    const pivot = groupPivot(components, selection);
    groupProxy.position.set(pivot.x, pivot.y, pivot.z);
    groupProxy.rotation.set(0, 0, 0);
  }, [groupProxy, selection, components]);

  // Outline wrappers, so a drag can carry the selected group's box along.
  const outlineRefs = useRef<Record<string, THREE.Group | null>>({});

  const handleGroupTransformStart = (gizmo: GizmoRef) => {
    armOnly(gizmo);
    if (gizmo === groupRotateGizmo) {
      groupRotationAxis.current = rotationAxis(activeAxis(groupRotateGizmo));
    }
    if (!groupProxy) return;
    // Only a whole group carries its outline; an ad-hoc selection has none.
    const dragged = groups.find(
      (g) => g.members.length === selection.length
        && g.members.every((m) => selection.includes(m)),
    );
    groupDrag.current = {
      pivot: groupPivot(components, selection),
      origin: groupProxy.position.clone(),
      members: components
        .filter((c) => selection.includes(c.name))
        .map((c) => ({
          name: c.name,
          x: c.x,
          y: c.y,
          z: c.z,
          rotX: c.rotX,
          rotY: c.rotY,
          rotZ: c.rotZ,
        })),
      outline: dragged ? outlineRefs.current[dragged.id] ?? null : null,
    };
  };

  const groupDelta = () => {
    const drag = groupDrag.current;
    if (!drag || !groupProxy) return null;
    const rotation = groupProxy.quaternion;
    const pivotPosition = new THREE.Vector3(
      drag.pivot.x,
      drag.pivot.y,
      drag.pivot.z,
    );
    const minRotatedZ = Math.min(...drag.members.map((member) =>
      new THREE.Vector3(member.x, member.y, member.z)
        .sub(pivotPosition)
        .applyQuaternion(rotation)
        .add(pivotPosition).z
    ));
    const rawDz = groupProxy.position.z - drag.origin.z;
    return {
      dx: groupProxy.position.x - drag.origin.x,
      dy: groupProxy.position.y - drag.origin.y,
      // Clamp after rotation so no member origin is pushed through the board.
      dz: Math.max(rawDz, zFloor - minRotatedZ),
      dRotX: groupProxy.rotation.x / DEG,
      dRotY: groupProxy.rotation.y / DEG,
      dRotZ: groupProxy.rotation.z / DEG,
    };
  };

  const handleGroupTransformChange = () => {
    const drag = groupDrag.current;
    if (groupProxy) {
      const axis = rotationAxis(activeAxis(groupRotateGizmo)) ?? groupRotationAxis.current;
      const snapped = snapActiveRotation(groupProxy, axis);
      const center = groupProxy.getWorldPosition(new THREE.Vector3());
      setRotationSnapGuide(snapped === null || !axis ? null : {
        axis,
        center: [center.x, center.y, center.z],
      });
    }
    const delta = groupDelta();
    if (!drag || !delta || !groupProxy) return;

    groupProxy.position.z = drag.origin.z + delta.dz;   // honour the clamp

    const rotation = groupProxy.quaternion.clone();
    const pivotPosition = new THREE.Vector3(
      drag.pivot.x,
      drag.pivot.y,
      drag.pivot.z,
    );
    const translation = new THREE.Vector3(delta.dx, delta.dy, delta.dz);
    for (const m of drag.members) {
      const ref = refs.current[m.name];
      if (!ref) continue;
      ref.position.copy(
        new THREE.Vector3(m.x, m.y, m.z)
          .sub(pivotPosition)
          .applyQuaternion(rotation)
          .add(pivotPosition)
          .add(translation),
      );
      const memberRotation = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(m.rotX * DEG, m.rotY * DEG, m.rotZ * DEG, "XYZ"),
      );
      ref.quaternion.copy(rotation.clone().multiply(memberRotation));
    }

    // The outline's points are world coordinates, so carry it with the drag by
    // rotating about the 3D pivot and translating: T(pivot+d) · R · T(-pivot).
    if (drag.outline) {
      drag.outline.position.copy(
        pivotPosition.clone()
          .add(translation)
          .sub(pivotPosition.clone().applyQuaternion(rotation)),
      );
      drag.outline.quaternion.copy(rotation);
    }
  };

  const handleGroupTransformEnd = () => {
    armAll();
    setRotationSnapGuide(null);
    groupRotationAxis.current = null;
    const drag = groupDrag.current;
    const delta = groupDelta();
    groupDrag.current = null;
    if (!drag || !delta) return;

    // The outline is about to be rebuilt from the saved positions, so drop the
    // drag transform or it would be applied twice.
    if (drag.outline) {
      drag.outline.position.set(0, 0, 0);
      drag.outline.quaternion.identity();
    }
    if (
      !delta.dx && !delta.dy && !delta.dz
      && !delta.dRotX && !delta.dRotY && !delta.dRotZ
    ) return;
    onMoveMany(rigidTransform(components, selection, delta, drag.pivot));
  };

  const handlePinTransformEnd = () => {
    if (!selectedPinRef || !selectedPinId) return;
    onMovePin?.(
      selectedPinId,
      Math.round(selectedPinRef.position.x * 2) / 2,
      Math.round(selectedPinRef.position.y * 2) / 2,
      selectedPinRef.position.z,
    );
  };

  return (
    <Canvas
      shadows={false}
      dpr={[1, 2]}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      camera={{ fov: 35, near: 1, far: span * 12, position: [cx, cy - span, cz + span * 0.85] }}
      onCreated={({ camera, gl }) => {
        camera.up.set(0, 0, 1);            // Z-up to match USD
        camera.lookAt(center);
        cameraRef.current = camera;
        rendererRef.current = gl;
        onReady?.();
      }}

      // Before:
      // onPointerMissed={() => onSelect(null)}

      // Clear both component selection and pin selection when clicking empty space.
      onPointerMissed={() => {
        onSelect(null);
        onSelectPin?.(null);
      }}
    >
      <color attach="background" args={[bgColor]} />
      <hemisphereLight args={["#cfe0ff", "#10131a", 0.5]} />
      <ambientLight intensity={0.25} />
      <directionalLight
        position={[cx + span * 0.3, cy - span * 0.2, cz + span]}
        intensity={2.2}
      />
      <Environment preset="city" />

      <Breadboard
        board={board}
        onPlace={onPlace ? handlePlace : undefined}
        onPreviewMove={isPlacing ? handlePreviewMove : undefined}
        onBoardClick={
          pinMode
            ? (x, y, z) => {
                onAddPinAt?.(x, y, z);
              }
            : undefined
        }
        onBoardPointerMove={pinMode ? setPinPreviewPoint : undefined}
      />
      {pinMode && pinPreview && pinPreviewPoint && (
        <Pin3D
          pin={{
            id: "Pin preview",
            label: "",
            x: pinPreviewPoint.x,
            y: pinPreviewPoint.y,
            z: pinPreviewPoint.z,
            authorName: pinPreview.authorName,
            color: pinPreview.color,
            size: 1,
            createdAt: "",
          }}
          selected={false}
          ghost
          onSelect={() => {}}
          onDelete={() => {}}
        />
      )}
      {isPlacing && placingAsset && previewPoint && (
        <Component3D
          c={{
            ...(libraryPreviews?.[placingAsset] ?? {}),
            name: "Placement preview",
            type: libraryPreviews?.[placingAsset]?.type
              ?? componentTypeFromAsset(placingAsset),
            x: previewPoint.x,
            y: previewPoint.y,
            z: 0,
            rotX: 0,
            rotY: 0,
            rotZ: 0,
            attrs: libraryPreviews?.[placingAsset]?.attrs ?? {},
          }}
          selected={false}
          ghost
          setRef={() => {}}
          onSelect={() => {}}
          onMove={() => {}}
        />
      )}
      <Beam
        segments={beam}
        selectedKey={selectedSegmentKey}
        onSelect={onSelectSegment}
        editor={beamEditor}
      />

      {rodAlignments.map((alignment, index) => (
        <Line
          key={`${alignment.kind}-${index}`}
          points={[alignment.start, alignment.end]}
          color={
            alignment.kind === "combined"
              ? "#ff8c1a"
              : alignment.kind === "center" || alignment.kind === "endContact"
                ? "#ffcc33"
                : "#8b949e"
          }
          lineWidth={3}
          dashed
          dashSize={5}
          gapSize={3}
          depthTest={false}
          renderOrder={11}
        />
      ))}

      {smartGuideY !== null && (
        <Line
          points={[
            [bb.min[0], smartGuideY, bb.max[2] + 1],
            [bb.max[0], smartGuideY, bb.max[2] + 1],
          ]}
          color="#ffcc33"
          lineWidth={2.5}
          dashed
          dashSize={8}
          gapSize={4}
          depthTest={false}
          renderOrder={10}
        />
      )}

      {smartGuideX !== null && (
        <Line
          points={[
            [smartGuideX, bb.min[1], bb.max[2] + 1],
            [smartGuideX, bb.max[1], bb.max[2] + 1],
          ]}
          color="#ffcc33"
          lineWidth={2.5}
          dashed
          dashSize={8}
          gapSize={4}
          depthTest={false}
          renderOrder={10}
        />
      )}

      {smartGuideZ !== null && (
        <Line
          points={[
            [bb.min[0], smartGuideZ.y, smartGuideZ.z],
            [bb.max[0], smartGuideZ.y, smartGuideZ.z],
          ]}
          color="#ffcc33"
          lineWidth={2.5}
          dashed
          dashSize={8}
          gapSize={4}
          depthTest={false}
          renderOrder={10}
        />
      )}

      {rotationSnapGuide !== null && (
        <Line
          points={
            rotationSnapGuide.axis === "X"
              ? [
                  [bb.min[0], rotationSnapGuide.center[1], rotationSnapGuide.center[2]],
                  [bb.max[0], rotationSnapGuide.center[1], rotationSnapGuide.center[2]],
                ]
              : rotationSnapGuide.axis === "Y"
                ? [
                    [rotationSnapGuide.center[0], bb.min[1], rotationSnapGuide.center[2]],
                    [rotationSnapGuide.center[0], bb.max[1], rotationSnapGuide.center[2]],
                  ]
                : [
                    [rotationSnapGuide.center[0], rotationSnapGuide.center[1], zFloor],
                    [
                      rotationSnapGuide.center[0],
                      rotationSnapGuide.center[1],
                      Math.min(
                        Z_MAX_MM,
                        Math.max(zFloor + span * 0.5, rotationSnapGuide.center[2]),
                      ),
                    ],
                  ]
          }
          color="#ffcc33"
          lineWidth={3}
          dashed
          dashSize={8}
          gapSize={4}
          depthTest={false}
          renderOrder={11}
        />
      )}

      {groups.map((group) => (
        <GroupOutline
          key={group.id}
          components={components}
          members={group.members}
          color={group.color ?? "#f5a623"}
          label={group.name}
          selected={group.members.some((m) => selection.includes(m))
            && group.id !== enteredGroupId}
          setRef={(ref) => { outlineRefs.current[group.id] = ref; }}
        />
      ))}

      {components.map((c) => (
        <Component3D
          key={c.name}
          c={c}
          selected={selection.includes(c.name)}
          setRef={setRef}
          onSelect={(name, additive) => {
            onSelect(name, additive);
            onSelectPin?.(null);
          }}
          onDoubleClick={onDrillIn}
          onMove={onMove}
          modelOptions={library
            .filter((asset) =>
              c.type === "holder"
                ? asset.startsWith("Holder/")
                : c.type === "post" && asset.startsWith("Post/")
            )
            .sort((left, right) =>
              modelNumber(left, c.type as "holder" | "post")
              - modelNumber(right, c.type as "holder" | "post")
            )}
          onChangeModel={onChangeModel}
        />
      ))}

      {selectedRef && transformMode === "translate" && (
        <group position={singleGizmoOffset}>
          <TransformControls
            ref={translateGizmo}
            object={selectedRef}
            mode="translate"
            showX={selectedComponent?.attrs.pairedHolder == null}
            showY={selectedComponent?.attrs.pairedHolder == null}
            showZ={true}
            translationSnap={MOUSE_TRANSLATION_SNAP_MM}
            size={0.7}
            onMouseDown={() => {
              armOnly(translateGizmo);
              setSmartGuideX(null);
              setSmartGuideY(null);
              setSmartGuideZ(null);
              setRodAlignments([]);
            }}
            onObjectChange={handleTransformChange}
            onMouseUp={() => {
              armAll();
              handleTransformEnd();
            }}
          />
        </group>
      )}
      {selectedRef && transformMode === "rotate"
        && selectedComponent?.attrs.pairedHolder == null && (
        <group position={singleGizmoOffset}>
          <TransformControls
            ref={setRotateGizmoRef}
            object={selectedRef}
            mode="rotate"
            showX={true}
            showY={true}
            showZ={true}
            rotationSnap={null}
            // Bigger than the move gizmo on purpose: the rotation ring's pick
            // radius is 1.0 against the arrows' 1.1, so at equal size the ring
            // sits right on top of the arrow tips. Pushing it out keeps the two
            // grabbable areas visually and physically separate.
            size={1.15}
            onMouseDown={() => {
              armOnly(rotateGizmo);
              setRodAlignments([]);
              singleRotationAxis.current = rotationAxis(activeAxis(rotateGizmo));
            }}
            onObjectChange={handleRotationChange}
            onMouseUp={() => {
              armAll();
              handleTransformEnd();
              singleRotationAxis.current = null;
            }}
          />
        </group>
      )}

      {selection.length > 1 && (
        <>
          <group ref={setGroupProxy} />
          {groupProxy && (
            transformMode === "translate" ? (
              <TransformControls
                ref={groupTranslateGizmo}
                object={groupProxy}
                mode="translate"
                translationSnap={MOUSE_TRANSLATION_SNAP_MM}
                size={0.9}
                onMouseDown={() => handleGroupTransformStart(groupTranslateGizmo)}
                onObjectChange={handleGroupTransformChange}
                onMouseUp={handleGroupTransformEnd}
              />
            ) : (
              <TransformControls
                ref={setGroupRotateGizmoRef}
                object={groupProxy}
                mode="rotate"
                showX={true}
                showY={true}
                showZ={true}
                rotationSnap={null}
                // Same reasoning as the single-part gizmo: push the ring clear
                // of the translate arrows so the two pick areas stay separate.
                size={1.45}
                onMouseDown={() => handleGroupTransformStart(groupRotateGizmo)}
                onObjectChange={handleGroupTransformChange}
                onMouseUp={handleGroupTransformEnd}
              />
            )
          )}
        </>
      )}

      {pins.map((pin) => (
        <Pin3D
          key={pin.id}
          pin={pin}
          selected={selectedPinId === pin.id}
          onSelect={(id) => {
            onSelect(null);
            onSelectPin?.(id);
          }}
          onDelete={(id) => {
            onDeletePin?.(id);
          }}
          onEdit={(id) => {
            onEditPin?.(id);
          }}
          setRef={(id, ref) => {
            pinRefs.current[id] = ref;
          }}
        />
      ))}

      {selectedPinRef && (
        <TransformControls
          object={selectedPinRef}
          mode="translate"
          showX
          showY
          showZ={false}
          translationSnap={MOUSE_TRANSLATION_SNAP_MM}
          size={0.7}
          onMouseUp={handlePinTransformEnd}
        />
      )}

      <OrbitControls
        makeDefault
        enableDamping
        target={[cx, cy, cz]}
        mouseButtons={{
          LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.DOLLY,
        }}
      />
      <EffectComposer>
        <Bloom luminanceThreshold={0.8} intensity={0.4} mipmapBlur radius={0.4} />
      </EffectComposer>

      <GizmoHelper alignment="top-left" margin={[58, 58]} renderPriority={2}>
        <GizmoViewport
          visible={!hideAxisTriad}
          scale={32}
          axisHeadScale={0.85}
          axisColors={["#e5534b", "#2ea043", "#4c8dff"]}
          labelColor="white"
        />
      </GizmoHelper>
    </Canvas>
  );
});

export default Viewport;
