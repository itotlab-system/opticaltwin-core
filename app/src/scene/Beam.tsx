import { useMemo } from "react";
import * as THREE from "three";
import type { ReactNode } from "react";
import { Html, Line } from "@react-three/drei";
import type { BeamSegment } from "../types";
import { DEFAULT_BEAM_WIDTH_MM, drawnLengthOf, naturalLengthOf } from "../beamShape";

const YAXIS = new THREE.Vector3(0, 1, 0);
// A leg drawn thinner than this disappears against a 600 mm bench.
const MIN_R = 0.35;
// Cap so a deliberately fat sketch can't swallow the whole setup.
const MAX_R = 40;
// A generous invisible cylinder around each leg, so a thin beam is still easy
// to click among the mounts and posts without having to aim at a hairline.
const PICK_R = 7;

// Wavelength (nm) → saturated hex color. UV/IR use false-color so they stay visible.
function wavelengthToColor(nm: number): string {
  if (nm < 400) return "#cc00ff";
  if (nm < 450) return "#6600ff";
  if (nm < 495) return "#0088ff";
  if (nm < 530) return "#00ff44";
  if (nm < 590) return "#bbff00";
  if (nm < 625) return "#ff8800";
  if (nm < 750) return "#ff2200";
  return "#ff0044";
}

type Frustum = {
  key: string;
  segKey: string | undefined;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  r0: number;
  r1: number;
  height: number;
  color: string;
  opacity: number;
};

const clampR = (mm: number) => Math.max(MIN_R, Math.min(mm / 2, MAX_R));

/**
 * Planning beam: straight legs between components (geometric folds only — no
 * optics physics), drawn at the width sketched for each leg.
 *
 * The legs are the editable thing — click one to select it and the caller
 * anchors its editor beside it. A leg is one tapered tube, or two when it is
 * pinched to a waist. Bloom from the EffectComposer in Viewport adds the glow.
 */
export default function Beam({
  segments, selectedKey = null, onSelect, editor,
}: {
  segments: BeamSegment[];
  selectedKey?: string | null;
  onSelect?: (seg: BeamSegment | null) => void;
  /** Rendered next to the selected leg, in 3D. */
  editor?: ReactNode;
}) {
  const { frustums, centerlines, picks, anchor } = useMemo(() => {
    const frustums: Frustum[] = [];
    const centerlines: {
      key: string; pts: [number, number, number][]; color: string;
    }[] = [];
    // One fat invisible cylinder per leg, purely to catch clicks.
    const picks: {
      key: string; seg: BeamSegment; pos: THREE.Vector3;
      quat: THREE.Quaternion; height: number;
    }[] = [];
    let anchor: THREE.Vector3 | null = null;

    segments.forEach((seg, si) => {
      if (seg.pts.length < 2) return;
      const color = wavelengthToColor(seg.wavelength);
      const intensity = Math.max(0.05, Math.min(1, seg.intensity ?? 1));
      const start = new THREE.Vector3(...seg.pts[0]);
      const finish = new THREE.Vector3(...seg.pts[1]);
      const full = finish.clone().sub(start);
      const totalLength = full.length();
      if (totalLength < 1e-4) return;
      const dir = full.clone().normalize();

      // How far this leg is drawn. Sketch only: shortening it leaves the optic
      // at the far end exactly where it is.
      const drawn = Math.max(drawnLengthOf(seg), 0.01);
      const tip = start.clone().addScaledVector(dir, drawn);
      centerlines.push({
        key: `cl-${si}`,
        pts: [seg.pts[0], [tip.x, tip.y, tip.z]],
        color,
      });

      const wIn = seg.wIn ?? DEFAULT_BEAM_WIDTH_MM;
      const wOut = seg.wOut ?? DEFAULT_BEAM_WIDTH_MM;
      // wOut belongs at the leg's real far end, so a beam drawn short stops
      // part-way up the taper rather than jumping to its final width.
      const endWidth = wIn + (wOut - wIn) * Math.min(1, drawn / totalLength);

      const band = (t0: number, t1: number, w0: number, w1: number, tag: string) => {
        const height = drawn * (t1 - t0);
        if (height < 1e-3) return;
        const p0 = start.clone().addScaledVector(dir, drawn * t0);
        const p1 = start.clone().addScaledVector(dir, drawn * t1);
        frustums.push({
          key: `${si}-${tag}`,
          segKey: seg.key,
          pos: p0.clone().add(p1).multiplyScalar(0.5),
          quat: new THREE.Quaternion().setFromUnitVectors(YAXIS, dir),
          r0: clampR(w0),
          r1: clampR(w1),
          height,
          color,
          opacity: intensity,
        });
      };

      if (seg.waistW !== undefined) {
        const at = Math.min(0.95, Math.max(0.05, seg.waistAt ?? 0.5));
        band(0, at, wIn, seg.waistW, "a");
        band(at, 1, seg.waistW, wOut, "b");
      } else {
        band(0, 1, wIn, endWidth, "a");
      }

      const mid = start.clone().addScaledVector(dir, drawn / 2);
      const quat = new THREE.Quaternion().setFromUnitVectors(YAXIS, dir);
      picks.push({ key: seg.key ?? `p-${si}`, seg, pos: mid, quat, height: drawn });
      // The editor hangs off the leg's *natural* midpoint, not the drawn one:
      // anchoring it to the drawn tip would slide the card out from under the
      // pointer while you drag the Length bar.
      if (seg.key && seg.key === selectedKey) {
        anchor = start.clone().addScaledVector(dir, naturalLengthOf(seg) / 2);
      }
    });

    return { frustums, centerlines, picks, anchor };
  }, [segments, selectedKey]);

  return (
    <>
      {frustums.map(({ key, segKey, pos, quat, r0, r1, height, color, opacity }) => (
        <group key={key}>
          {/* Selected leg gets a bright sheath, so the picked stretch is
              obvious without hiding the beam under it. */}
          {segKey && segKey === selectedKey && (
            <mesh position={pos} quaternion={quat} raycast={() => null}>
              <cylinderGeometry args={[r1 * 1.5, r0 * 1.5, height, 16, 1, true]} />
              <meshBasicMaterial
                color="#ff3b30"
                side={THREE.DoubleSide}
                transparent
                opacity={0.3}
                depthWrite={false}
              />
            </mesh>
          )}
          {/* Soft outer shell, additive so crossing beams glow rather than
              flatten into each other. */}
          <mesh position={pos} quaternion={quat}>
            <cylinderGeometry args={[r1, r0, height, 14, 1, true]} />
            <meshBasicMaterial
              color={color}
              side={THREE.DoubleSide}
              transparent
              opacity={0.32 * opacity}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </mesh>
          {/* Brighter core at half the radius. */}
          <mesh position={pos} quaternion={quat}>
            <cylinderGeometry args={[r1 * 0.5, r0 * 0.5, height, 14, 1, true]} />
            <meshBasicMaterial
              color={color}
              side={THREE.DoubleSide}
              transparent
              opacity={0.75 * opacity}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </mesh>
        </group>
      ))}
      {centerlines.map(({ key, pts, color }) => (
        <Line key={key} points={pts} color={color} lineWidth={1.6} />
      ))}

      {/* Click targets. Invisible and wider than the beam so a hairline leg is
          still easy to hit; drawn last so they take precedence over the tubes. */}
      {onSelect && picks.map(({ key, seg, pos, quat, height }) => (
        <mesh
          key={`pick-${key}`}
          position={pos}
          quaternion={quat}
          onPointerDown={(e) => {
            e.stopPropagation();
            onSelect(seg);
          }}
        >
          <cylinderGeometry args={[PICK_R, PICK_R, height, 8, 1, true]} />
          <meshBasicMaterial visible={false} side={THREE.DoubleSide} />
        </mesh>
      ))}

      {editor && anchor && (
        <Html
          position={anchor}
          center={false}
          zIndexRange={[40, 30]}
          style={{ pointerEvents: "auto" }}
        >
          {editor}
        </Html>
      )}
    </>
  );
}
