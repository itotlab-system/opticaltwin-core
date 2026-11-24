import type {
  Component,
  ComponentGroup,
  ComponentUpdate,
  FigureCallout,
  MovePayload,
  PinAnnotation,
  ProjectData,
  LaserOption,
  NewProjectStart,
  PhotoBuildPart,
  PhotoLabels,
  ProjectSummary,
  Template,
} from "./types";
import { editorHeaders } from "./editorName";

// In dev these go through the Vite proxy to the Python backend (:8000).
const j = (r: Response) => {
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};
const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: "POST",
    // Every edit goes through here, so every edit says who made it.
    headers: { "Content-Type": "application/json", ...editorHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  }).then(j);

export const api = {
  listProjects: (): Promise<{
    projects: ProjectSummary[]; templates: Template[];
    lasers?: LaserOption[]; defaultBeamHeight?: number;
  }> => fetch("/api/projects").then(j),

  // `start` only matters for the "from_laser" template: which laser, and the
  // beam height (mm above the board) the whole design is built at.
  createProject: (
    name: string, template: string, start: NewProjectStart = {},
  ): Promise<{ ok: boolean; name: string }> =>
    post("/api/projects", { name, template, ...start }),

  removeProject: (name: string) => post(`/api/projects/${name}/remove`),

  // The backend sanitises the typed name, so the one it returns is authoritative.
  renameProject: (name: string, newName: string): Promise<{ ok: boolean; name: string }> =>
    post(`/api/projects/${name}/rename`, { name: newName }),

  // Copy a whole project; the backend picks the <name>_copy name.
  duplicateProject: (name: string): Promise<{ ok: boolean; name: string }> =>
    post(`/api/projects/${name}/duplicate`),

  // File a project into a folder and/or archive it. Each field is applied only
  // if sent, so archiving never disturbs the folder. folder: "" un-files it.
  setProjectMeta: (
    name: string,
    meta: { folder?: string; archived?: boolean }
  ): Promise<{ ok: boolean; project: ProjectSummary }> =>
    post(`/api/projects/${name}/meta`, meta),

  // One catalogue part's geometry, fetched when the part browser draws its
  // tile or the placement ghost needs it. One part at a time: the project
  // payload carries only each part's metadata, never its mesh.
  libraryPreview: (asset: string): Promise<{ component: Component }> =>
    fetch(`/api/library/preview/${encodeURI(asset)}`).then(j),

  getProject: (p: string): Promise<ProjectData> =>
    fetch(`/api/projects/${p}`).then(j),

  updateBoardModel: (
    p: string,
    asset: string
  ): Promise<ProjectData & { ok: boolean }> =>
    post(`/api/projects/${p}/board/model`, { asset }),

  // Moves return a MovePayload, not the whole scene: transforms plus the
  // retraced beam, with no geometry. Fold it in with mergeMove.
  updateComponent: (
    p: string,
    c: string,
    body: {
      x?: number;
      y?: number;
      z?: number;
      rotX?: number;
      rotY?: number;
      rotZ?: number;
    }
  ): Promise<MovePayload> =>
    post(`/api/projects/${p}/components/${c}`, body),

  updateComponentModel: (
    p: string,
    c: string,
    asset: string
  ): Promise<ProjectData & { ok: boolean }> =>
    post(`/api/projects/${p}/components/${c}/model`, { asset }),

  // Move several components in one request — one USD save, one beam retrace.
  updateComponents: (
    p: string,
    updates: ComponentUpdate[]
  ): Promise<MovePayload> =>
    post(`/api/projects/${p}/components/batch`, { updates }),

  // Replaces the whole group list: create, rename and ungroup all go through it.
  updateGroups: (p: string, groups: ComponentGroup[]): Promise<{ ok: boolean; groups: ComponentGroup[] }> =>
    post(`/api/projects/${p}/groups`, { groups }),

  // `snap` lets an in-beam part dropped near the beam land IN it (centred, at
  // beam height, facing along it); false puts it exactly where it was dropped.
  // Answers with a move payload plus the new part(s), merged with mergeMove.
  addComponent: (
    p: string, asset: string, x: number, y: number, snap = true
  ): Promise<MovePayload & { name: string; snapped: string | null }> =>
    post(`/api/projects/${p}/add`, { asset, x, y, snap }),

  // Turn a mirror or beamsplitter so the beam leaves it to that side.
  foldBeam: (p: string, c: string, turn: "left" | "right"): Promise<MovePayload> =>
    post(`/api/projects/${p}/components/${c}/fold`, { turn }),

  // --- building a bench from a photo (see PhotoBuilder) -------------------
  uploadPhoto: (p: string, jpeg: Blob): Promise<{ ok: boolean; file: string }> =>
    fetch(`/api/projects/${p}/photo`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg", ...editorHeaders() },
      body: jpeg,
    }).then(j),

  photoUrl: (p: string, file: string) => `/api/projects/${p}/photo/${file}`,

  uploadThumbnail: (p: string, png: Blob): Promise<{ ok: boolean }> =>
    fetch(`/api/projects/${p}/thumbnail`, {
      method: "POST",
      headers: { "Content-Type": "image/png", ...editorHeaders() },
      body: png,
    }).then(j),

  thumbnailUrl: (p: string, v: string) =>
    `/api/projects/${encodeURIComponent(p)}/thumbnail.png?v=${encodeURIComponent(v)}`,

  getPhotoLabels: (p: string): Promise<PhotoLabels> =>
    fetch(`/api/projects/${p}/photo-labels`).then(j),

  savePhotoLabels: (p: string, labels: PhotoLabels) =>
    post(`/api/projects/${p}/photo-labels`, labels),

  buildFromPhoto: (
    p: string, beamHeight: number, parts: PhotoBuildPart[],
  ): Promise<ProjectData & { built: Record<string, string> }> =>
    post(`/api/projects/${p}/photo/build`, { beamHeight, parts }),

  deleteComponent: (p: string, c: string) =>
    post(`/api/projects/${p}/delete/${c}`),

  // Paste: copy components into project `p`, offset from their originals.
  // `sourceProject` takes them out of a different project — a paste of parts
  // copied elsewhere. Only `p` is modified.
  duplicateComponents: (
    p: string,
    names: string[],
    offsetX: number,
    offsetY: number,
    sourceProject?: string
  ): Promise<ProjectData & { ok: boolean; names: string[] }> =>
    post(`/api/projects/${p}/components/duplicate`,
         { names, offsetX, offsetY, sourceProject }),

  updatePins: (p: string, pins: PinAnnotation[]): Promise<{ ok: boolean; pins: PinAnnotation[] }> =>
    post(`/api/projects/${p}/pins`, { pins }),

  // Replace the project's figure callouts. Whole-list, like pins and groups:
  // one drag or one delete is one undo step either way.
  updateCallouts: (
    p: string,
    callouts: FigureCallout[]
  ): Promise<{ ok: boolean; callouts: FigureCallout[]; canUndo?: boolean; canRedo?: boolean }> =>
    post(`/api/projects/${p}/callouts`, { callouts }),

  // Switch lasers on or off. A laser that is off emits nothing, so the bench
  // goes dark. Omit `names` to switch every laser in the project.
  switchLasers: (
    p: string,
    on: boolean,
    names?: string[]
  ): Promise<MovePayload & { switched: string[] }> =>
    post(`/api/projects/${p}/lasers`, { on, names }),

  // Draw one leg of the beam: its width at each end, optionally pinched to a
  // waist. Affects only that leg — it is a sketch, not a simulation.
  shapeBeamSegment: (
    p: string,
    body: {
      key: string;
      wIn?: number;
      wOut?: number;
      waistAt?: number;
      waistW?: number;
      lengthMm?: number;
      clear?: boolean;
    }
  ): Promise<MovePayload> =>
    post(`/api/projects/${p}/beam/shape`, body),

  // Set or clear a pin override on a beam node. position=null clears the pin.
  pinBeamNode: (p: string, segment: number, node: number, position: [number, number, number] | null) =>
    post(`/api/projects/${p}/beam/pin`, { segment, node, position }),

  // Rewind / replay one editing step. `stepped` is false when the stack is
  // empty; the payload is still the current scene either way.
  undo: (p: string): Promise<ProjectData & { stepped: boolean }> =>
    post(`/api/projects/${p}/undo`),

  redo: (p: string): Promise<ProjectData & { stepped: boolean }> =>
    post(`/api/projects/${p}/redo`),


  // cache-busted model URL for the viewport
  modelUrl: (p: string, version: number) => `/model/${p}.glb?v=${version}`,
};
