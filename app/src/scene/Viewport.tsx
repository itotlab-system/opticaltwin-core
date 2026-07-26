import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ElementRef, MutableRefObject } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, GizmoHelper, GizmoViewport, Line, TransformControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

// Before:
// import type { BeamSegment, Board, Component, ParaxialSegment } from "../types";

// Added PinAnnotation so this viewport can render shared 3D pin annotations.
import type { BeamSegment, Board, Component, ParaxialSegment, PinAnnotation } from "../types";

import { useSettings } from "../settings";
import Component3D from "./Component3D";
import Breadboard from "./Breadboard";
import Beam from "./Beam";
import ParaxialBeam from "./ParaxialBeam";
import Pin3D from "./Pin3D";

const DEG = Math.PI / 180;
const GUIDE_SNAP_MM = 3;
// Components may be lifted above the board but not sunk into it; the ceiling is
// a sanity bound so a runaway drag can't push a part out of the scene.
const Z_MAX_MM = 300;

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

type GizmoControl = ElementRef<typeof TransformControls>;
type GizmoRef = MutableRefObject<GizmoControl | null>;

export type ViewportHandle = {
  // Captures the current canvas as a PNG blob (null if the renderer isn't ready).
  captureSnapshot(): Promise<Blob | null>;
};

const Viewport = forwardRef<ViewportHandle, {
  components: Component[];
  beam: BeamSegment[];
  board: Board;
  selected: string | null;
  isPlacing: boolean;
  placingAsset: string;
  libraryPreviews?: Record<string, Component>;
  onSelect: (name: string | null) => void;
  onMove: (name: string, x: number, y: number, z: number, rotZ: number) => void;
  onPlace?: (point: THREE.Vector3) => void;
  paraxialBeam?: ParaxialSegment[];

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
  components, beam, board, selected, isPlacing, placingAsset, libraryPreviews, onSelect, onMove, onPlace, paraxialBeam,
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
  const { theme } = useSettings();
  const bg = theme === "light" ? "#e7ebf1" : "#0c0e12";
  const [selectedRef, setSelectedRef] = useState<THREE.Group | null>(null);
  const refs = useRef<Record<string, THREE.Group | null>>({});
  const [selectedPinRef, setSelectedPinRef] = useState<THREE.Group | null>(null);
  const pinRefs = useRef<Record<string, THREE.Group | null>>({});
  const [previewPoint, setPreviewPoint] = useState<THREE.Vector3 | null>(null);
  const [pinPreviewPoint, setPinPreviewPoint] = useState<THREE.Vector3 | null>(null);
  const [smartGuideX, setSmartGuideX] = useState<number | null>(null);
  const [smartGuideY, setSmartGuideY] = useState<number | null>(null);
  // Height guide carries the y of the dragged part too, so the line is drawn
  // alongside it instead of somewhere arbitrary on the board.
  const [smartGuideZ, setSmartGuideZ] = useState<{ z: number; y: number } | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  // The move and rotate gizmos are two independent TransformControls, and each
  // raycasts the same pointerdown against its own handles. Where they overlap
  // on screen one drag would start both, so a Z move also nudged rotZ. Arm only
  // whichever was grabbed first: three fires "mouseDown" synchronously inside
  // its pointerdown handler, before the other control's listener runs.
  const translateGizmo = useRef<GizmoControl | null>(null);
  const rotateGizmo = useRef<GizmoControl | null>(null);

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
    setArmed(translateGizmo, gizmo === translateGizmo);
    setArmed(rotateGizmo, gizmo === rotateGizmo);
  };

  const armBoth = () => {
    setArmed(translateGizmo, true);
    setArmed(rotateGizmo, true);
  };

  // Safety net: a pointerup that never reaches the dragging control (lost
  // capture, cursor off-canvas) must not leave the other gizmo disabled.
  useEffect(() => {
    document.addEventListener("pointerup", armBoth);
    document.addEventListener("pointercancel", armBoth);
    return () => {
      document.removeEventListener("pointerup", armBoth);
      document.removeEventListener("pointercancel", armBoth);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    captureSnapshot: () =>
      new Promise<Blob | null>((resolve) => {
        // Wait two frames so a selection cleared just before this call has
        // actually unmounted its gizmo/guides and painted before we capture.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const renderer = rendererRef.current;
            if (!renderer) { resolve(null); return; }
            renderer.domElement.toBlob((blob) => resolve(blob), "image/png");
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
      if (!selected) return;

      const component = components.find((c) => c.name === selected);
      if (!component) return;

      let { x, y, z, rotZ } = component;

      if (e.shiftKey) {
        // Shift + Arrow Keys for Rotation
        const rotStep = 1;
        switch (e.key) {
          case "ArrowLeft":  rotZ -= rotStep; break;
          case "ArrowRight": rotZ += rotStep; break;
          default: return;
        }
      } else {
        // Arrow Keys (with optional Ctrl) for Translation;
        // PageUp/PageDown raise and lower the part (Shift is taken by rotation).
        const step = e.ctrlKey ? 10 : 1;
        switch (e.key) {
          case "ArrowUp":    y += step; break;
          case "ArrowDown":  y -= step; break;
          case "ArrowLeft":  x -= step; break;
          case "ArrowRight": x += step; break;
          case "PageUp":     z += step; break;
          case "PageDown":   z -= step; break;
          default: return;
        }
      }
      e.preventDefault();
      onMove(selected, x, y, clampZ(z), rotZ);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [selected, components, onMove, zFloor]);

  useEffect(() => {
    setSelectedRef(refs.current[selected!] ?? null);
    setSmartGuideX(null);
    setSmartGuideY(null);
    setSmartGuideZ(null);
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
    const guideX = axis.includes("X")
      ? nearestGuideX(selectedRef.position.x, selected) : null;
    const guideY = axis.includes("Y")
      ? nearestGuideY(selectedRef.position.y, selected) : null;
    // Clamp before snapping so the guide we report is the height we keep.
    selectedRef.position.z = clampZ(selectedRef.position.z);
    const guideZ = axis.includes("Z")
      ? nearestGuideZ(selectedRef.position.z, selected) : null;

    if (guideX !== null) selectedRef.position.x = guideX;
    if (guideY !== null) selectedRef.position.y = guideY;
    if (guideZ !== null) selectedRef.position.z = guideZ;
    setSmartGuideX(guideX);
    setSmartGuideY(guideY);
    setSmartGuideZ(guideZ === null ? null : { z: guideZ, y: selectedRef.position.y });
  };

  const handleTransformEnd = () => {
    setSmartGuideX(null);
    setSmartGuideY(null);
    setSmartGuideZ(null);
    if (!selectedRef || !selected) return;
    const x = selectedRef.position.x;
    const y = selectedRef.position.y;
    const z = clampZ(selectedRef.position.z);
    const rotZ = Math.round(selectedRef.rotation.z / DEG);
    onMove(selected, x, y, z, rotZ);
  };

  const setRef = (name: string, ref: THREE.Group | null) => {
    refs.current[name] = ref;
  };

  const handlePinTransformEnd = () => {
    if (!selectedPinRef || !selectedPinId) return;
    onMovePin?.(
      selectedPinId,
      Math.round(selectedPinRef.position.x),
      Math.round(selectedPinRef.position.y),
      selectedPinRef.position.z,
    );
  };

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      camera={{ fov: 35, near: 1, far: span * 12, position: [cx, cy - span, cz + span * 0.85] }}
      onCreated={({ camera, gl }) => {
        camera.up.set(0, 0, 1);            // Z-up to match USD
        camera.lookAt(center);
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
      <color attach="background" args={[bg]} />
      <hemisphereLight args={["#cfe0ff", "#10131a", 0.5]} />
      <ambientLight intensity={0.25} />
      <directionalLight
        position={[cx + span * 0.3, cy - span * 0.2, cz + span]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={1}
        shadow-camera-far={span * 4}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
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
      {paraxialBeam ? <ParaxialBeam segments={paraxialBeam} /> : <Beam segments={beam} />}

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

      {components.map((c) => (
        <Component3D
          key={c.name}
          c={c}
          selected={selected === c.name}
          setRef={setRef}
          onSelect={(name) => {
            onSelect(name);
            onSelectPin?.(null);
          }}
          onMove={onMove}
        />
      ))}

      {selectedRef && (
        <>
          <TransformControls
            ref={translateGizmo}
            object={selectedRef}
            mode="translate"
            showX={true}
            showY={true}
            showZ={true}
            translationSnap={1}
            size={0.7}
            onMouseDown={() => {
              armOnly(translateGizmo);
              setSmartGuideX(null);
              setSmartGuideY(null);
              setSmartGuideZ(null);
            }}
            onObjectChange={handleTransformChange}
            onMouseUp={() => {
              armBoth();
              handleTransformEnd();
            }}
          />
          <TransformControls
            ref={rotateGizmo}
            object={selectedRef}
            mode="rotate"
            showX={false}
            showY={false}
            showZ={true}
            rotationSnap={Math.PI / 180}
            // Bigger than the move gizmo on purpose: the rotation ring's pick
            // radius is 1.0 against the arrows' 1.1, so at equal size the ring
            // sits right on top of the arrow tips. Pushing it out keeps the two
            // grabbable areas visually and physically separate.
            size={1.15}
            onMouseDown={() => armOnly(rotateGizmo)}
            onMouseUp={() => {
              armBoth();
              handleTransformEnd();
            }}
          />
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
          translationSnap={1}
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
      <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
        <GizmoViewport axisColors={["#e5534b", "#2ea043", "#4c8dff"]} labelColor="white" />
      </GizmoHelper>

      <EffectComposer>
        <Bloom luminanceThreshold={0.8} intensity={0.4} mipmapBlur radius={0.4} />
      </EffectComposer>
    </Canvas>
  );
});

export default Viewport;
