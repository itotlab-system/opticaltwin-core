export interface ComponentMesh {
  points: [number, number, number][];
  indices: number[];
  color: [number, number, number];
  opacity: number;
  doubleSided: boolean;
  metalness?: number;
  roughness?: number;
}

export interface ComponentPrimitive {
  kind: "cube" | "cylinder" | "sphere";
  matrix: number[];
  color: [number, number, number];
  opacity: number;
  doubleSided: boolean;
  metalness?: number;
  roughness?: number;
  spherePortion?: "full" | "positiveX" | "negativeX";
  capSide?: "both" | "positiveX" | "negativeX";
  size?: number;
  radius?: number;
  height?: number;
  axis?: "X" | "Y" | "Z" | "x" | "y" | "z";
}

export interface Component {
  name: string;
  type: string;
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  modelRotation?: [number, number, number];
  rotationCenter?: [number, number, number];
  // optics:* attributes as authored. Booleans occur too (laserOn).
  attrs: Record<string, number | string | boolean>;
  asset?: string | null;
  cadDerived?: boolean;
  renderMode?: "hi" | "lo";
  meshes?: ComponentMesh[];
  primitives?: ComponentPrimitive[];
  physics?: {
    emissionOffset_mm?: number;
    activeCenterY_mm?: number;
    activeCenterZ_mm?: number;
    activeHalfY_mm?: number;
    activeHalfZ_mm?: number;
  };
}

export interface Board {
  holes: [number, number][];
  holeZ: number | null;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  sizeX: number;
  sizeY: number;
  minSizeX: number;
  minSizeY: number;
  spacing: number;
  centerX: number;
  centerY: number;
  extentXNegative: number;
  extentXPositive: number;
  extentYNegative: number;
  extentYPositive: number;
  model?: Component | null;
}

export interface BeamSegment {
  pts: [number, number, number][];
  wavelength: number;  // nm — drives color
  intensity?: number;  // relative optical power (0..1)
  // Identity of this leg, from the tracer. `key` is stable across component
  // moves, so a drawn width stays attached to the right stretch of beam.
  key?: string;
  from?: string | null;   // component the beam left ("*"/null = open end)
  to?: string | null;     // component it reached
  wIn?: number;           // drawn full width in mm entering the leg
  wOut?: number;          // drawn full width in mm leaving it
  // A pinched leg: where along it the beam is narrowest (0..1) and how wide it
  // is there. Present only for a leg drawn as a focus rather than a wedge.
  waistAt?: number;
  waistW?: number;
  // How far the beam is *drawn* along this leg. Absent = the real gap between
  // the two parts. Sketch only: it moves nothing.
  lengthMm?: number;
  shaped?: boolean;       // true once someone has drawn this leg
}

export interface PinAnnotation { // add PIN information
  id: string;
  label: string;
  x: number;
  y: number;
  z: number;
  authorName: string;
  color: string;
  size?: number;
  createdAt: string;
}

// A set of components moved and rotated as one rigid body (PowerPoint-style
// grouping). Stored in the USD layer as the optics:groups JSON attribute; a
// component belongs to at most one group and groups do not nest.
export interface ComponentGroup {
  id: string;
  name: string;
  members: string[];   // component names
  color?: string;      // outline color in the viewport / outliner
}

// A beamPath node: either a plain component name (auto-follows) or a dict
// that carries an optional pin coordinate (stays put when component moves).
export type BeamNode = string | { ref: string; pin?: [number, number, number] };

export interface ProjectData {
  name: string;
  components: Component[];
  beam: BeamSegment[];      // resolved segments (pts + wavelength)
  beamPath: BeamNode[][];   // authored node sequences (component names / pins)
  board: Board;
  boardModels?: string[];
  library: string[];
  libraryPreviews?: Record<string, Component>;
  renderMode?: "hi" | "lo";
  pins?: PinAnnotation[]; // pin information, ?:Whether it's there or not
  groups?: ComponentGroup[];
  canUndo?: boolean;        // whether the project's history has a step to rewind
  canRedo?: boolean;
}

// One component's new pose in a batch move.
export interface ComponentUpdate {
  name: string;
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}

export interface ProjectSummary {
  name: string;
  components: number;
  types: string[];
}

export interface Template {
  key: string;
  label: string;
}
