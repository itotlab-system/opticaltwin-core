import { useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import type { ParaxialSegment } from "../types";

const YAXIS = new THREE.Vector3(0, 1, 0);
const MIN_R = 0.3;   // mm — minimum display radius for visibility
const MAX_R = 15;    // mm — cap so tube doesn't occlude other components

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

// Each pair of consecutive samples becomes a frustum (truncated cone).
// Rendered twice: a wide translucent outer shell + a bright additive inner shell,
// giving a volumetric laser-beam appearance similar to the real lab photo.
export default function ParaxialBeam({ segments }: { segments: ParaxialSegment[] }) {
  const frustums = useMemo(() => {
    const out: {
      key: string;
      pos: THREE.Vector3;
      quat: THREE.Quaternion;
      r0: number;
      r1: number;
      height: number;
      color: string;
    }[] = [];

    for (const [si, seg] of segments.entries()) {
      if (seg.pts.length < 2) continue;
      const color = wavelengthToColor(seg.wavelength);

      for (let i = 0; i < seg.pts.length - 1; i++) {
        const v0 = new THREE.Vector3(...seg.pts[i]);
        const v1 = new THREE.Vector3(...seg.pts[i + 1]);
        const dir = v1.clone().sub(v0);
        const h = dir.length();
        if (h < 0.01) continue;
        dir.normalize();
        const quat = new THREE.Quaternion().setFromUnitVectors(YAXIS, dir);
        const pos = v0.clone().add(v1).multiplyScalar(0.5);
        const r0 = Math.max(MIN_R, Math.min(seg.widths[i], MAX_R));
        const r1 = Math.max(MIN_R, Math.min(seg.widths[i + 1], MAX_R));
        out.push({ key: `${si}-${i}`, pos, quat, r0, r1, height: h, color });
      }
    }
    return out;
  }, [segments]);

  // Centerlines for each segment (bright spine through the tube)
  const centerlines = useMemo(() =>
    segments.map((seg, i) => ({
      key: `cl-${i}`,
      pts: seg.pts,
      color: wavelengthToColor(seg.wavelength),
    })),
    [segments]);

  return (
    <>
      {frustums.map(({ key, pos, quat, r0, r1, height, color }) => (
        <group key={key}>
          {/* Outer soft shell — wide, very transparent, additive so it glows */}
          <mesh position={pos} quaternion={quat}>
            <cylinderGeometry args={[r1, r0, height, 10, 1, true]} />
            <meshBasicMaterial
              color={color}
              side={THREE.DoubleSide}
              transparent
              opacity={0.18}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </mesh>
          {/* Inner brighter shell — half radius, stronger opacity */}
          <mesh position={pos} quaternion={quat}>
            <cylinderGeometry args={[r1 * 0.5, r0 * 0.5, height, 10, 1, true]} />
            <meshBasicMaterial
              color={color}
              side={THREE.DoubleSide}
              transparent
              opacity={0.45}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </mesh>
        </group>
      ))}
      {/* Bright centerline spine */}
      {centerlines.map(({ key, pts, color }) =>
        pts.length >= 2 ? (
          <Line key={key} points={pts} color={color} lineWidth={1.5} />
        ) : null
      )}
    </>
  );
}
