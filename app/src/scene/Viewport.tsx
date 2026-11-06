import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, GizmoHelper, GizmoViewport, Line, TransformControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

import type {
  BeamSegment, Board, Component, ComponentGroup, ComponentUpdate,
  FigureCallout, PinAnnotation,
} from "../types";

import { useSettings } from "../settings";
import Component3D from "./Component3D";
import Breadboard from "./Breadboard";
import Beam from "./Beam";
import Pin3D from "./Pin3D";
import GroupOutline from "./GroupOutline";
import CalloutAnchors from "./CalloutAnchors";
import type { AnchorStore } from "./anchors";
import { fromOverlay } from "./overlay";
import { groupPivot, rigidTransform } from "../groups";
import { snapPlacement } from "../beamFirst";
import type { Turn } from "../beamFirst";
import FoldArrows from "./FoldArrows";
import {
  DEG, GUIDE_SNAP_MM, cameraPlaneBasis, rotationAxis, snapActiveRotation, type RotationAxis,
} from "./snapping";
import {
  nearestRodAlignmentState, nearestRodEndAlignment, nearestRodMountAlignment,
  type RodAlignmentState,
} from "./rodAlignment";
import { removeAxisFreeRotationHandles, type GizmoControl, type GizmoRef } from "./gizmo";
import type { TransformDelta } from "../groups";

// One raycaster for anchor picking; it is only used inside pickAnchor, one
// pointer position at a time.
const pickRay = new THREE.Raycaster();
const MOUSE_TRANSLATION_SNAP_MM = 0.5;
// Components may be lifted above the board but not sunk into it; the ceiling is
// a sanity bound so a runaway drag can't push a part out of the scene.
const Z_MAX_MM = 300;

function rayOf(ray: THREE.Ray) {
  return { origin: ray.origin.toArray(), direction: ray.direction.toArray() };
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

/** What a figure export asks of the capture beyond "take the picture". */
export type CaptureOptions = {
  /** Multiplier on the device pixel ratio — a 4x export for print. */
  scale?: number;
  /** `current` keeps the viewport's own colour; the others are for the page. */
  background?: "current" | "white" | "transparent";
  /** Discussion pins are editor furniture, not part of a published figure. */
  hidePins?: boolean;
};

export type CapturedFrame = {
  blob: Blob;
  /** Viewport size in CSS pixels — the coordinate system the callouts use. */
  cssWidth: number;
  cssHeight: number;
  /** Device pixels per CSS pixel in `blob`. */
  scale: number;
};

export type ViewportHandle = {
  // Captures the current canvas as a PNG blob (null if the renderer isn't ready).
  captureSnapshot(options?: CaptureOptions): Promise<CapturedFrame | null>;
  /**
   * Where on `target` the cursor is, in the part's own frame (mm) — for
   * dragging a callout's anchor dot onto a particular face of a part.
   * Null when the part isn't in the scene.
   */
  pickAnchor(
    clientX: number,
    clientY: number,
    target: string,
  ): [number, number, number] | null;
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
    immediate?: boolean,
  ) => void;
  // Rigid move of the whole selection, saved in a single request.
  onMoveMany: (updates: ComponentUpdate[], immediate?: boolean) => void;
  /** `snap` false = Alt was held: put it exactly where clicked, not in the beam. */
  onPlace?: (point: THREE.Vector3, snap: boolean) => void;
  /** Turn a selected mirror / beamsplitter so the beam leaves to that side. */
  onFold?: (name: string, turn: Turn) => void;
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

  /** Figure callouts to project each frame, and where to publish the result. */
  callouts?: FigureCallout[];
  anchorStore?: AnchorStore;

  // Called once the WebGL renderer has completed its first frame, so
  // callers know captureSnapshot() has something real to capture.
  onReady?: () => void;
}>(function Viewport({
  components, beam, board, selection, groups, enteredGroupId,
  isPlacing, placingAsset, libraryPreviews, library, transformMode,
  onSelect, onDrillIn, onMove, onMoveMany, onPlace, onFold,
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
  callouts,
  anchorStore,
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
  // Canvas background — dark / gray / light, picked in the toolbar.
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
  const [previewRay, setPreviewRay] = useState<THREE.Ray | null>(null);
  // Alt held while placing = drop it beside the beam on purpose, no snap.
  const [freePlace, setFreePlace] = useState(false);
  useEffect(() => {
    if (!isPlacing) return;
    const track = (e: KeyboardEvent) => setFreePlace(e.altKey);
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      setFreePlace(false);
    };
  }, [isPlacing]);
  const [pinPreviewPoint, setPinPreviewPoint] = useState<THREE.Vector3 | null>(null);
  // The axis triad is editor furniture, not part of the setup, so it is hidden
  // for the duration of a snapshot. Hidden rather than unmounted:
  // GizmoHelper's renderPriority makes it the one driving the render loop, so
  // taking it out mid-capture would leave the frame unpainted.
  const [hideAxisTriad, setHideAxisTriad] = useState(false);
  // Discussion pins carry an author and a timestamp, which is exactly what a
  // published figure must not show, so an export can leave them out.
  const [hidePins, setHidePins] = useState(false);
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
  const sceneRef = useRef<THREE.Scene | null>(null);
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
    captureSnapshot: (options = {}) =>
      new Promise<CapturedFrame | null>((resolve) => {
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        if (!renderer || !scene) { resolve(null); return; }

        const scale = Math.max(1, Math.min(4, options.scale ?? 1));
        const background = options.background ?? "current";
        setHideAxisTriad(true);
        if (options.hidePins) setHidePins(true);

        // Everything the capture changes is put back in `restore`, including on
        // the failure paths: leaving the renderer at 4x or the scene without a
        // background would show up immediately as a blurred, transparent
        // viewport.
        const size = renderer.getSize(new THREE.Vector2());
        const basePixelRatio = renderer.getPixelRatio();
        const baseBackground = scene.background;
        const baseAlpha = renderer.getClearAlpha();
        const restore = () => {
          renderer.setPixelRatio(basePixelRatio);
          scene.background = baseBackground;
          renderer.setClearAlpha(baseAlpha);
          setHideAxisTriad(false);
          setHidePins(false);
        };

        renderer.setPixelRatio(basePixelRatio * scale);
        if (background === "transparent") {
          // Needs the alpha context asked for in the Canvas `gl` props: without
          // it the buffer has no alpha channel to clear.
          scene.background = null;
          renderer.setClearAlpha(0);
        } else if (background === "white") {
          scene.background = new THREE.Color("#ffffff");
        }

        // Wait two frames so a selection cleared just before this call has
        // actually unmounted its gizmo/guides — and so the resized drawing
        // buffer has been painted — before we capture.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // toBlob reads the drawing buffer synchronously, so the viewport can
            // be put back as soon as it returns.
            renderer.domElement.toBlob((blob) => {
              restore();
              resolve(blob
                ? { blob, cssWidth: size.x, cssHeight: size.y,
                    scale: basePixelRatio * scale }
                : null);
            }, "image/png");
          });
        });
      }),

    pickAnchor: (clientX, clientY, target) => {
      const renderer = rendererRef.current;
      const camera = cameraRef.current;
      const object = refs.current[target];
      if (!renderer || !camera || !object) return null;

      const rect = renderer.domElement.getBoundingClientRect();
      pickRay.setFromCamera(
        new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );

      // Prefer a real hit on the part: the dot then sits *on* the surface the
      // user is pointing at — a lens face, the front of a camera — which is
      // what a figure's leader line is supposed to touch.
      const hit = pickRay.intersectObject(object, true)[0]?.point;
      if (hit) {
        const local = object.worldToLocal(hit.clone());
        return [local.x, local.y, local.z];
      }

      // Dragged off the part: slide along the plane through the current anchor
      // facing the camera, so the dot follows the cursor instead of sticking.
      // A leader line may legitimately point just beside a part.
      const anchorWorld = object.localToWorld(new THREE.Vector3());
      const normal = camera.getWorldDirection(new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchorWorld);
      const point = pickRay.ray.intersectPlane(plane, new THREE.Vector3());
      if (!point) return null;
      const local = object.worldToLocal(point);
      return [local.x, local.y, local.z];
    },
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

  const handlePreviewMove = (point: THREE.Vector3 | null, ray?: THREE.Ray) => {
    setPreviewRay(ray ? ray.clone() : null);
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

  const handlePlace = (point: THREE.Vector3, ray: THREE.Ray) => {
    const guideX = nearestGuideX(point.x);
    const guideY = nearestGuideY(point.y);
    const placement = point.clone();
    if (guideX !== null) placement.x = guideX;
    if (guideY !== null) placement.y = guideY;
    const snap = !freePlace && placingAsset
      ? snapPlacement(
        { type: placingType, attrs: libraryPreviews?.[placingAsset]?.attrs ?? {} },
        beam, placement.x, placement.y, rayOf(ray),
      )
      : null;
    if (snap) { placement.x = snap.beamX; placement.y = snap.beamY; }
    onPlace?.(placement, !freePlace);
  };

  // Where the part being placed will actually land: in the beam when it is an
  // in-beam part dropped near one (the server snaps it the same way).
  const placingType = placingAsset
    ? libraryPreviews?.[placingAsset]?.type ?? componentTypeFromAsset(placingAsset)
    : "";
  const placingSnap = isPlacing && placingAsset && previewPoint && !freePlace
    ? snapPlacement(
      { type: placingType, attrs: libraryPreviews?.[placingAsset]?.attrs ?? {} },
      beam, previewPoint.x, previewPoint.y, previewRay ? rayOf(previewRay) : undefined,
    )
    : null;

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
    onMove(selected, x, y, z, rotX, rotY, rotZ, true);
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
    onMoveMany(rigidTransform(components, selection, delta, drag.pivot), true);
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
      // `alpha` is asked for up front because a WebGL context cannot gain an
      // alpha channel later: a transparent figure export has to be possible
      // without tearing down and rebuilding the canvas. The scene still paints
      // its own opaque background, so nothing looks different on screen.
      gl={{ antialias: true, preserveDrawingBuffer: true, alpha: true }}
      camera={{ fov: 35, near: 1, far: span * 12, position: [cx, cy - span, cz + span * 0.85] }}
      onCreated={({ camera, gl, scene }) => {
        camera.up.set(0, 0, 1);            // Z-up to match USD
        camera.lookAt(center);
        cameraRef.current = camera;
        rendererRef.current = gl;
        sceneRef.current = scene;
        onReady?.();
      }}

      // Clear component, pin and beam-leg selection when clicking empty space —
      // the beam editor closes by clicking away from it, like any other card.
      onPointerMissed={(e) => {
        // A click on the editor itself arrives here as a miss too (see
        // `fromOverlay`); that is a click *in* the card, not away from it.
        if (fromOverlay(e.target)) return;
        onSelect(null);
        onSelectPin?.(null);
        onSelectSegment?.(null);
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
            type: placingType,
            x: placingSnap?.x ?? previewPoint.x,
            y: placingSnap?.y ?? previewPoint.y,
            // Same drop height the server will author, so the ghost stands
            // where the part lands instead of sunk into the board.
            z: placingSnap?.z ?? ((board.bbox?.max[2] ?? 0)
              + (libraryPreviews?.[placingAsset]?.baseOffsetZ ?? 0)),
            rotX: 0,
            rotY: 0,
            rotZ: placingSnap?.rotZ ?? 0,
            attrs: libraryPreviews?.[placingAsset]?.attrs ?? {},
          }}
          selected={false}
          ghost
          setRef={() => {}}
          onSelect={() => {}}
          onMove={() => {}}
        />
      )}
      {selectedComponent && onFold && !isPlacing && (
        <FoldArrows component={selectedComponent} beam={beam} onFold={onFold} />
      )}
      <Beam
        segments={beam}
        selectedKey={selectedSegmentKey}
        // While placing, a click on the beam is a drop INTO it, not a pick of
        // the leg: the pick cylinders would swallow it before the board saw it.
        onSelect={isPlacing ? undefined : onSelectSegment}
        editor={beamEditor}
        board={board.bbox}
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

      {anchorStore && (
        <CalloutAnchors
          store={anchorStore}
          callouts={callouts ?? []}
          refs={refs}
        />
      )}

      {(hidePins ? [] : pins).map((pin) => (
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
