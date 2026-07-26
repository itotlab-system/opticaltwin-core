import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useGLTF, Html } from "@react-three/drei";
import type {
  Component,
  ComponentMesh,
  ComponentPrimitive,
} from "../types";
import { MODELS, type ModelDef } from "./models";

const DEG = Math.PI / 180;
const DISC = new Set(["lens", "polarizer", "mirror", "iris"]);

function num(c: Component, key: string, def: number): number {
  const v = c.attrs[key];
  return typeof v === "number" ? v : def;
}

function discRadius(c: Component): number {
  return (c.type === "iris" ? num(c, "outerDiameter_mm", 25.4) : num(c, "diameter_mm", 25.4)) / 2;
}

// Approximate XY footprint radius used for the selection ring.
function footRadius(c: Component): number {
  if (DISC.has(c.type)) return discRadius(c) + 5;
  const r: Record<string, number> = {
    beamsplitter: 22, slm: 42, camera: 68, laser: 28,
    eyepiece: 22, detector: 12, cylindrical_lens: 18,
  };
  return r[c.type] ?? 18;
}

// A lens-tube / cage-plate ring around a disc optic (clear aperture faces +X).
function MountRing({ r, selected }: { r: number; selected: boolean }) {
  return (
    <mesh rotation={[0, Math.PI / 2, 0]} castShadow>
      <torusGeometry args={[r + 2.5, 2.2, 12, 40]} />
      <meshStandardMaterial {...mat("#34373d", selected, { metalness: 0.75, roughness: 0.35 })} />
    </mesh>
  );
}

// A loaded glTF model, lined up to our convention. Used when MODELS has the type.
function makeGhost(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const ghostMaterials = materials.map((source) => {
      const material = source.clone();
      material.transparent = true;
      material.opacity = 0.4;
      material.depthWrite = false;
      return material;
    });
    object.material = Array.isArray(object.material) ? ghostMaterials : ghostMaterials[0];
    object.castShadow = false;
    object.receiveShadow = false;
    object.raycast = () => null;
  });
}

function GltfModel({ def, ghost = false }: { def: ModelDef; ghost?: boolean }) {
  const { scene } = useGLTF(def.url);
  const obj = useMemo(() => {
    const clone = scene.clone(true);
    if (ghost) makeGhost(clone);
    return clone;
  }, [scene, ghost]);
  return (
    <group scale={def.scale ?? 1} rotation={def.rot ?? [0, 0, 0]}>
      <primitive object={obj} />
    </group>
  );
}

function UsdMesh({ data, componentType, metalness, roughness, selected, ghost }: {
  data: ComponentMesh;
  componentType: string;
  metalness?: number;
  roughness?: number;
  selected: boolean;
  ghost: boolean;
}) {
  const geometry = useMemo(() => {
    const result = new THREE.BufferGeometry();
    result.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(data.points.flat(), 3),
    );
    result.setIndex(data.indices);
    result.computeVertexNormals();
    result.computeBoundingSphere();
    return result;
  }, [data]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  const color = new THREE.Color(...data.color);
  const opacity = ghost ? 0.4 : 1;
  const transparent = ghost || data.opacity < 1;
  const glass = !ghost && data.opacity < 1;
  const mirror = !ghost && componentType === "mirror";
  const materialMetalness = ghost ? 0 : data.metalness ?? metalness ?? (mirror ? 0.9 : 0);
  const materialRoughness = data.roughness ?? roughness ?? (mirror ? 0.08 : glass ? 0.03 : 0.35);
  return (
    <mesh geometry={geometry} castShadow={!ghost} receiveShadow={!ghost}>
      <meshPhysicalMaterial
        {...mat(`#${color.getHexString()}`, selected, {
          metalness: materialMetalness,
          roughness: materialRoughness,
          transparent,
          opacity,
          transmission: glass ? 0.98 : 0,
          thickness: glass ? 1.5 : 0,
          ior: glass ? 1.5 : 1,
          envMapIntensity: glass ? 1.2 : 1,
          depthWrite: !ghost,
          // Respect the USDA setting even for transparent optical surfaces so
          // planar geometry remains visible from both viewing directions.
          side: data.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        })}
      />
    </mesh>
  );
}

function UsdPrimitive({ data, componentType, metalness, roughness, selected, ghost }: {
  data: ComponentPrimitive;
  componentType: string;
  metalness?: number;
  roughness?: number;
  selected: boolean;
  ghost: boolean;
}) {
  const geometry = useMemo(() => {
    let result: THREE.BufferGeometry;
    if (data.kind === "cube") {
      result = new THREE.BoxGeometry(
        data.size ?? 1,
        data.size ?? 1,
        data.size ?? 1,
      );
    } else if (data.kind === "sphere") {
      const spherePortion = data.spherePortion
        ?? (componentType === "lens" ? "positiveX" : "full");
      const hemisphere = spherePortion !== "full";
      result = new THREE.SphereGeometry(
        data.radius ?? 1,
        32,
        16,
        spherePortion === "positiveX"
          ? Math.PI / 2
          : spherePortion === "negativeX"
            ? -Math.PI / 2
            : 0,
        hemisphere ? Math.PI : Math.PI * 2,
      );
    } else {
      const height = data.height ?? 2;
      result = new THREE.CylinderGeometry(
        data.radius ?? 1,
        data.radius ?? 1,
        height,
        48,
        1,
        false,
      );
      if (data.capSide && data.capSide !== "both") {
        const positions = result.getAttribute("position");
        const sourceIndex = result.getIndex();
        if (sourceIndex) {
          const halfHeight = height / 2;
          const epsilon = Math.max(height * 1e-6, 1e-7);
          const keepTop = data.capSide === "negativeX";
          const filtered: number[] = [];
          for (let offset = 0; offset < sourceIndex.count; offset += 3) {
            const triangle = [
              sourceIndex.getX(offset),
              sourceIndex.getX(offset + 1),
              sourceIndex.getX(offset + 2),
            ];
            const atTop = triangle.every(
              (index) => Math.abs(positions.getY(index) - halfHeight) <= epsilon,
            );
            const atBottom = triangle.every(
              (index) => Math.abs(positions.getY(index) + halfHeight) <= epsilon,
            );
            if ((atTop && !keepTop) || (atBottom && keepTop)) continue;
            filtered.push(...triangle);
          }
          result.setIndex(filtered);
        }
      }
      const axis = (data.axis ?? "Z").toUpperCase();
      if (axis === "X") result.rotateZ(Math.PI / 2);
      if (axis === "Z") result.rotateX(Math.PI / 2);
    }
    return result;
  }, [data, componentType]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const transform = useMemo(
    () => new THREE.Matrix4().fromArray(data.matrix),
    [data.matrix],
  );
  const color = new THREE.Color(...data.color);
  const opacity = ghost ? Math.min(data.opacity, 0.4) : data.opacity;
  const transparent = ghost || opacity < 1;
  const glass = !ghost && data.opacity < 1;
  const mirror = !ghost && componentType === "mirror";
  const materialMetalness = ghost ? 0 : data.metalness ?? metalness ?? (mirror ? 0.9 : 0);
  const materialRoughness = data.roughness ?? roughness ?? (mirror ? 0.08 : glass ? 0.03 : 0.35);
  return (
    <mesh
      geometry={geometry}
      matrix={transform}
      matrixAutoUpdate={false}
      castShadow={!ghost}
      receiveShadow={!ghost}
    >
      <meshPhysicalMaterial
        {...mat(`#${color.getHexString()}`, selected, {
          metalness: materialMetalness,
          roughness: materialRoughness,
          transparent,
          opacity,
          transmission: glass ? 0.98 : 0,
          thickness: glass ? 1.5 : 0,
          ior: glass ? 1.5 : 1,
          depthWrite: !transparent,
          side: data.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        })}
      />
    </mesh>
  );
}

function UsdGeometry({ c, selected, ghost }: {
  c: Component;
  selected: boolean;
  ghost: boolean;
}) {
  return (
    <group>
      {c.meshes?.map((mesh, index) => (
        <UsdMesh
          key={`mesh-${index}`}
          data={mesh}
          componentType={c.type}
          metalness={typeof c.attrs.metalness === "number" ? c.attrs.metalness : undefined}
          roughness={typeof c.attrs.roughness === "number" ? c.attrs.roughness : undefined}
          selected={selected}
          ghost={ghost}
        />
      ))}
      {c.primitives?.map((primitive, index) => (
        <UsdPrimitive
          key={`primitive-${index}`}
          data={primitive}
          componentType={c.type}
          metalness={typeof c.attrs.metalness === "number" ? c.attrs.metalness : undefined}
          roughness={typeof c.attrs.roughness === "number" ? c.attrs.roughness : undefined}
          selected={selected}
          ghost={ghost}
        />
      ))}
    </group>
  );
}

// material props with a selection highlight (emissive)
function mat(color: string, selected: boolean, extra: object = {}) {
  return {
    color,
    emissive: selected ? "#3a7bff" : "#000000",
    emissiveIntensity: selected ? 0.5 : 0,
    ...extra,
  };
}

// Geometry for one optical part, in its LOCAL frame (clear aperture faces +X).
// A Three cylinder is Y-aligned, so rotate it +90° about Z to point along X.
function Part({ c, selected }: { c: Component; selected: boolean }) {
  const xCyl: [number, number, number] = [0, 0, Math.PI / 2];
  switch (c.type) {
    case "lens": {
      const r = num(c, "diameter_mm", 25.4) / 2;
      const thickness = num(c, "thickness_mm", 3.79);
      const edge = num(c, "edgeThickness_mm", Math.max(thickness * 0.5, 0.2));
      const sag = num(c, "convexSag_mm", Math.max(thickness - edge, 0.1));
      const cx = num(c, "centerX_mm", 0);
      const cy = num(c, "centerY_mm", 0);
      const cz = num(c, "centerZ_mm", 0);
      const convexBaseX = num(c, "convexBaseX_mm", cx + thickness / 2 - sag);
      const edgeCenterX = cx - thickness / 2 + edge / 2;
      return (
        <group>
          <mesh position={[edgeCenterX, cy, cz]} rotation={xCyl} castShadow>
            <cylinderGeometry args={[r, r, edge, 96]} />
            <meshPhysicalMaterial
              {...mat("#d9f3ff", selected, {
                metalness: 0, roughness: 0.03, transparent: true,
                opacity: 0.35, transmission: 0.92, thickness: 1.5, ior: 1.5,
              })}
            />
          </mesh>
          <mesh position={[convexBaseX, cy, cz]} scale={[sag, r, r]} castShadow>
            <sphereGeometry args={[1, 32, 16]} />
            <meshPhysicalMaterial
              {...mat("#d9f3ff", selected, {
                metalness: 0, roughness: 0.03, transparent: true,
                opacity: 0.28, transmission: 0.95, thickness: 1.5, ior: 1.5,
              })}
            />
          </mesh>
        </group>
      );
    }
    case "polarizer": {
      const r = num(c, "diameter_mm", 25.4) / 2;
      return (
        <mesh rotation={xCyl} castShadow>
          <cylinderGeometry args={[r, r, 5, 96]} />
          <meshStandardMaterial
            {...mat("#4a4060", selected, {
              metalness: 0, roughness: 0.5,
            })}
          />
        </mesh>
      );
    }
    case "mirror": {
      const r = num(c, "diameter_mm", 25.4) / 2;
      const thickness = num(c, "thickness_mm", num(c, "sizeX_mm", 6));
      return (
        <mesh rotation={xCyl} castShadow>
          <cylinderGeometry args={[r, r, thickness, 48]} />
          <meshStandardMaterial {...mat("#d8d8e0", selected, { metalness: 0.9, roughness: 0.08 })} />
        </mesh>
      );
    }
    case "beamsplitter": {
      const s = num(c, "size_mm", 25.4);
      const o = 15;                       // 30 mm cage half-spacing
      const rods: [number, number][] = [[o, o], [o, -o], [-o, o], [-o, -o]];
      return (
        <group>
          <mesh castShadow>
            <boxGeometry args={[s, s, s]} />
            <meshStandardMaterial {...mat("#9fd0e0", selected, { metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.4 })} />
          </mesh>
          {/* 45° internal splitting interface (X–Y fold) */}
          <mesh rotation={[0, 0, Math.PI / 4]}>
            <boxGeometry args={[s * 1.38, 0.4, s]} />
            <meshStandardMaterial color="#cfe6ef" metalness={0.2} roughness={0.1} transparent opacity={0.5} />
          </mesh>
          {/* 30 mm cage rods through the cube (along X) */}
          {rods.map(([dy, dz], i) => (
            <mesh key={i} position={[0, dy, dz]} rotation={xCyl}>
              <cylinderGeometry args={[1.5, 1.5, s * 2.4, 12]} />
              <meshStandardMaterial {...mat("#b8bcc2", selected, { metalness: 0.9, roughness: 0.25 })} />
            </mesh>
          ))}
        </group>
      );
    }
    case "slm": {
      const pw = num(c, "activeWidth_mm", 15.4), ph = num(c, "activeHeight_mm", 9.2);
      const cx = num(c, "centerX_mm", 0), cy = num(c, "centerY_mm", 0), cz = num(c, "centerZ_mm", 0);
      const sx = num(c, "sizeX_mm", 28), sy = num(c, "sizeY_mm", 64), sz = num(c, "sizeZ_mm", 52);
      const panelThickness = num(c, "panelThickness_mm", 1);
      return (
        <group>
          <mesh position={[num(c, "bodyCenterX_mm", cx), cy, cz]} castShadow>
            <boxGeometry args={[num(c, "bodySizeX_mm", sx), sy, sz]} />
            <meshStandardMaterial {...mat("#c0392b", selected, { metalness: 0.5, roughness: 0.35 })} />
          </mesh>
          <mesh position={[
            num(c, "panelX_mm", cx + sx / 2),
            num(c, "panelY_mm", cy),
            num(c, "panelZ_mm", cz),
          ]}>
            <boxGeometry args={[panelThickness, pw, ph]} />
            <meshStandardMaterial {...mat("#555b61", selected, { metalness: 0.1, roughness: 0.65 })} />
          </mesh>
        </group>
      );
    }
    case "iris": {
      const ro = num(c, "outerDiameter_mm", 25.4) / 2, ra = num(c, "aperture_mm", 4) / 2;
      const center: [number, number, number] = [
        num(c, "centerX_mm", 0),
        num(c, "centerY_mm", 0),
        num(c, "centerZ_mm", 0),
      ];
      return (
        <group position={center} rotation={xCyl}>
          <mesh castShadow>
            <cylinderGeometry args={[ro, ro, num(c, "thickness_mm", 4), 48]} />
            <meshStandardMaterial {...mat("#15151a", selected, { metalness: 0.3, roughness: 0.6 })} />
          </mesh>
          <mesh>
            <cylinderGeometry args={[ra, ra, 4.5, 32]} />
            <meshStandardMaterial {...mat("#e6d23a", selected, { emissiveIntensity: selected ? 0.5 : 0.2, emissive: "#e6d23a" })} />
          </mesh>
        </group>
      );
    }
    case "cylindrical_lens":
      return (
        <mesh castShadow>
          <boxGeometry args={[6, 25.4, 25.4]} />
          <meshStandardMaterial {...mat("#7fd0e6", selected, { metalness: 0, roughness: 0.1, transparent: true, opacity: 0.55 })} />
        </mesh>
      );
    case "eyepiece": {
      const r = num(c, "barrelDiameter_mm", 31.7) / 2;
      return (
        <group>
          {/* chrome insertion barrel (-X, toward the beam) */}
          <mesh position={[-30, 0, 0]} rotation={xCyl} castShadow>
            <cylinderGeometry args={[r * 0.72, r * 0.72, 26, 40]} />
            <meshStandardMaterial {...mat("#9aa0a8", selected, { metalness: 0.9, roughness: 0.2 })} />
          </mesh>
          {/* main body */}
          <mesh rotation={xCyl} castShadow>
            <cylinderGeometry args={[r, r, 34, 40]} />
            <meshStandardMaterial {...mat("#17181c", selected, { metalness: 0.5, roughness: 0.35 })} />
          </mesh>
          {/* Meade green accent ring */}
          <mesh position={[10, 0, 0]} rotation={xCyl}>
            <cylinderGeometry args={[r + 0.6, r + 0.6, 5, 40]} />
            <meshStandardMaterial color="#1f8a4c" metalness={0.4} roughness={0.4}
              emissive={selected ? "#3a7bff" : "#000000"} emissiveIntensity={selected ? 0.4 : 0} />
          </mesh>
          {/* eyecup (+X, wider) */}
          <mesh position={[28, 0, 0]} rotation={xCyl} castShadow>
            <cylinderGeometry args={[r * 1.28, r, 18, 40]} />
            <meshStandardMaterial {...mat("#101012", selected, { metalness: 0.3, roughness: 0.6 })} />
          </mesh>
        </group>
      );
    }
    case "camera": {
      const bx = 60;
      return (
        <group>
          {/* body */}
          <mesh castShadow>
            <boxGeometry args={[bx, 126, 96]} />
            <meshStandardMaterial {...mat("#1c1c1f", selected, { metalness: 0.4, roughness: 0.45 })} />
          </mesh>
          {/* lens barrel on -X (facing the incoming beam) */}
          <mesh position={[-(bx / 2) - 22, 0, 0]} rotation={xCyl} castShadow>
            <cylinderGeometry args={[26, 30, 44, 40]} />
            <meshStandardMaterial {...mat("#0e0e10", selected, { metalness: 0.5, roughness: 0.4 })} />
          </mesh>
          {/* front retaining ring */}
          <mesh position={[-(bx / 2) - 44, 0, 0]} rotation={xCyl}>
            <cylinderGeometry args={[26, 26, 3, 40]} />
            <meshStandardMaterial {...mat("#3a3d42", selected, { metalness: 0.85, roughness: 0.3 })} />
          </mesh>
          {/* front glass element */}
          <mesh position={[-(bx / 2) - 43, 0, 0]} rotation={xCyl}>
            <cylinderGeometry args={[22, 22, 1, 40]} />
            <meshStandardMaterial {...mat("#223044", selected, { metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.6 })} />
          </mesh>
        </group>
      );
    }
    case "laser":
      return (
        <group>
          <mesh castShadow>
            <boxGeometry args={[80, 40, 40]} />
            <meshStandardMaterial {...mat("#2a2a30", selected, { metalness: 0.5, roughness: 0.4 })} />
          </mesh>
          <mesh position={[43, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[3, 3, 6, 24]} />
            <meshStandardMaterial color="#19e23a" emissive="#19e23a" emissiveIntensity={0.8} />
          </mesh>
        </group>
      );
    case "detector":
      return (
        <mesh castShadow>
          <boxGeometry args={[num(c, "width_mm", 12), 2, num(c, "height_mm", 12)]} />
          <meshStandardMaterial {...mat("#26262b", selected, { metalness: 0.3, roughness: 0.5 })} />
        </mesh>
      );
    default:
      return (
        <mesh castShadow>
          <boxGeometry args={[20, 20, 20]} />
          <meshStandardMaterial {...mat("#9aa0a8", selected)} />
        </mesh>
      );
  }
}

export default function Component3D({
  c, selected, onSelect, onMove,
  setRef, ghost = false,
} : {
  c: Component;
  selected: boolean;
  onSelect: (name: string) => void;
  onMove: (name: string, x: number, y: number, z: number, rotZ: number) => void;
  setRef: (name: string, ref: THREE.Group | null) => void;
  ghost?: boolean;
}) {
  const ref = useRef<THREE.Group>(null!);
  const fr = footRadius(c);
  const renderUsdGeometry = Boolean(
    c.cadDerived && (c.meshes?.length || c.primitives?.length),
  );
  const modelRotation = c.modelRotation ?? [0, 0, 0];
  const rotationCenter = c.rotationCenter ?? [0, 0, 0];
  const inverseRotationCenter: [number, number, number] = [
    -rotationCenter[0],
    -rotationCenter[1],
    -rotationCenter[2],
  ];

  useLayoutEffect(() => {
    if (ghost && ref.current) makeGhost(ref.current);
  }, [ghost, c.type]);

  return (
    <group
      ref={(r) => { ref.current = r!; setRef(c.name, r); }}
      position={[c.x, c.y, c.z]}
      rotation={[0, 0, c.rotZ * DEG]}
      onClick={ghost ? undefined : (e) => { e.stopPropagation(); onSelect(c.name); }}
      onPointerOver={ghost ? undefined : (e) => { e.stopPropagation(); document.body.style.cursor = "pointer"; }}
      onPointerOut={ghost ? undefined : () => { document.body.style.cursor = "auto"; }}
    >
      <group
        position={rotationCenter}
        rotation={[
          modelRotation[0] * DEG,
          modelRotation[1] * DEG,
          modelRotation[2] * DEG,
        ]}
      >
        <group position={inverseRotationCenter}>
          {renderUsdGeometry ? (
            <UsdGeometry c={c} selected={selected} ghost={ghost} />
          ) : MODELS[c.type] ? (
            <Suspense fallback={<Part c={c} selected={selected} />}>
              <GltfModel def={MODELS[c.type]} ghost={ghost} />
            </Suspense>
          ) : (
            <>
              <Part c={c} selected={selected} />
              {DISC.has(c.type) && <MountRing r={discRadius(c)} selected={selected} />}
            </>
          )}
        </group>
      </group>

      {!ghost && (
        <Html position={[0, 0, 65]} center style={{ pointerEvents: "none" }}>
          <div className={`comp-label${selected ? " sel" : ""}`}>{c.name}</div>
        </Html>
      )}

      {selected && (
        <mesh position={[0, 0, 2]}>
          <ringGeometry args={[fr, fr + 5, 48]} />
          <meshBasicMaterial color="#4c8dff" transparent opacity={0.65} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}
