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
  rotZ: number;
  modelRotation?: [number, number, number];
  rotationCenter?: [number, number, number];
  attrs: Record<string, number | string>;
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
}

export interface BeamSegment {
  pts: [number, number, number][];
  wavelength: number;  // nm — drives color
  intensity?: number;  // relative optical power (0..1)
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

// A beamPath node: either a plain component name (auto-follows) or a dict
// that carries an optional pin coordinate (stays put when component moves).
export type BeamNode = string | { ref: string; pin?: [number, number, number] };

export interface ProjectData {
  name: string;
  components: Component[];
  beam: BeamSegment[];      // resolved segments (pts + wavelength)
  beamPath: BeamNode[][];   // authored node sequences (component names / pins)
  board: Board;
  library: string[];
  libraryPreviews?: Record<string, Component>;
  renderMode?: "hi" | "lo";
  pins?: PinAnnotation[]; // pin information, ?:Whether it's there or not
}

export interface BeamElementStat {
  name: string;
  type: string;
  w_in_mm: number;        // beam radius arriving at this element
  // lens-only fields (present when type is lens / cylindrical_lens / eyepiece)
  w_out_mm?: number;              // beam radius just after the lens
  focal_length_mm?: number;
  z_R_after_mm?: number;          // new Rayleigh range after this lens
  z_waist_mm?: number;            // distance to next focus (positive = downstream)
  w_waist_mm?: number;            // beam radius at that focus
  divergence_after_mrad?: number; // half-angle divergence after this lens
}

export interface ParaxialInfo {
  w0_mm: number;                  // fiber input waist radius
  z_R0_mm: number;                // Rayleigh range at fiber tip
  divergence_input_mrad: number;  // half-angle divergence at input
  w_final_mm: number;             // beam radius at last element (detector)
  elements: BeamElementStat[];
}

export interface ParaxialSegment {
  pts: [number, number, number][];
  widths: number[];    // beam radius in mm at each pt
  wavelength: number;  // nm
  info: ParaxialInfo;
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
