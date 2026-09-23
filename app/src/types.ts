// Component types that start a beam — the mirror of EMITTER_TYPES in
// beam_tracer.py. Keep the two in step: a source missing here still emits in
// the 3D scene but the toolbar switch would not reach it.
export const EMITTER_TYPES = new Set(["laser", "led"]);

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
  // Catalogue entries only (libraryPreviews): how far above the board top this
  // part must sit so it rests ON the board rather than half inside it. See
  // _asset_base_offset_mm in server.py.
  baseOffsetZ?: number;
  // optics:* attributes as authored. Booleans occur too (laserOn).
  attrs: Record<string, number | string | boolean>;
  asset?: string | null;
  cadDerived?: boolean;
  // Catalogue previews only: URL of the real photograph a lab member dropped
  // into the part's components/ folder. Absent = show the rendered CAD instead.
  photo?: string;
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

// A figure callout: a label box joined to a component by a leader line, for
// snapshots that go into a paper. Stored in the USD layer as optics:callouts.
// `dx`/`dy` are screen pixels from the part's projected position, because where
// a label sits is a fact about the picture, not about the bench; the text is
// free-form so a paper can say "Phase modulator" where the catalogue says SLM.
// Where the line *lands* is the opposite kind of quantity from dx/dy: ax/ay/az
// are millimetres in the part's own frame, so a dot dragged onto a lens surface
// stays on that surface through moves, rotations and orbits. Absent = origin.
// `lineColor` / `boxColor` are the figure's own styling — a black leader line
// disappears against a dark bench and a white box against a light one, and a
// paper often colours the labels of one arm apart from the other. Absent means
// the default paper look (CALLOUT_STYLE); the text colour is never stored, it
// follows from the box fill so a label can't be made unreadable.
// `hidden` keeps a label in the project while leaving it out of the picture.
export interface FigureCallout {
  id: string;
  target: string;    // component name the leader line points at
  text: string;
  dx: number;
  dy: number;
  ax?: number;
  ay?: number;
  az?: number;
  fontPx?: number;
  lineColor?: string;   // "#rrggbb"
  boxColor?: string;    // "#rrggbb" or "none" (transparent box)
  hidden?: boolean;
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
  callouts?: FigureCallout[];
  groups?: ComponentGroup[];
  canUndo?: boolean;        // whether the project's history has a step to rewind
  canRedo?: boolean;
}

// What a move returns: transforms and the retraced beam, no geometry. Merged
// into the existing ProjectData by mergeMove — see moveMerge.ts.
export interface MoveComponent {
  name: string;
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  attrs: Record<string, number | string | boolean>;
}

export interface MovePayload {
  ok: boolean;
  name: string;
  partial: true;
  components: MoveComponent[];
  beam: BeamSegment[];
  renderMode: "hi" | "lo";
  canUndo?: boolean;
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
  // Layer mtime (epoch seconds). The gallery keys its cached bench thumbnail on
  // this, so an edit elsewhere redraws the card instead of showing a stale one,
  // and shows it as the card's "last edited".
  modified?: number;
  // Breadboard footprint in mm — which bench this is.
  boardSizeX?: number;
  boardSizeY?: number;
  // How the project is filed in the gallery. "" (or absent) = unfiled, which
  // is where every project starts. Both come from projects/<n>/project.json,
  // never from the layer — see PROJECT_META_FILE in server.py.
  folder?: string;
  archived?: boolean;
}

export interface Template {
  key: string;
  label: string;
}
