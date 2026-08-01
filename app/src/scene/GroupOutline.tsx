import { Html, Line } from "@react-three/drei";
import type * as THREE from "three";
import type { Component } from "../types";
import { groupBounds } from "../groups";

/**
 * Dashed box around a group's members, drawn only while that group is
 * selected. Showing a box for every group cluttered the viewport and landed in
 * snapshots, so grouping is advertised by the Outliner instead; the box is a
 * cue for the group you are actually editing. Snapshots clear the selection
 * before capturing, so this unmounts and never reaches the PNG.
 */
export default function GroupOutline({
  components, members, color, label, selected, setRef,
}: {
  components: Component[];
  members: string[];
  color: string;
  label?: string;
  selected: boolean;
  // Exposes the wrapper so a group drag can carry the box along with the
  // parts instead of leaving it behind until the move is saved.
  setRef?: (ref: THREE.Group | null) => void;
}) {
  if (!selected) return null;

  const bounds = groupBounds(components, members);
  if (!bounds) return null;

  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;

  // Twelve edges of the box as three polylines (bottom loop, top loop, risers).
  const bottom: [number, number, number][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0],
  ];
  const top: [number, number, number][] = [
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1],
  ];
  const risers: [number, number, number][][] = [
    [[x0, y0, z0], [x0, y0, z1]],
    [[x1, y0, z0], [x1, y0, z1]],
    [[x1, y1, z0], [x1, y1, z1]],
    [[x0, y1, z0], [x0, y1, z1]],
  ];

  const common = {
    color,
    lineWidth: 2,
    dashed: true,
    dashSize: 10,
    gapSize: 5,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    renderOrder: 9,
  } as const;

  return (
    <group ref={setRef}>
      <Line points={bottom} {...common} />
      <Line points={top} {...common} />
      {risers.map((points, i) => <Line key={i} points={points} {...common} />)}
      {label && (
        <Html position={[x0, y1, z1]} style={{ pointerEvents: "none" }}>
          <div className="group-label sel" style={{ borderColor: color, color }}>
            {label}
          </div>
        </Html>
      )}
    </group>
  );
}
