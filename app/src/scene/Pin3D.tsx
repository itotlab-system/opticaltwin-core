import { Html } from "@react-three/drei";
import type { Group } from "three";
import type { PinAnnotation } from "../types";

export default function Pin3D({
  pin,
  selected,
  onSelect,
  onDelete,
  onEdit,
  setRef,
  ghost = false,
}: {
  pin: PinAnnotation;
  selected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit?: (id: string) => void;
  setRef?: (id: string, ref: Group | null) => void;
  ghost?: boolean;
}) {
  const size = pin.size ?? 1;
  const needleHeight = 28 * size;
  const headRadius = 7 * size;
  const timeText = new Date(pin.createdAt).toLocaleString("ja-JP");

  return (
    <group
      ref={(ref) => setRef?.(pin.id, ref)}
      position={[pin.x, pin.y, pin.z]}
      onClick={ghost ? undefined : (e) => {
        e.stopPropagation();
        onSelect(pin.id);
      }}
      onPointerOver={ghost ? undefined : (e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={ghost ? undefined : () => {
        document.body.style.cursor = "auto";
      }}
    >
      {/* ピンの針 */}
      <mesh
        position={[0, 0, needleHeight / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        castShadow={!ghost}
        raycast={ghost ? () => null : undefined}
      >
        <coneGeometry args={[5 * size, needleHeight, 24]} />
        <meshStandardMaterial color={pin.color} roughness={0.35} transparent={ghost} opacity={ghost ? 0.4 : 1} depthWrite={!ghost} />
      </mesh>

      {/* ピンの丸い頭 */}
      <mesh position={[0, 0, needleHeight + headRadius]} castShadow={!ghost} raycast={ghost ? () => null : undefined}>
        <sphereGeometry args={[headRadius, 24, 24]} />
        <meshStandardMaterial
          color={pin.color}
          emissive={selected ? pin.color : "#000000"}
          emissiveIntensity={selected ? 0.5 : 0}
          roughness={0.3}
          transparent={ghost}
          opacity={ghost ? 0.4 : 1}
          depthWrite={!ghost}
        />
      </mesh>

      {/* ラベル */}
      {!ghost && <Html
        position={[0, 0, needleHeight + headRadius * 3]}
        center
        transform
        sprite
        distanceFactor={80}
    >
        <div className={`pin-label${selected ? " selected" : ""}`}>
          <div className="pin-label-title">{pin.label || "New pin"}</div>
          <div className="pin-label-meta">{pin.authorName}</div>
          <div className="pin-label-time">{timeText}</div>

          {selected && (
            <div className="pin-action-buttons">
              <button
                className="pin-edit-button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit?.(pin.id);
                }}
              >
                Edit
              </button>
              <button
                className="pin-delete-button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(pin.id);
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </Html>}
    </group>
  );
}
