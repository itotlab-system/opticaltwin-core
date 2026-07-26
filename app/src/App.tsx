import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import Viewport, { type ViewportHandle } from "./scene/Viewport";
import Outliner from "./ui/Outliner";
import Inspector from "./ui/Inspector";
import PhysicsPanel from "./ui/PhysicsPanel";
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
  ParaxialSegment,
  PinAnnotation,
  ProjectData,
  ProjectSummary,
  Template,
} from "./types";

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

export default function App() {
  const { t } = useSettings();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [current, setCurrent] = useState<string | null>(null);   // null = gallery
  const [data, setData] = useState<ProjectData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [asset, setAsset] = useState("");
  const [isPlacing, setIsPlacing] = useState(false);
  const [status, setStatus] = useState("");
  const [renderMode, setRenderMode] = useState<"lo" | "hi">("lo");
  const [showParaxial, setShowParaxial] = useState(false);
  const [showOutliner, setShowOutliner] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const [paraxialBeam, setParaxialBeam] = useState<ParaxialSegment[]>([]);
  // True once the R3F canvas has finished its first render, so the
  // Snapshot button can't be clicked before there's anything to capture.
  const [viewportReady, setViewportReady] = useState(false);
  const showParaxialRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
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

  // Keep ref in sync so pushUpdate (closure) can read current value.
  useEffect(() => { showParaxialRef.current = showParaxial; }, [showParaxial]);

  // Load a project's full scene when one is opened.
  useEffect(() => {
    if (!current) {
      // Before:
      // setData(null); setSelected(null);
      // setShowParaxial(false); setParaxialBeam([]);

      setData(null);
      setSelected(null);
      setShowParaxial(false);
      setParaxialBeam([]);
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
    setSelected(null);
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

  async function toggleParaxial() {
    if (!current) return;
    const next = !showParaxial;

    if (next) {
      const r = await api.getParaxialBeam(current);
      setParaxialBeam(r.segments);
    }

    setShowParaxial(next);
  }

  async function toggleRenderMode() {
    if (!current) return;
    const next = renderMode === "lo" ? "hi" : "lo";
    setIsPlacing(false);
    setStatus(`Loading ${next.toUpperCase()} models…`);
    const d = await api.getProject(current, next);
    setRenderMode(next);
    setData(d);
    if (selected && !d.components.some((c) => c.name === selected)) {
      setSelected(null);
    }
    setStatus(`${next.toUpperCase()} · ${d.components.length} components`);
  }

  async function handleSnapshot() {
    if (!current) return;

    // Hide the selection gizmo/guides for a clean shot, then restore it.
    const prevSelected = selected;
    const prevSelectedPinId = selectedPinId;
    setSelected(null);
    setSelectedPinId(null);
    const blob = await viewportRef.current?.captureSnapshot();
    setSelected(prevSelected);
    setSelectedPinId(prevSelectedPinId);

    if (!blob) return;
    downloadBlob(blob, buildSnapshotFilename(current));
    setStatus(t("snapshot_saved"));
  }

  // ----- editor state -----
  const components = data?.components ?? [];
  const sorted = [...components].sort((a, b) => a.x - b.x);

  const beam: BeamSegment[] = data?.beam ?? [];

  const selectedComp = components.find((c) => c.name === selected) ?? null;

  const prevComp = (() => {
    if (!selectedComp) return null;

    const i = sorted.findIndex((c) => c.name === selectedComp.name);
    return i > 0 ? sorted[i - 1] : null;
  })();

  function pushUpdate(comp: Component) {
    if (saveTimer.current) clearTimeout(saveTimer.current);

    saveTimer.current = window.setTimeout(async () => {
      setStatus(t("saving", { name: comp.name }));

      const updated = await api.updateComponent(current!, comp.name, {
        x: comp.x,
        y: comp.y,
        z: comp.z,
        rotZ: comp.rotZ,
        renderMode,
      });

      setData(updated);
      setStatus(t("saved", { name: comp.name }));

      if (showParaxialRef.current && current) {
        api.getParaxialBeam(current).then((r) => setParaxialBeam(r.segments));
      }
    }, 300);
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

  function onEdit(field: "x" | "y" | "z" | "rotZ", value: number) {
    if (!selectedComp || Number.isNaN(value)) return;

    const u = patchLocal(selectedComp.name, { [field]: value });
    if (u) pushUpdate(u);
  }

  function onMove(name: string, x: number, y: number, z: number, rotZ: number) {
    const u = patchLocal(name, {
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z * 10) / 10,   // heights are fine-grained; keep 0.1 mm
      rotZ: Math.round(rotZ)
    });
    if (u) pushUpdate(u);
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

    setSelected(null);
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
    setData(d); setSelected(r.name);
    setStatus(t("components_n", { n: d.components.length }));
  }

  async function onDelete() {
    if (!current || !selectedComp) return;

    if (!confirm(t("remove_confirm", { name: selectedComp.name }))) return;

    await api.deleteComponent(current, selectedComp.name);
    setSelected(null);

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

      if ((e.key === "Delete" || e.key === "Backspace") && selected && selectedComp) {
        if (!confirm(t("remove_confirm", { name: selectedComp.name }))) return;

        api.deleteComponent(current!, selectedComp.name)
          .then(() => {
            setSelected(null);
            return api.getProject(current!, renderMode);
          })
          .then(setData);
      }
      if (e.key === "Escape") {
        if (isPlacing) {
          setIsPlacing(false);
          setStatus(t("components_n", { n: components.length }));
        } else {
          setSelected(null);
        }
        setSelectedPinId(null);
        setPinMode(false);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, selected, selectedComp, selectedPinId, t, isPlacing, components.length, renderMode]);

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

        <button
          className={`toggle ${renderMode === "hi" ? "active" : "ghost"}`}
          onClick={toggleRenderMode}
          title="Switch every component in this project between low and high detail"
        >
          LOD: {renderMode.toUpperCase()}
        </button>

        <button
          className={`toggle ${showParaxial ? "active" : "ghost"}`}
          onClick={toggleParaxial}
          title="Show Gaussian beam width (ABCD paraxial simulation)"
        >
          Beam: {showParaxial ? "OFF" : "ON"}
        </button>
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
            setSelected(null);
            setSelectedPinId(null);
          }}
          title="Place a 3D annotation pin on the breadboard"
        >
          {pinMode ? "Cancel pin" : "Add pin"}
        </button>
        <button
          className="toggle ghost"
          onClick={() => void handleSnapshot()}
          disabled={!viewportReady}
          title={t("snapshot")}
        >
          {t("snapshot")}
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
              selected={selected}
              onSelect={(name) => {
                setSelected(name);
                setSelectedPinId(null);
              }}
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
              board={data.board}
              selected={selected}
              onSelect={setSelected}
              isPlacing={isPlacing}
              placingAsset={asset}
              libraryPreviews={data.libraryPreviews}
              onPlace={isPlacing ? onPlace : undefined}
              onMove={onMove}
              paraxialBeam={showParaxial ? paraxialBeam : undefined}
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
              beamPath={data?.beamPath ?? []}
              onPinBeamNode={onPinBeamNode}
              footer={showParaxial && paraxialBeam.length > 0
                ? <PhysicsPanel segments={paraxialBeam} />
                : undefined}
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
