import { Instances, Instance } from "@react-three/drei";
import type { Vector3 } from "three";
import type { Board } from "../types";

export default function Breadboard({
  board,
  onPlace,
  onPreviewMove,
  onBoardClick,
  onBoardPointerMove,
}: {
  board: Board;
  onPlace?: (point: Vector3) => void;
  onPreviewMove?: (point: Vector3 | null) => void;
  onBoardClick?: (x: number, y: number, z: number) => void;
  onBoardPointerMove?: (point: Vector3 | null) => void;
}) {
  if (!board.bbox) return null;

  const { min, max } = board.bbox;

  const size: [number, number, number] = [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ];

  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];

  const top = max[2];

  return (
    <group>
      <mesh
        position={center}
        receiveShadow
      >
        <boxGeometry args={size} />
        <meshStandardMaterial
          color="#6e747d"
          metalness={0.5}
          roughness={0.55}
        />
      </mesh>

      {(onPlace || onPreviewMove) && (
        <mesh
          position={[center[0], center[1], top + 0.8]}
          onPointerMove={(e) => {
            e.stopPropagation();
            onPreviewMove?.(e.point);
          }}
          onPointerOut={() => onPreviewMove?.(null)}
          onClick={(e) => {
            e.stopPropagation();
            onPlace?.(e.point);
          }}
        >
          <planeGeometry args={[size[0], size[1]]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {/*
        Invisible click surface for placing pins.

        This mesh is only rendered when onBoardClick is provided.
        In normal mode, it does not exist.

        Why this is needed:
        Clicking directly on the breadboard or hole instances can be unstable,
        because other objects may interfere with pointer events.
        This transparent plane gives us a clean click target.
      */}
      {onBoardClick && (
        <mesh
          position={[center[0], center[1], top + 0.8]}
          onPointerMove={(e) => {
            e.stopPropagation();
            const point = e.point.clone();
            point.z = top;
            onBoardPointerMove?.(point);
          }}
          onPointerOut={() => onBoardPointerMove?.(null)}
          onClick={(e) => {
            // Prevent this click from also selecting other 3D objects.
            e.stopPropagation();

            // e.point contains the clicked 3D position.
            // x and y come from the clicked point.
            // z is fixed to the top surface of the breadboard.
            onBoardClick(e.point.x, e.point.y, top);
          }}
        >
          {/* Same size as the breadboard top area */}
          <planeGeometry args={[size[0], size[1]]} />

          {/* Fully transparent, but still receives click events */}
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {board.holes.length > 0 && (
        <Instances limit={board.holes.length} range={board.holes.length}>
          {/* A shallow dark counterbore per hole, sitting on the top face */}
          <cylinderGeometry args={[3, 3, 2.4, 12]} />
          <meshStandardMaterial
            color="#23262c"
            metalness={0.4}
            roughness={0.7}
          />

          {board.holes.map(([hx, hy], i) => (
            <Instance
              key={i}
              position={[hx, hy, top - 0.6]}
              rotation={[Math.PI / 2, 0, 0]}
            />
          ))}
        </Instances>
      )}
    </group>
  );
}
