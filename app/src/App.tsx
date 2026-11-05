import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import Viewport, {
  type TransformMode,
  type ViewportHandle,
} from "./scene/Viewport";
import Outliner from "./ui/Outliner";
import PartBrowser from "./ui/PartBrowser";
import Inspector from "./ui/Inspector";
import SegmentPopover from "./ui/SegmentPopover";
import type { SegmentShape } from "./beamShape";
import ProjectGallery from "./ui/ProjectGallery";
import Toggles from "./ui/Toggles";
import CalloutLayer from "./ui/CalloutLayer";
import PhotoBuilder from "./ui/PhotoBuilder";
import FigureExportDialog, {
  DEFAULT_FIGURE_SETTINGS,
  type FigureExportSettings,
} from "./ui/FigureExportDialog";
import { AnchorStore } from "./scene/anchors";
import { composeFigure } from "./figureExport";
import { createCalloutId, defaultCalloutText, visibleCallouts } from "./callouts";
import { useSettings, moveViewportBg } from "./settings";
import { api } from "./api";
import { buildSnapshotFilename, downloadBlob } from "./snapshot";
import { modelOptionsFor } from "./modelPicker";

// Before:
// import type { BeamNode, BeamSegment, Component, ParaxialSegment, ProjectData, ProjectSummary, Template } from "./types";

// Added:
// PinAnnotation is used for frontend-only 3D pin annotations.
import type {
  BeamNode,
  BeamSegment,
  Component,
  ComponentGroup,
  ComponentUpdate,
  FigureCallout,
  MovePayload,
  PinAnnotation,
  ProjectData,
  ProjectSummary,
  LaserOption,
  NewProjectStart,
  Template,
} from "./types";
import { EMITTER_TYPES } from "./types";
import { mergeMove, needsFullReload } from "./moveMerge";
import {
  groupOf,
  groupsCovering,
  resolveClick,
  roundUpdate,
  withNewGroup,
  withoutGroups,
} from "./groups";

// Added:
// Preset colors for 3D pin annotations.
// The selected color is used when creating a new pin.
const PIN_COLOR_OPTIONS = [
  { label: "Blue", value: "#4c8dff" },
  { label: "Red", value: "#e5534b" },
  { label: "Green", value: "#2ea043" },
] as const;

type PinEditorState = {
  mode: "create" | "edit";
  pin: PinAnnotation;
  value: string;
};

function createPinId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// What Ctrl+C holds: component names *and* the project they were copied from,
// since a paste can land in a different project. Kept in localStorage
// so it also survives a reload or a second tab — the same place the browser's
// own clipboard would put it.
type Clipboard = { project: string; names: string[] };

const CLIPBOARD_KEY = "ot.clipboard";

function readClipboard(): Clipboard | null {
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    const c = raw ? JSON.parse(raw) : null;
    if (!c || typeof c.project !== "string" || !Array.isArray(c.names)) return null;
    const names = c.names.filter((n: unknown) => typeof n === "string");
    return names.length ? { project: c.project, names } : null;
  } catch {
    return null;                       // unreadable or from an older version
  }
}

function writeClipboard(c: Clipboard) {
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(c));
  } catch {
    /* private mode / quota — the in-memory clipboard still works */
  }
}

// Camera glyph for the snapshot button. Inline so it inherits the button's
// colour (currentColor) and needs no asset request.
function CameraIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 8.5h3.2l1.5-2.2h8.6l1.5 2.2H21a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.5" r="3.4" />
    </svg>
  );
}

/** Show/hide for the figure-label layer; struck through when it is hidden. */
function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.8-6 10-6 10 6 10 6-3.8 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 20 20 4" />}
    </svg>
  );
}

export default function App() {
  const { t, setBgProject, editorName } = useSettings();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [laserAssets, setLaserAssets] = useState<LaserOption[]>([]);
  const [defaultBeamHeight, setDefaultBeamHeight] = useState(100);
  const [current, setCurrent] = useState<string | null>(null);   // null = gallery
  const [data, setData] = useState<ProjectData | null>(null);
  // Mirrors `data` for the debounced saves, which run outside render and would
  // otherwise merge a move into a scene captured before the optimistic edit.
  const dataRef = useRef<ProjectData | null>(null);
  dataRef.current = data;
  // Components are selected as a set so a whole group can be moved at once;
  // a single-part selection is just a set of one.
  const [selection, setSelection] = useState<string[]>([]);
  // Group the user has drilled into (double-click), where clicks select single
  // members instead of the whole group. PowerPoint's "enter group" state.
  const [enteredGroupId, setEnteredGroupId] = useState<string | null>(null);
  // Ctrl+C clipboard: the copied component names plus the project they came
  // from. The copies are made server-side from that project's prims, so it
  // outlives switching projects — that's what makes cross-project paste work.
  const [clipboard, setClipboard] = useState<Clipboard | null>(readClipboard);
  // How many pastes have landed since the copy, so repeated Ctrl+V fans the
  // copies out along the grid instead of piling them on one spot.
  const pasteStep = useRef(0);
  const [asset, setAsset] = useState("");
  const [isPlacing, setIsPlacing] = useState(false);
  const [browsingParts, setBrowsingParts] = useState(false);
  const [status, setStatus] = useState("");
  const [renderMode, setRenderMode] = useState<"lo" | "hi">("lo");
  const [lodLoading, setLodLoading] = useState(false);
  // The "build from a photo" screen, over the editor.
  const [photoOpen, setPhotoOpen] = useState(false);
  useEffect(() => { if (!current) setPhotoOpen(false); }, [current]);
  // Which beam leg is being edited, straight in the 3D viewport.
  const [selectedSegment, setSelectedSegment] = useState<BeamSegment | null>(null);
  const [showOutliner, setShowOutliner] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const [transformMode, setTransformMode] = useState<TransformMode>("translate");
  // True once the R3F canvas has finished its first render, so the
  // Snapshot button can't be clicked before there's anything to capture.
  const [viewportReady, setViewportReady] = useState(false);
  const saveTimer = useRef<number | null>(null);
  // What a debounced save is about to do. Undo flushes it first — a save
  // landing after an undo would re-apply the move *and* push a fresh history
  // step on top of it, so Ctrl+Z would look like it did nothing.
  const pendingSave = useRef<(() => Promise<void>) | null>(null);
  // Serialises undo/redo requests so a held Ctrl+Z can't overlap them.
  const historyChain = useRef<Promise<void>>(Promise.resolve());
  const viewportRef = useRef<ViewportHandle>(null);

  // Added:
  // Local 3D pin annotations.
  // This is frontend-only for now.
  // Later, these pins should be loaded from and saved to the backend API.
  const [pins, setPins] = useState<PinAnnotation[]>([]);

  // Added:
  // When true, clicking the breadboard creates a new pin.
  const [pinMode, setPinMode] = useState(false);

  // Added:
  // Currently selected pin id.
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);

  // Added:
  // The user manually types the name shown on newly created pins. It starts
  // as the name edits are recorded under, and follows it when that changes.
  const [pinUserName, setPinUserName] = useState(editorName);
  useEffect(() => setPinUserName(editorName), [editorName]);

  // Added:
  // Selected color for newly created pins.
  const [pinColor, setPinColor] = useState<string>(PIN_COLOR_OPTIONS[0].value);
  const [pinEditor, setPinEditor] = useState<PinEditorState | null>(null);

  // ----- figure callouts (the paper-figure labels) -----
  // They live in `data`, not in a state of their own, so that every full
  // payload — a delete, an undo, a reload — brings the authoritative list with
  // it. Held separately they went stale the moment a labelled part was
  // deleted, and the next drag then saved a label pointing at nothing.
  // When on, clicking a part labels it instead of selecting it.
  const [calloutMode, setCalloutMode] = useState(false);
  const [selectedCalloutId, setSelectedCalloutId] = useState<string | null>(null);
  // The whole layer on/off, on top of each label's own `hidden` flag. A bench
  // being *arranged* wants the parts unobstructed; the labels are for the
  // figure. What is on screen is what gets exported, so this switches both.
  const [calloutsVisible, setCalloutsVisible] = useState(true);
  const [figureExport, setFigureExport] = useState<FigureExportSettings | null>(null);
  const [exporting, setExporting] = useState(false);
  // Where every labelled part currently is on screen. One store for the app's
  // lifetime: the projector writes into it every frame and the SVG layer reads
  // it back, so it must not be replaced on re-render.
  const anchorStore = useRef(new AnchorStore()).current;

  async function refreshGallery() {
    const r = await api.listProjects();
    setProjects(r.projects);
    setTemplates(r.templates);
    setLaserAssets(r.lasers ?? []);
    if (r.defaultBeamHeight) setDefaultBeamHeight(r.defaultBeamHeight);
  }

  // A leg that no longer exists (parts moved, a part was deleted) must not
  // keep an editor open over empty space.
  useEffect(() => {
    if (!selectedSegment) return;
    const still = data?.beam.some((s) => s.key === selectedSegment.key);
    if (!still) setSelectedSegment(null);
  }, [data, selectedSegment]);

  // The viewport background is per project, so hand the open one to settings.
  useEffect(() => { setBgProject(current); }, [current]);

  // Load a project's full scene when one is opened.
  useEffect(() => {
    // The clipboard itself survives the switch (paste into another project),
    // but the fan-out restarts: the first paste into a new project has no
    // original next to it to step away from.
    pasteStep.current = 0;

    if (!current) {
      // Before:
      // setData(null); setSelected(null);
      setData(null);
      setSelection([]);
      setEnteredGroupId(null);
      setSelectedSegment(null);
      setViewportReady(false);

      // Added:
      // Clear pin-related state when returning to the project gallery.
      setPins([]);
      setPinMode(false);
      setSelectedPinId(null);
      setCalloutMode(false);
      setSelectedCalloutId(null);
      setRenderMode("lo");

      // Every time the gallery is shown, not only on first load: coming back
      // from a bench, its card must show the edit just made (time, who, and
      // the redrawn thumbnail keyed on that time), not the list from before.
      refreshGallery();
      return;
    }

    (async () => {
      setRenderMode("lo");
      setStatus(t("loading"));
      setViewportReady(false);
      const d = await api.getProject(current, "lo");
      setData(d);
      setAsset(d.library[0] ?? "");
      setStatus(t("components_n", { n: d.components.length }));

      // Added:
      // Load pins from project data if the backend provides them.
      // If not, start with an empty pin list.
      setPins(d.pins ?? []);
      setPinMode(false);
      setSelectedPinId(null);
      setCalloutMode(false);
      setSelectedCalloutId(null);
    })();
  }, [current]);

  // ----- gallery actions -----
  async function openProject(name: string) {
    setSelection([]);
    setEnteredGroupId(null);
    setCurrent(name);
  }

  // `folder` is the gallery tab that was open — a project made while standing
  // in a folder is filed there. Filed before the gallery refreshes, so the card
  // never flashes up unfiled.
  async function createProject(
    name: string, template: string, folder = "", start: NewProjectStart = {},
  ) {
    const r = await api.createProject(name, template, start);
    if (folder) await api.setProjectMeta(r.name, { folder });
    await refreshGallery();
    openProject(r.name);
    if (template === "from_photo") setPhotoOpen(true);
  }

  async function deleteProject(name: string) {
    if (!confirm(t("delete_confirm", { name }))) return;
    await api.removeProject(name);
    moveViewportBg(name, null);
    await refreshGallery();
  }

  // Copies the whole setup under <name>_copy — a safe place to try changes.
  async function duplicateProject(name: string) {
    const r = await api.duplicateProject(name);
    // The copy inherits the original's background, like its folder.
    moveViewportBg(name, r.name, true);
    await refreshGallery();
  }

  // Move a project into a folder, or archive it. Filing only — it never
  // touches setup.usda, so a card's "last edited" and its thumbnail stand.
  async function fileProject(
    name: string,
    meta: { folder?: string; archived?: boolean }
  ) {
    await api.setProjectMeta(name, meta);
    await refreshGallery();
  }

  async function renameProject(name: string, newName: string) {
    const r = await api.renameProject(name, newName);
    moveViewportBg(name, r.name);
    await refreshGallery();
    // A pending copy still points at the old folder; follow it across.
    const clip = readClipboard();
    if (clip?.project === name) writeClipboard({ ...clip, project: r.name });
    if (current === name) setCurrent(r.name);
  }

  async function toggleRenderMode() {
    if (!current || lodLoading) return;
    const next = renderMode === "lo" ? "hi" : "lo";
    setIsPlacing(false);
    setLodLoading(true);
    setStatus(`Loading ${next.toUpperCase()} models…`);
    try {
      const d = await api.getProject(current, next);
      setRenderMode(next);
      setData(d);
      // Hi/lo swaps can drop parts that have no model at that detail level.
      const present = new Set(d.components.map((c) => c.name));
      setSelection((prev) => prev.filter((name) => present.has(name)));
      setStatus(`${next.toUpperCase()} · ${d.components.length} components`);
    } catch {
      setStatus(`Could not load ${next.toUpperCase()} models`);
    } finally {
      setLodLoading(false);
    }
  }

  async function handleSnapshot(settings: FigureExportSettings) {
    if (!current) return;
    setExporting(true);
    try {
      // Hide the selection gizmo/guides for a clean shot, then restore it.
      const prevSelection = selection;
      const prevSelectedPinId = selectedPinId;
      const prevCalloutId = selectedCalloutId;
      setSelection([]);
      setSelectedPinId(null);
      setSelectedCalloutId(null);
      const frame = await viewportRef.current?.captureSnapshot({
        scale: settings.scale,
        background: settings.background,
        hidePins: settings.hidePins,
      });
      setSelection(prevSelection);
      setSelectedPinId(prevSelectedPinId);
      setSelectedCalloutId(prevCalloutId);

      if (!frame) return;
      // The projected anchors are read *after* the capture, from the same store
      // the on-screen layer is drawing from, so the leader lines in the file
      // land exactly where they do on screen.
      // The figure gets exactly the labels that are on screen: the layer switch
      // and each label's own hide button are the user's answer to "what belongs
      // in this picture", so the file must not quietly put them back.
      const file = await composeFigure(
        frame,
        calloutsVisible ? visibleCallouts(callouts) : [],
        anchorStore.points,
        settings.format,
        current ?? undefined,
      );
      downloadBlob(file, buildSnapshotFilename(current, new Date(), settings.format));
      setFigureExport(null);
      setStatus(t("snapshot_saved"));
    } finally {
      setExporting(false);
    }
  }

  // ----- figure callouts -----
  async function saveCallouts(next: FigureCallout[]) {
    setData((d) => (d ? { ...d, callouts: next } : d));   // optimistic
    if (!current) return;
    const r = await api.updateCallouts(current, next);
    setData((d) => (
      d ? { ...d, callouts: r.callouts, canUndo: r.canUndo, canRedo: r.canRedo } : d
    ));
  }

  function addCalloutFor(name: string) {
    // One label per part: a second click on an already-labelled part selects
    // the label it has instead of stacking an identical box on top of it.
    const existing = callouts.find((c) => c.target === name);
    if (existing) {
      setSelectedCalloutId(existing.id);
      return;
    }
    const callout: FigureCallout = {
      id: createCalloutId(),
      target: name,
      text: defaultCalloutText(components.find((c) => c.name === name)),
      // Up and to the right of the part, clear of the bench, where a figure
      // usually wants it; the user drags it wherever the picture needs.
      dx: 90,
      // Stepped down for each label already up, so labelling four parts in a
      // row doesn't bury three boxes under the fourth; they are dragged into
      // place afterwards anyway.
      dy: -70 - 30 * (callouts.length % 4),
    };
    void saveCallouts([...callouts, callout]);
    setSelectedCalloutId(callout.id);
  }

  function updateCallout(next: FigureCallout) {
    void saveCallouts(callouts.map((c) => (c.id === next.id ? next : c)));
  }

  function deleteCallout(id: string) {
    setSelectedCalloutId((prev) => (prev === id ? null : prev));
    void saveCallouts(callouts.filter((c) => c.id !== id));
  }

  // ----- editor state -----
  const components = data?.components ?? [];
  const sorted = [...components].sort((a, b) => a.x - b.x);

  const beam: BeamSegment[] = data?.beam ?? [];
  const groups: ComponentGroup[] = data?.groups ?? [];
  const callouts: FigureCallout[] = data?.callouts ?? [];
  const selected = selection.length === 1 ? selection[0] : null;
  // Sources and whether any is emitting. `laserOn` is absent on lasers placed
  // before the switch existed, which means on. The switch covers every emitter
  // type (see EMITTER_TYPES in beam_tracer.py), not only lasers.
  const lasers = components.filter((c) => EMITTER_TYPES.has(c.type));
  const lasersOn = lasers.some((c) => c.attrs.laserOn !== false);

  async function toggleLasers() {
    if (!current) return;
    const next = !lasersOn;
    setStatus(next ? t("laser_on") : t("laser_off"));
    const updated = await api.switchLasers(current, next, undefined, renderMode);
    setData(updated);
    // With the source off there is no leg left to edit.
    if (!next) setSelectedSegment(null);
  }

  const selectedComp = components.find((c) => c.name === selected) ?? null;

  // The group the current selection *is* — i.e. the selection covers exactly
  // one group and nothing else. An ad-hoc multi-selection has no group yet.
  const selectedGroup = (() => {
    if (selection.length < 2) return null;
    const covering = groupsCovering(groups, selection);
    if (covering.length !== 1) return null;
    const g = covering[0];
    return g.members.length === selection.length
      && g.members.every((m) => selection.includes(m)) ? g : null;
  })();

  const prevComp = (() => {
    if (!selectedComp) return null;

    const i = sorted.findIndex((c) => c.name === selectedComp.name);
    return i > 0 ? sorted[i - 1] : null;
  })();

  // Debounce bursts such as arrow-key nudges into one request and undo step.
  // Pointer drags pass a zero delay when their transform ends.
  function scheduleSave(run: () => Promise<void>, delayMs = 300) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    pendingSave.current = run;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      pendingSave.current = null;
      void run();
    }, delayMs);
  }

  async function flushPendingSave() {
    const run = pendingSave.current;
    if (!run) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    pendingSave.current = null;
    await run();
  }

  // Fold a move response into the scene instead of replacing it. The response
  // carries transforms and the beam only, so every mesh keeps its identity and
  // nothing is re-uploaded to the GPU. Returns the merged scene, or null if the
  // component set has drifted and a full reload was needed instead.
  async function applyMove(patch: MovePayload): Promise<ProjectData | null> {
    const prev = dataRef.current;
    if (!prev) return null;

    if (needsFullReload(prev, patch)) {
      if (!current) return null;
      const fresh = await api.getProject(current, renderMode);
      dataRef.current = fresh;
      setData(fresh);
      return fresh;
    }

    const next = mergeMove(prev, patch);
    dataRef.current = next;
    setData(next);
    return next;
  }

  function pushUpdate(comp: Component, immediate = false) {
    scheduleSave(async () => {
      setStatus(t("saving", { name: comp.name }));

      const updated = await api.updateComponent(current!, comp.name, {
        x: comp.x,
        y: comp.y,
        z: comp.z,
        rotX: comp.rotX,
        rotY: comp.rotY,
        rotZ: comp.rotZ,
        renderMode,
      });

      await applyMove(updated);
      setStatus(t("saved", { name: comp.name }));

    }, immediate ? 0 : 300);
  }

  function patchLocal(name: string, fields: Partial<Component>): Component | null {
    if (!data) return null;

    let updated: Component | null = null;

    const comps = components.map((c) => {
      if (c.name !== name) return c;

      updated = { ...c, ...fields };
      return updated;
    });

    setData({ ...data, components: comps });
    return updated;
  }

  function onEdit(field: "x" | "y" | "z" | "rotX" | "rotY" | "rotZ", value: number) {
    if (!selectedComp || Number.isNaN(value)) return;

    const u = patchLocal(selectedComp.name, { [field]: value });
    if (u) pushUpdate(u);
  }

  async function onChangeModel(asset: string) {
    if (!current || !selectedComp || asset === selectedComp.asset) return;
    setStatus(t("model_saving", { name: selectedComp.name }));
    try {
      const updated = await api.updateComponentModel(
        current, selectedComp.name, asset, renderMode
      );
      setData(updated);
      setStatus(t("model_saved", { name: selectedComp.name }));
    } catch {
      setStatus(t("model_failed"));
    }
  }

  async function onChangeBoardModel(asset: string) {
    if (!current || !data?.board.model
        || asset === data.board.model.asset) return;
    const name = asset.split("/").pop()?.replace(/-Step\.usda$/, "") ?? asset;
    setStatus(t("board_model_saving", { name }));
    try {
      const updated = await api.updateBoardModel(current, asset, renderMode);
      setData(updated);
      setStatus(t("board_model_saved", { name }));
    } catch {
      setStatus(t("board_model_failed"));
    }
  }

  function onMove(
    name: string,
    x: number,
    y: number,
    z: number,
    rotX: number,
    rotY: number,
    rotZ: number,
    immediate = false,
  ) {
    const u = patchLocal(name, {
      x: Math.round(x * 2) / 2,
      y: Math.round(y * 2) / 2,
      z: Math.round(z * 10) / 10,   // heights are fine-grained; keep 0.1 mm
      rotX: Math.round(rotX),
      rotY: Math.round(rotY),
      rotZ: Math.round(rotZ),
    });
    if (u) pushUpdate(u, immediate);
  }

  // ----- multi-selection & groups -----

  function patchLocalMany(updates: ComponentUpdate[]) {
    if (!data) return;
    const byName = new Map(updates.map((u) => [u.name, u]));
    setData({
      ...data,
      components: components.map((c) => {
        const u = byName.get(c.name);
        return u ? {
          ...c,
          x: u.x,
          y: u.y,
          z: u.z,
          rotX: u.rotX,
          rotY: u.rotY,
          rotZ: u.rotZ,
        } : c;
      }),
    });
  }

  // Moving a group is one request for all its parts: one USD save, one glb
  // rebuild, and no chance of the members drifting apart mid-flight.
  // Draw one leg of the beam. Local by design: no other leg and no component
  // changes, because this is a planning sketch, not a propagation.
  function onShapeSegment(shape: SegmentShape) {
    if (!current || !selectedSegment?.key) return;
    const key = selectedSegment.key;
    // Echo into the picked segment so the diagram redraws while the save flies.
    setSelectedSegment((seg) => (seg ? { ...seg, ...shape } : seg));
    setData((d) => d && {
      ...d,
      beam: d.beam.map((s) => (s.key === key ? { ...s, ...shape, shaped: true } : s)),
    });

    scheduleSave(async () => {
      setStatus(t("saving", { name: key }));
      const updated = await api.shapeBeamSegment(current, {
        key,
        wIn: shape.wIn,
        wOut: shape.wOut,
        waistAt: shape.waistAt,
        waistW: shape.waistW,
        lengthMm: shape.lengthMm,
      }, renderMode);
      const merged = await applyMove(updated);
      setSelectedSegment(
        (merged ?? updated).beam.find((s) => s.key === key) ?? null
      );
      setStatus(t("saved", { name: key }));
    });
  }

  function onMoveMany(updates: ComponentUpdate[], immediate = false) {
    if (!current || updates.length === 0) return;
    const rounded = updates.map(roundUpdate);
    patchLocalMany(rounded);

    scheduleSave(async () => {
      setStatus(t("saving_n", { n: rounded.length }));
      const updated = await api.updateComponents(current, rounded, renderMode);
      await applyMove(updated);
      setStatus(t("saved_n", { n: rounded.length }));

    }, immediate ? 0 : 300);
  }

  function handleSelect(name: string | null, additive = false) {
    setSelectedPinId(null);
    // In labelling mode a click on a part means "label this", not "select it";
    // a click on empty space just clears the label selection.
    if (calloutMode) {
      setSelectedCalloutId(null);
      if (name) addCalloutFor(name);
      return;
    }
    setSelectedCalloutId(null);
    // Picking anything else — a part, a pin, or empty space — closes the beam
    // editor, so it needn't be dismissed with its ✕ every time.
    setSelectedSegment(null);
    if (!name) {
      setSelection([]);
      setEnteredGroupId(null);
      return;
    }
    // Clicking anything outside the group we drilled into steps back out, so
    // the next click on that group selects it whole again.
    if (enteredGroupId && groupOf(groups, name)?.id !== enteredGroupId) {
      setEnteredGroupId(null);
      setSelection(resolveClick(groups, selection, name, { additive, enteredGroupId: null }));
      return;
    }
    setSelection((prev) => resolveClick(groups, prev, name, { additive, enteredGroupId }));
  }

  // Double-click steps inside a group so its members can be edited singly.
  function handleDrillIn(name: string) {
    const group = groupOf(groups, name);
    if (!group) return;
    setEnteredGroupId(group.id);
    setSelection([name]);
    setSelectedPinId(null);
    setSelectedSegment(null);
  }

  async function saveGroups(next: ComponentGroup[]) {
    if (!current) return;
    setData((d) => (d ? { ...d, groups: next } : d));   // optimistic
    const r = await api.updateGroups(current, next);
    setData((d) => (d ? { ...d, groups: r.groups } : d));
  }

  async function createGroup() {
    if (selection.length < 2) return;
    const { groups: next, created } = withNewGroup(groups, selection);
    setEnteredGroupId(null);
    setSelection(created.members);
    setStatus(t("group_created", { name: created.name, n: created.members.length }));
    await saveGroups(next);
  }

  async function ungroup() {
    const covering = groupsCovering(groups, selection);
    if (covering.length === 0) return;
    setEnteredGroupId(null);
    setStatus(t("group_removed", { n: covering.length }));
    await saveGroups(withoutGroups(groups, selection));
  }

  async function renameGroup(id: string, name: string) {
    await saveGroups(groups.map((g) => (g.id === id ? { ...g, name } : g)));
  }

  // ----- undo / redo -----

  // A history step can bring parts back or take them away, so anything the UI
  // is holding by name has to be re-checked against the restored scene.
  function applyHistoryStep(d: ProjectData, message: string) {
    setData(d);
    setPins(d.pins ?? []);
    const present = new Set(d.components.map((c) => c.name));
    setSelection((prev) => prev.filter((name) => present.has(name)));
    setEnteredGroupId(null);
    setSelectedPinId(null);
    setStatus(message);
  }

  // Held Ctrl+Z fires faster than the round trip. Chaining the requests keeps
  // them one at a time and in order — overlapping them lets an older response
  // land last and leave the viewport showing a scene the server has moved past.
  function queueHistoryStep(step: () => Promise<void>) {
    historyChain.current = historyChain.current.then(step, step);
    return historyChain.current;
  }

  async function onUndo() {
    if (!current) return;
    await flushPendingSave();          // never rewind past an unsaved move
    await queueHistoryStep(async () => {
      const d = await api.undo(current, renderMode);
      applyHistoryStep(d, d.stepped ? t("undone") : t("undo_empty"));
    });
  }

  async function onRedo() {
    if (!current) return;
    await flushPendingSave();
    await queueHistoryStep(async () => {
      const d = await api.redo(current, renderMode);
      applyHistoryStep(d, d.stepped ? t("redone") : t("redo_empty"));
    });
  }

  // ----- copy & paste -----

  function onCopy() {
    if (selection.length === 0 || !current) return;
    const copied = { project: current, names: selection };
    setClipboard(copied);
    writeClipboard(copied);
    pasteStep.current = 0;
    setStatus(t("copied_n", { n: selection.length }));
  }

  // The copies are made server-side from the source prims, so a paste is one
  // request: USD gains the parts, and the response is the new scene. `from`
  // names the project to copy out of when it isn't the open one.
  async function pasteComponents(names: string[], step: number, from?: string) {
    if (!current) return;
    setStatus(t("pasting"));
    try {
      // One breadboard hole per step, so copies stay on the grid.
      const offset = (data?.board.spacing ?? 25) * step;
      const r = await api.duplicateComponents(
        current, names, offset, offset, renderMode, from
      );
      setData(r);
      setEnteredGroupId(null);
      setSelection(r.names);            // pasted copies become the selection
      setStatus(from
        ? t("pasted_n_from", { n: r.names.length, project: from })
        : t("pasted_n", { n: r.names.length }));
    } catch {
      // The usual cause is a source part (or project) deleted since the copy.
      setStatus(t(from ? "paste_source_gone" : "paste_failed", { project: from ?? "" }));
    }
  }

  async function onPaste() {
    if (!clipboard || !current) {
      setStatus(t("paste_empty"));
      return;
    }
    const from = clipboard.project === current ? undefined : clipboard.project;
    let names = clipboard.names;
    if (!from) {
      // A copied part may have been deleted since — paste whatever is still
      // there. Parts in another project can't be checked from here; the server
      // reports what's missing.
      names = names.filter((n) => components.some((c) => c.name === n));
      if (names.length === 0) {
        setStatus(t("paste_gone"));
        return;
      }
    }
    // Within a project the first paste has to step off its original; pasting
    // into a different one starts on the source's own coordinates, so the
    // parts land where they sat on the other bench.
    const step = from ? pasteStep.current : pasteStep.current + 1;
    pasteStep.current += 1;
    await pasteComponents(names, step, from);
  }

  // Ctrl+D — copy and paste in one go, the usual "duplicate this" shortcut.
  async function onDuplicateSelection() {
    if (selection.length === 0 || !current) return;
    const copied = { project: current, names: selection };
    setClipboard(copied);
    writeClipboard(copied);
    pasteStep.current = 1;
    await pasteComponents(selection, 1);
  }

  async function savePins(nextPins: PinAnnotation[]) {
    if (!current) return;
    await api.updatePins(current, nextPins);
  }

  async function handleAddPinAt(x: number, y: number, z: number) {
    const authorName = pinUserName.trim();

    if (!authorName) {
      window.alert("Please enter your name before placing a pin.");
      return;
    }

    const newPin: PinAnnotation = {
      id: createPinId(),
      label: "New pin",
      x,
      y,
      z,
      authorName,
      color: pinColor,
      size: 1,
      createdAt: new Date().toISOString(),
    };

    setSelection([]);
    setPinMode(false);
    setPinEditor({ mode: "create", pin: newPin, value: newPin.label });
  }

  async function handleDeletePin(id: string) {
    const ok = window.confirm("Delete this pin?");
    if (!ok) return;

    const nextPins = pins.filter((pin) => pin.id !== id);
    setPins(nextPins);
    setSelectedPinId(null);
    await savePins(nextPins);
  }

  async function handleMovePin(id: string, x: number, y: number, z: number) {
    const nextPins = pins.map((pin) => pin.id === id ? { ...pin, x, y, z } : pin);
    setPins(nextPins);
    await savePins(nextPins);
  }

  function handleEditPin(id: string) {
    const pin = pins.find((item) => item.id === id);
    if (!pin) return;

    setPinEditor({ mode: "edit", pin, value: pin.label });
  }

  async function savePinEditor() {
    if (!pinEditor) return;

    const updatedPin = { ...pinEditor.pin, label: pinEditor.value };
    const nextPins = pinEditor.mode === "create"
      ? [...pins, updatedPin]
      : pins.map((item) => item.id === updatedPin.id ? updatedPin : item);
    setPins(nextPins);
    setSelectedPinId(updatedPin.id);
    setPinEditor(null);
    await savePins(nextPins);
  }

  function handleStartPlacing() {
    setPinMode(false);
    setIsPlacing(true);
    setStatus(t("placing_hint"));
  }

  /** A tile in the catalogue: select it and go straight into placing. */
  function handlePickPart(picked: string) {
    setAsset(picked);
    setBrowsingParts(false);
    handleStartPlacing();
  }

  async function onFold(name: string, turn: "left" | "right") {
    if (!current) return;
    await flushPendingSave();
    try {
      await applyMove(await api.foldBeam(current, name, turn, renderMode));
      setStatus(t("folded", { name }));
    } catch {
      setStatus(t("fold_failed"));
    }
  }

  async function onPlace(point: THREE.Vector3, snap = true) {
    if (!current || !asset) return;
    setIsPlacing(false);
    const r = await api.addComponent(current, asset, point.x, point.y, snap);
    const d = await api.getProject(current, renderMode);
    setData(d); setSelection([r.name]);
    setStatus(r.snapped
      ? t("placed_on_beam")
      : t("components_n", { n: d.components.length }));
  }

  // Removes everything currently selected — one part, or every member of a
  // selected group. The server prunes the deleted names out of their group.
  async function onDelete() {
    if (!current || selection.length === 0) return;

    const message = selection.length === 1
      ? t("remove_confirm", { name: selection[0] })
      : t("remove_confirm_n", { n: selection.length });
    if (!confirm(message)) return;

    for (const name of selection) {
      await api.deleteComponent(current, name);
    }
    setSelection([]);
    setEnteredGroupId(null);

    const d = await api.getProject(current, renderMode);
    setData(d);
  }

  async function onPinBeamNode(
    segment: number,
    node: number,
    position: [number, number, number] | null,
  ) {
    if (!current) return;

    await api.pinBeamNode(current, segment, node, position);

    const d = await api.getProject(current, renderMode);
    setData(d);
  }

  // Keyboard shortcuts: Delete → remove selected, Escape → deselect.
  useEffect(() => {
    if (!current) return;

    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      // Added:
      // Delete the selected pin first if a pin is selected.
      if ((e.key === "Delete" || e.key === "Backspace") && selectedPinId) {
        const ok = window.confirm("Delete this pin?");
        if (!ok) return;

        setPins((prev) => prev.filter((pin) => pin.id !== selectedPinId));
        setSelectedPinId(null);
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selection.length > 0) {
        void onDelete();
        return;
      }

      // Ctrl/Cmd + G groups the selection, Ctrl/Cmd + Shift + G ungroups it.
      // Both are claimed by the browser's find-again, so stop the default.
      if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        if (e.shiftKey) void ungroup();
        else void createGroup();
        return;
      }

      // Ctrl/Cmd + Z rewinds a step, Ctrl/Cmd + Shift + Z (or Ctrl+Y) replays it.
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) void onRedo();
        else void onUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        void onRedo();
        return;
      }

      // Ctrl/Cmd + C / V / D — copy, paste, duplicate the selection.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase();
        // Leave the browser's own copy alone when the user is copying text.
        const textSelected = !(window.getSelection()?.isCollapsed ?? true);
        if (key === "c" && selection.length > 0 && !textSelected) {
          e.preventDefault();
          onCopy();
          return;
        }
        if (key === "v" && clipboard) {
          e.preventDefault();
          void onPaste();
          return;
        }
        if (key === "d" && selection.length > 0) {
          e.preventDefault();          // Chrome's "bookmark this page"
          void onDuplicateSelection();
          return;
        }
      }

      if (e.key === "Escape") {
        if (isPlacing) {
          setIsPlacing(false);
          setStatus(t("components_n", { n: components.length }));
        } else if (calloutMode) {
          // Leaves the labels on screen — Esc ends the labelling mode, it does
          // not undo the figure.
          setCalloutMode(false);
          setSelectedCalloutId(null);
        } else if (enteredGroupId) {
          // Step back out of the group instead of dropping the selection.
          const group = groups.find((g) => g.id === enteredGroupId);
          setEnteredGroupId(null);
          setSelection(group ? group.members : []);
        } else {
          setSelection([]);
        }
        setSelectedPinId(null);
        setPinMode(false);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, selection, selectedPinId, t, isPlacing, components,
      renderMode, groups, enteredGroupId, clipboard, data, calloutMode]);

  // ----- render -----
  if (!current) {
    return (
      <div className="app">
        <div className="toolbar">
          <span className="brand brand-logo" aria-label="OpticalTwin">
            <img className="brand-logo-light" src="/logo.png" alt="OpticalTwin" />
            <img className="brand-logo-dark" src="/logo-dark.png" alt="" aria-hidden="true" />
          </span>

          <div className="spacer" />
          <Toggles showBg={false} />
        </div>

        <ProjectGallery
          projects={projects}
          templates={templates}
          lasers={laserAssets}
          defaultBeamHeight={defaultBeamHeight}
          onOpen={openProject}
          onCreate={createProject}
          onDelete={deleteProject}
          onDuplicate={duplicateProject}
          onRename={renameProject}
          onFile={fileProject}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="toolbar">
        <button className="backbtn" onClick={() => setCurrent(null)}>
          {t("back_projects")}
        </button>

        <span className="proj-name">{current}</span>
        <div className="spacer" />
        <span className="status">{status}</span>

        <div className="history-controls" role="group" aria-label={t("history")}>
          <button
            type="button"
            className="iconbtn"
            disabled={!data?.canUndo}
            onClick={() => void onUndo()}
            aria-label={t("undo")}
            title={`${t("undo")} — Ctrl+Z`}
          >
            ↶
          </button>
          <button
            type="button"
            className="iconbtn"
            disabled={!data?.canRedo}
            onClick={() => void onRedo()}
            aria-label={t("redo")}
            title={`${t("redo")} — Ctrl+Shift+Z`}
          >
            ↷
          </button>
        </div>

        <div
          className="transform-mode-toggle"
          role="group"
          aria-label={t("transform_mode")}
        >
          <button
            type="button"
            className={transformMode === "translate" ? "active" : ""}
            aria-pressed={transformMode === "translate"}
            disabled={selection.length === 0}
            onClick={() => setTransformMode("translate")}
            title={t("transform_move_hint")}
          >
            {t("transform_move")}
          </button>
          <button
            type="button"
            className={transformMode === "rotate" ? "active" : ""}
            aria-pressed={transformMode === "rotate"}
            disabled={selection.length === 0}
            onClick={() => setTransformMode("rotate")}
            title={t("transform_rotate_hint")}
          >
            {t("transform_rotate")}
          </button>
        </div>

        <button
          className={`toggle ${renderMode === "hi" ? "active" : "ghost"}`}
          onClick={toggleRenderMode}
          disabled={lodLoading}
          title="Switch every component in this project between low and high detail"
        >
          LOD: {renderMode.toUpperCase()}
        </button>

        {/* The actual laser switch. Off means the source emits nothing, so
            there is no beam anywhere and nothing to shape; on brings it back
            visible and editable. Labelled with the state it is *in*, not the
            action — the old button said "OFF" while the beam was showing. */}
        {lasers.length > 0 && (
          <button
            className={`toggle ${lasersOn ? "active" : "ghost"}`}
            onClick={toggleLasers}
            aria-pressed={lasersOn}
            title={lasersOn
              ? `Switch off ${lasers.length > 1 ? "the lasers" : "the laser"}`
              : `Switch on ${lasers.length > 1 ? "the lasers" : "the laser"}`}
          >
            Laser: {lasersOn ? "ON" : "OFF"}
          </button>
        )}
        {/*
          Added:
          Toggle Add pin mode.
          When enabled, the next click on the breadboard creates a pin.
        */}
        <button
          className={pinMode ? "primary" : ""}
          onClick={() => {
            setIsPlacing(false);
            setPinMode((v) => !v);
            setSelection([]);
            setSelectedPinId(null);
          }}
          title="Place a 3D annotation pin on the breadboard"
        >
          {pinMode ? "Cancel pin" : "Add pin"}
        </button>
        {/*
          Icon-only: the toolbar is crowded, and a camera reads faster than the
          word. aria-label keeps the accessible name so screen readers and the
          e2e selectors still find it by "Snapshot".
        */}
        {/*
          One control, two segments — editing the labels and showing them are
          different questions ("let me label parts" vs "keep them out of my way
          while I arrange the bench"), but they belong to the same thing, so they
          read as one button with an eye on the end rather than two 図注 buttons
          competing for the toolbar. The eye is always there — gating it on
          "this bench already has a label" made the control a different shape in
          every project, so the one bench that had been labelled looked like the
          only one that could be.
        */}
        <div className="callout-toggle" role="group" aria-label="図注">
          <button
            className={calloutMode ? "active" : "ghost"}
            aria-pressed={calloutMode}
            onClick={() => {
              setIsPlacing(false);
              setPinMode(false);
              // Entering the mode turns the layer back on: labelling parts you
              // cannot see is the one state this button must never leave you in.
              setCalloutMode((v) => {
                if (!v) setCalloutsVisible(true);
                return !v;
              });
              setSelection([]);
              setSelectedPinId(null);
            }}
            title={calloutMode
              ? "図注モードを終了（Esc）"
              : "部品をクリックして図注ラベルを付ける（論文用）"}
          >
            図注
          </button>
          <button
            className={calloutsVisible ? "ghost" : "active"}
            aria-pressed={!calloutsVisible}
            aria-label="図注ラベルの表示 / 非表示"
            onClick={() => {
              setCalloutsVisible((v) => {
                if (v) { setCalloutMode(false); setSelectedCalloutId(null); }
                return !v;
              });
            }}
            title={calloutsVisible
              ? "図注ラベルを隠す（書き出しにも反映）"
              : "図注ラベルを表示"}
          >
            <EyeIcon off={!calloutsVisible} />
          </button>
        </div>
        <button
          className="ghost" data-testid="open-photo"
          onClick={() => setPhotoOpen(true)}
          title={t("photo_title")}
        >
          {t("photo_button")}
        </button>
        <button
          className="iconbtn ghost"
          onClick={() => setFigureExport(figureExport ?? DEFAULT_FIGURE_SETTINGS)}
          disabled={!viewportReady}
          title={t("snapshot")}
          aria-label={t("snapshot")}
        >
          <CameraIcon />
        </button>
        {pinMode && (
          <div className="pin-add-panel">
            {/*
              Added:
              The user enters the author name only while Add pin mode is active.
            */}
            <input
              className="pin-user-input"
              value={pinUserName}
              onChange={(e) => setPinUserName(e.target.value)}
              placeholder="Your name"
              title="Name shown on newly created pins"
            />

            {/*
              Added:
              The user chooses the color for the next pin only while Add pin mode is active.
            */}
            <div className="pin-color-buttons">
              {PIN_COLOR_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={pinColor === option.value ? "pin-color-btn selected" : "pin-color-btn"}
                  onClick={() => setPinColor(option.value)}
                  title={option.label}
                >
                  <span
                    className="pin-color-dot"
                    style={{ background: option.value }}
                  />
                </button>
              ))}
            </div>

            <span className="pin-mode-hint">
              Click on the breadboard to place a pin
            </span>
          </div>
        )}

        <Toggles />
      </div>

      <div className="work">
        <aside className={`panel-slot outliner-slot ${showOutliner ? "open" : "closed"}`}>
          <button
            className="panel-toggle"
            onClick={() => setShowOutliner((show) => !show)}
            title={showOutliner ? "Hide Outliner" : "Show Outliner"}
          >
            Outliner
          </button>
          {showOutliner && (
            <Outliner
              components={components}
              groups={groups}
              beam={data?.beam ?? []}
              selection={selection}
              enteredGroupId={enteredGroupId}
              onSelect={handleSelect}
              onDrillIn={handleDrillIn}
              library={data?.library ?? []}
              asset={asset}
              onAssetChange={setAsset}
              onAdd={handleStartPlacing}
              onBrowse={() => setBrowsingParts(true)}
              isPlacing={isPlacing}
            />
          )}
        </aside>
        {browsingParts && data && (
          <PartBrowser
            library={data.library}
            previews={data.libraryPreviews}
            asset={asset}
            onPick={handlePickPart}
            onClose={() => setBrowsingParts(false)}
          />
        )}
        <div className="viewport">
          {lodLoading && (
            <div className="lod-loading" role="status" aria-live="polite">
              <div className="lod-loading-card">
                <span className="lod-ring" aria-hidden="true" />
                <div className="lod-loading-copy">
                  <span>Loading high models…</span>
                </div>
              </div>
            </div>
          )}
          {data && (
            <Viewport
              ref={viewportRef}
              onReady={() => setViewportReady(true)}
              components={components}
              beam={beam}
              selectedSegmentKey={selectedSegment?.key ?? null}
              onSelectSegment={setSelectedSegment}
              beamEditor={selectedSegment && (
                <SegmentPopover
                  segment={selectedSegment}
                  board={data?.board.bbox}
                  onShape={onShapeSegment}
                  onClose={() => setSelectedSegment(null)}
                />
              )}
              board={data.board}
              selection={selection}
              groups={groups}
              enteredGroupId={enteredGroupId}
              transformMode={transformMode}
              onSelect={handleSelect}
              onDrillIn={handleDrillIn}
              isPlacing={isPlacing}
              placingAsset={asset}
              libraryPreviews={data.libraryPreviews}
              library={data.library}
              onPlace={isPlacing ? onPlace : undefined}
              onMove={onMove}
              onMoveMany={onMoveMany}
              onFold={onFold}
              pins={pins}
              pinMode={pinMode}
              selectedPinId={selectedPinId}
              onAddPinAt={handleAddPinAt}
              onSelectPin={setSelectedPinId}
              onDeletePin={handleDeletePin}
              onEditPin={handleEditPin}
              onMovePin={handleMovePin}
              pinPreview={{ authorName: pinUserName, color: pinColor }}
              callouts={callouts}
              anchorStore={anchorStore}
            />
          )}
          {data && callouts.length > 0 && calloutsVisible && (
            <CalloutLayer
              callouts={callouts}
              store={anchorStore}
              selectedId={selectedCalloutId}
              showHidden={calloutMode}
              onSelect={setSelectedCalloutId}
              onChange={updateCallout}
              onDelete={deleteCallout}
              onPickAnchor={(x, y, target) =>
                viewportRef.current?.pickAnchor(x, y, target) ?? null}
            />
          )}
        </div>
        <aside className={`panel-slot inspector-slot ${showInspector ? "open" : "closed"}`}>
          <button
            className="panel-toggle"
            onClick={() => setShowInspector((show) => !show)}
            title={showInspector ? "Hide Inspector" : "Show Inspector"}
          >
            Inspector
          </button>
          {showInspector && (
            <Inspector
              component={selectedComp}
              prev={prevComp}
              onEdit={onEdit}
              onDelete={onDelete}
              onDuplicate={onDuplicateSelection}
              beamPath={data?.beamPath ?? []}
              onPinBeamNode={onPinBeamNode}
              selection={selection}
              group={selectedGroup}
              components={components}
              onNudge={onMoveMany}
              onCreateGroup={createGroup}
              onUngroup={ungroup}
              onRenameGroup={renameGroup}
              board={data?.board ?? null}
              boardModels={data?.boardModels ?? []}
              onChangeBoardModel={onChangeBoardModel}
              modelOptions={
                modelOptionsFor(data?.library ?? [], selectedComp?.type ?? "")
              }
              onChangeModel={onChangeModel}
            />
          )}
        </aside>
      </div>

      {photoOpen && current && data && (
        <PhotoBuilder
          project={current}
          data={data}
          renderMode={renderMode}
          onClose={() => setPhotoOpen(false)}
          onBuilt={(payload) => {
            setData(payload); setSelection([]);
            setStatus(t("components_n", { n: payload.components.length }));
          }}
          onBoardModel={async (asset) => {
            setData(await api.updateBoardModel(current, asset, renderMode));
          }}
        />
      )}

      {figureExport && (
        <FigureExportDialog
          initial={figureExport}
          busy={exporting}
          onExport={(settings) => {
            setFigureExport(settings);
            void handleSnapshot(settings);
          }}
          onClose={() => setFigureExport(null)}
        />
      )}

      {pinEditor && (
        <div className="pin-editor-overlay" onMouseDown={() => setPinEditor(null)}>
          <div className="pin-editor-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="pin-editor-title">
              {pinEditor.mode === "create" ? "Add pin label" : "Edit pin label"}
            </div>
            <textarea
              autoFocus
              value={pinEditor.value}
              onChange={(e) => setPinEditor({ ...pinEditor, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setPinEditor(null);
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void savePinEditor();
                }
              }}
              placeholder="Pin label"
            />
            <div className="pin-editor-hint">Enterで改行・Ctrl/⌘ + Enterで保存</div>
            <div className="pin-editor-actions">
              <button type="button" onClick={() => setPinEditor(null)}>Cancel</button>
              <button type="button" className="primary" onClick={() => void savePinEditor()}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
