import type { ParaxialSegment, PinAnnotation, ProjectData, ProjectSummary, Template } from "./types";

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

  getProject: (p: string, renderMode: "hi" | "lo" = "lo"): Promise<ProjectData> =>
    fetch(`/api/projects/${p}?renderMode=${renderMode}`).then(j),

  updateComponent: (
    p: string,
    c: string,
    body: {
      x?: number;
      y?: number;
      z?: number;
      rotZ?: number;
      renderMode?: "hi" | "lo";
    }
  ): Promise<ProjectData & { ok: boolean }> =>
    post(`/api/projects/${p}/components/${c}`, body),

  addComponent: (p: string, asset: string, x: number, y: number) =>
    post(`/api/projects/${p}/add`, { asset, x, y }),

  deleteComponent: (p: string, c: string) =>
    post(`/api/projects/${p}/delete/${c}`),

  updatePins: (p: string, pins: PinAnnotation[]): Promise<{ ok: boolean; pins: PinAnnotation[] }> =>
    post(`/api/projects/${p}/pins`, { pins }),

  // Set or clear a pin override on a beam node. position=null clears the pin.
  pinBeamNode: (p: string, segment: number, node: number, position: [number, number, number] | null) =>
    post(`/api/projects/${p}/beam/pin`, { segment, node, position }),

  getParaxialBeam: (p: string, w0 = 0.0025): Promise<{ segments: ParaxialSegment[] }> =>
    fetch(`/api/projects/${p}/beam/paraxial?w0=${w0}`).then(j),

  // cache-busted model URL for the viewport
  modelUrl: (p: string, version: number) => `/model/${p}.glb?v=${version}`,
};
