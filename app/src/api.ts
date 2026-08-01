import type {
  ComponentGroup,
  ComponentUpdate,
  PinAnnotation,
  ProjectData,
  ProjectSummary,
  Template,
} from "./types";

// In dev these go through the Vite proxy to the Python backend (:8000).
const j = (r: Response) => {
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};
const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(j);

export const api = {
  listProjects: (): Promise<{ projects: ProjectSummary[]; templates: Template[] }> =>
    fetch("/api/projects").then(j),

  createProject: (name: string, template: string): Promise<{ ok: boolean; name: string }> =>
    post("/api/projects", { name, template }),

  removeProject: (name: string) => post(`/api/projects/${name}/remove`),

  // Copy a whole project; the backend picks the <name>_copy name.
  duplicateProject: (name: string): Promise<{ ok: boolean; name: string }> =>
    post(`/api/projects/${name}/duplicate`),

  getProject: (p: string, renderMode: "hi" | "lo" = "lo"): Promise<ProjectData> =>
    fetch(`/api/projects/${p}?renderMode=${renderMode}`).then(j),

  updateBoardModel: (
    p: string,
    asset: string,
    renderMode: "hi" | "lo" = "lo"
  ): Promise<ProjectData & { ok: boolean }> =>
    post(`/api/projects/${p}/board/model`, { asset, renderMode }),

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
      renderMode?: "hi" | "lo";
    }
  ): Promise<ProjectData & { ok: boolean }> =>
    post(`/api/projects/${p}/components/${c}`, body),

  updateComponentModel: (
    p: string,
    c: string,
    asset: string,
    renderMode: "hi" | "lo" = "lo"
  ): Promise<ProjectData & { ok: boolean }> =>
    post(`/api/projects/${p}/components/${c}/model`, { asset, renderMode }),

  // Move several components in one request — one USD save, one glb rebuild.
  updateComponents: (
    p: string,
    updates: ComponentUpdate[],
    renderMode: "hi" | "lo" = "lo"
  ): Promise<ProjectData & { ok: boolean }> =>
    post(`/api/projects/${p}/components/batch`, { updates, renderMode }),

  // Replaces the whole group list: create, rename and ungroup all go through it.
  updateGroups: (p: string, groups: ComponentGroup[]): Promise<{ ok: boolean; groups: ComponentGroup[] }> =>
    post(`/api/projects/${p}/groups`, { groups }),

  addComponent: (p: string, asset: string, x: number, y: number) =>
    post(`/api/projects/${p}/add`, { asset, x, y }),

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
    renderMode: "hi" | "lo" = "lo",
    sourceProject?: string
  ): Promise<ProjectData & { ok: boolean; names: string[] }> =>
    post(`/api/projects/${p}/components/duplicate`,
         { names, offsetX, offsetY, renderMode, sourceProject }),

  updatePins: (p: string, pins: PinAnnotation[]): Promise<{ ok: boolean; pins: PinAnnotation[] }> =>
    post(`/api/projects/${p}/pins`, { pins }),

  // Switch lasers on or off. A laser that is off emits nothing, so the bench
  // goes dark. Omit `names` to switch every laser in the project.
  switchLasers: (
    p: string,
    on: boolean,
    names?: string[],
    renderMode: "hi" | "lo" = "lo"
  ): Promise<ProjectData & { ok: boolean; switched: string[] }> =>
    post(`/api/projects/${p}/lasers`, { on, names, renderMode }),

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
    },
    renderMode: "hi" | "lo" = "lo"
  ): Promise<ProjectData & { ok: boolean }> =>
    post(`/api/projects/${p}/beam/shape`, { ...body, renderMode }),

  // Set or clear a pin override on a beam node. position=null clears the pin.
  pinBeamNode: (p: string, segment: number, node: number, position: [number, number, number] | null) =>
    post(`/api/projects/${p}/beam/pin`, { segment, node, position }),

  // Rewind / replay one editing step. `stepped` is false when the stack is
  // empty; the payload is still the current scene either way.
  undo: (p: string, renderMode: "hi" | "lo" = "lo"): Promise<ProjectData & { stepped: boolean }> =>
    post(`/api/projects/${p}/undo`, { renderMode }),

  redo: (p: string, renderMode: "hi" | "lo" = "lo"): Promise<ProjectData & { stepped: boolean }> =>
    post(`/api/projects/${p}/redo`, { renderMode }),


  // cache-busted model URL for the viewport
  modelUrl: (p: string, version: number) => `/model/${p}.glb?v=${version}`,
};
