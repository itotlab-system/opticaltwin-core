import { Line } from "@react-three/drei";
import type { BeamSegment } from "../types";

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

// Planning beam: straight polylines (geometric folds only — no optics physics).
// Bloom from the EffectComposer in Viewport produces the laser glow effect.
export default function Beam({ segments }: { segments: BeamSegment[] }) {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.pts.length < 2) return null;
        const color = wavelengthToColor(seg.wavelength);
        const intensity = Math.max(0.05, Math.min(1, seg.intensity ?? 1));
        return (
          <Line
            key={i}
            points={seg.pts}
            color={color}
            lineWidth={1.25 + 1.25 * intensity}
            transparent={intensity < 1}
            opacity={intensity}
          />
        );
      })}
    </>
  );
}
