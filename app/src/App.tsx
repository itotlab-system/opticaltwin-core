import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import Viewport, {
  type TransformMode,
  type ViewportHandle,
} from "./scene/Viewport";
import Outliner from "./ui/Outliner";
import Inspector from "./ui/Inspector";
import SegmentPopover from "./ui/SegmentPopover";
import type { SegmentShape } from "./beamShape";
import ProjectGallery from "./ui/ProjectGallery";
import Toggles from "./ui/Toggles";
import { useSettings } from "./settings";
import { api } from "./api";
import { buildSnapshotFilename, downloadBlob } from "./snapshot";

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
  PinAnnotation,
  ProjectData,
  ProjectSummary,
  Template,
} from "./types";
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
// since a paste can land in a different project (#155). Kept in localStorage
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

export default function App() {
  const { t } = useSettings();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [current, setCurrent] = useState<string | null>(null);   // null = gallery
  const [data, setData] = useState<ProjectData | null>(null);
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
  const [status, setStatus] = useState("");
  const [renderMode, setRenderMode] = useState<"lo" | "hi">("lo");
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
  // The user manually types the name shown on newly created pins.
  const [pinUserName, setPinUserName] = useState("");

  // Added:
  // Selected color for newly created pins.
  const [pinColor, setPinColor] = useState<string>(PIN_COLOR_OPTIONS[0].value);
  const [pinEditor, setPinEditor] = useState<PinEditorState | null>(null);
  useEffect(() => { refreshGallery(); }, []);

  async function refreshGallery() {
    const r = await api.listProjects();
    setProjects(r.projects);
    setTemplates(r.templates);
  }

  // A leg that no longer exists (parts moved, a part was deleted) must not
  // keep an editor open over empty space.
  useEffect(() => {
    if (!selectedSegment) return;
    const still = data?.beam.some((s) => s.key === selectedSegment.key);
    if (!still) setSelectedSegment(null);
  }, [data, selectedSegment]);

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
      setRenderMode("lo");

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
    })();
  }, [current]);

  // ----- gallery actions -----
  async function openProject(name: string) {
    setSelection([]);
    setEnteredGroupId(null);
    setCurrent(name);
  }

  async function createProject(name: string, template: string) {
    const r = await api.createProject(name, template);
    await refreshGallery();
    openProject(r.name);
  }

  async function deleteProject(name: string) {
    if (!confirm(t("delete_confirm", { name }))) return;
    await api.removeProject(name);
    await refreshGallery();
  }

  // Copies the whole setup under <name>_copy — a safe place to try changes.
  async function duplicateProject(name: string) {
    await api.duplicateProject(name);
    await refreshGallery();
  }

  async function toggleRenderMode() {
    if (!current) return;
    const next = renderMode === "lo" ? "hi" : "lo";
    setIsPlacing(false);
    setStatus(`Loading ${next.toUpperCase()} models…`);
    const d = await api.getProject(current, next);
    setRenderMode(next);
    setData(d);
    // Hi/lo swaps can drop parts that have no model at that detail level.
    const present = new Set(d.components.map((c) => c.name));
    setSelection((prev) => prev.filter((name) => present.has(name)));
    setStatus(`${next.toUpperCase()} · ${d.components.length} components`);
  }

  async function handleSnapshot() {
    if (!current) return;

    // Hide the selection gizmo/guides for a clean shot, then restore it.
    const prevSelection = selection;
    const prevSelectedPinId = selectedPinId;
    setSelection([]);
    setSelectedPinId(null);
    const blob = await viewportRef.current?.captureSnapshot();
    setSelection(prevSelection);
    setSelectedPinId(prevSelectedPinId);

    if (!blob) return;
    downloadBlob(blob, buildSnapshotFilename(current));
    setStatus(t("snapshot_saved"));
  }

  // ----- editor state -----
  const components = data?.components ?? [];
  const sorted = [...components].sort((a, b) => a.x - b.x);

  const beam: BeamSegment[] = data?.beam ?? [];
  const groups: ComponentGroup[] = data?.groups ?? [];

  const selected = selection.length === 1 ? selection[0] : null;
  // Lasers and whether any is emitting. `laserOn` is absent on lasers placed
  // before the switch existed, which means on.
  const lasers = components.filter((c) => c.type === "laser");
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

  // Debounce a save, remembering the work so it can also be flushed on demand.
  // Holding the timer means a whole drag or a burst of arrow-key nudges lands
  // as one request — and therefore as one undo step.
  function scheduleSave(run: () => Promise<void>) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    pendingSave.current = run;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      pendingSave.current = null;
      void run();
    }, 300);
  }

  async function flushPendingSave() {
    const run = pendingSave.current;
    if (!run) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    pendingSave.current = null;
    await run();
  }

  function pushUpdate(comp: Component) {
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

      setData(updated);
      setStatus(t("saved", { name: comp.name }));

    });
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
  ) {
    const u = patchLocal(name, {
      x: Math.round(x * 2) / 2,
      y: Math.round(y * 2) / 2,
      z: Math.round(z * 10) / 10,   // heights are fine-grained; keep 0.1 mm
      rotX: Math.round(rotX),
      rotY: Math.round(rotY),
      rotZ: Math.round(rotZ),
    });
    if (u) pushUpdate(u);
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
      setData(updated);
      setSelectedSegment(
        updated.beam.find((s) => s.key === key) ?? null
      );
      setStatus(t("saved", { name: key }));
    });
  }

  function onMoveMany(updates: ComponentUpdate[]) {
    if (!current || updates.length === 0) return;
    const rounded = updates.map(roundUpdate);
    patchLocalMany(rounded);

    scheduleSave(async () => {
      setStatus(t("saving_n", { n: rounded.length }));
      const updated = await api.updateComponents(current, rounded, renderMode);
      setData(updated);
      setStatus(t("saved_n", { n: rounded.length }));

    });
  }

  function handleSelect(name: string | null, additive = false) {
    setSelectedPinId(null);
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
    setStatus("Click on the breadboard to place the new component. (Esc to cancel)");
  }

  async function onPlace(point: THREE.Vector3) {
    if (!current || !asset) return;
    setIsPlacing(false);
    const r = await api.addComponent(current, asset, point.x, point.y);
    const d = await api.getProject(current, renderMode);
    setData(d); setSelection([r.name]);
    setStatus(t("components_n", { n: d.components.length }));
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
      renderMode, groups, enteredGroupId, clipboard, data]);

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
          <Toggles />
        </div>

        <ProjectGallery
          projects={projects}
          templates={templates}
          onOpen={openProject}
          onCreate={createProject}
          onDelete={deleteProject}
          onDuplicate={duplicateProject}
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
        <button
          className="iconbtn ghost"
          onClick={() => void handleSnapshot()}
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
              selection={selection}
              enteredGroupId={enteredGroupId}
              onSelect={handleSelect}
              onDrillIn={handleDrillIn}
              library={data?.library ?? []}
              asset={asset}
              onAssetChange={setAsset}
              onAdd={handleStartPlacing}
              isPlacing={isPlacing}
            />
          )}
        </aside>
        <div className="viewport">
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
              onChangeModel={onChangeModel}
              pins={pins}
              pinMode={pinMode}
              selectedPinId={selectedPinId}
              onAddPinAt={handleAddPinAt}
              onSelectPin={setSelectedPinId}
              onDeletePin={handleDeletePin}
              onEditPin={handleEditPin}
              onMovePin={handleMovePin}
              pinPreview={{ authorName: pinUserName, color: pinColor }}
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
            />
          )}
        </aside>
      </div>

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
