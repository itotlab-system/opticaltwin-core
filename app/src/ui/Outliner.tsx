import type { BeamSegment, Component, ComponentGroup } from "../types";
import { useCallback, useMemo, useRef, useState } from "react";
import { useSettings } from "../settings";
import { colorFor } from "./typeColor";
import { groupOf } from "../groups";
import { buildOutlinerTree } from "../outlinerTree";

/** Which way the bench is listed. Beam order is the default: it is the order
 *  the setup is actually built and discussed in. */
type OutlinerView = "beam" | "type";
const VIEW_KEY = "ot.outlinerView";

function rodModelNumber(asset: string): number {
  const parts = asset.split("/");
  const model = (parts[parts.length - 1] ?? "").replace(/\.usda$/i, "");
  const match = model.match(/^ER(\d+(?:\.\d+)?)(?:-Step)?$/i);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = match[1];
  if (/^0\d+$/.test(value)) {
    return Number(value) / (10 ** (value.length - 1));
  }
  return Number(value);
}

export default function Outliner({
  components, groups, beam, selection, enteredGroupId, onSelect, onDrillIn,
  library, asset, onAssetChange, onAdd, onBrowse, isPlacing,
}: {
  components: Component[];
  groups: ComponentGroup[];
  /** The traced beam — its leg order is what the chain view lists by. */
  beam: BeamSegment[];
  selection: string[];
  enteredGroupId: string | null;
  onSelect: (name: string | null, additive?: boolean) => void;
  // Double-click drills into the group, same as in the viewport.
  onDrillIn: (name: string) => void;
  library: string[];
  asset: string;
  onAssetChange: (a: string) => void;
  onAdd: () => void;
  /** Opens the visual catalogue — the way to find a part you can't name. */
  onBrowse: () => void;
  isPlacing: boolean;
}) {
  const { t } = useSettings();
  const sorted = [...components].sort((a, b) => a.x - b.x);
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<OutlinerView>(() =>
    localStorage.getItem(VIEW_KEY) === "type" ? "type" : "beam");
  const [openOptics, setOpenOptics] = useState<Set<string>>(() => new Set());
  const [looseOpen, setLooseOpen] = useState(false);
  const tree = useMemo(
    () => buildOutlinerTree(components, beam), [components, beam]);

  const chooseView = (next: OutlinerView) => {
    setView(next);
    localStorage.setItem(VIEW_KEY, next);
  };

  const toggleOptic = (name: string) => {
    setOpenOptics((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  /* Keyboard navigation. Rows used to be plain divs with an onClick, so Tab
     walked the type headers and never entered the tree: a keyboard user could
     expand a group but never select a part, and so could never position
     anything. The tree is one tab stop and the arrow keys move within it,
     which is what a tree widget is expected to do. */
  const rowOrder = useRef<string[]>([]);
  rowOrder.current = [];
  const [focused, setFocused] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const registerRow = useCallback((name: string, element: HTMLElement | null) => {
    if (element) rowRefs.current.set(name, element);
    else rowRefs.current.delete(name);
  }, []);

  const moveFocus = (from: string, delta: number) => {
    const order = rowOrder.current;
    const at = order.indexOf(from);
    const next = order[Math.min(Math.max(at + delta, 0), order.length - 1)];
    if (!next || next === from) return;
    setFocused(next);
    rowRefs.current.get(next)?.focus();
  };

  const componentsByType = new Map<string, Component[]>();
  for (const component of sorted) {
    const type = component.type.trim().toLowerCase() || "unknown";
    const typeComponents = componentsByType.get(type) ?? [];
    typeComponents.push(component);
    componentsByType.set(type, typeComponents);
  }
  const componentTypes = [...componentsByType.keys()].sort((a, b) =>
    displayType(a).localeCompare(displayType(b), undefined, { numeric: true })
  );

  const toggleType = (type: string) => {
    setExpandedTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const componentRow = (
    c: Component,
    options: { depth?: number; expanded?: boolean; onToggle?: () => void } = {},
  ) => {
    const componentGroup = groupOf(groups, c.name);
    const { depth = 0, expanded, onToggle } = options;
    rowOrder.current.push(c.name);
    // One tab stop for the whole tree, per the tree pattern: the row that would
    // receive focus is the selected one, else the first.
    const tabbable = focused ? focused === c.name
      : selection.includes(c.name) || rowOrder.current.length === 1;
    return (
      <div
        key={c.name}
        ref={(element) => registerRow(c.name, element)}
        role="treeitem"
        tabIndex={tabbable ? 0 : -1}
        aria-selected={selection.includes(c.name)}
        aria-expanded={expanded}
        aria-level={depth + 1}
        className={"node" + (selection.includes(c.name) ? " sel" : "")
          + " node-member"
          + (depth > 0 ? " node-nested" : "")
          + (componentGroup ? " grouped-member" : "")
          + (componentGroup?.id === enteredGroupId ? " entered" : "")}
        onClick={(e) => { setFocused(c.name); onSelect(c.name, e.ctrlKey || e.metaKey); }}
        onDoubleClick={() => onDrillIn(c.name)}
        onFocus={() => setFocused(c.name)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(c.name, 1); }
          else if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(c.name, -1); }
          else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(c.name, event.ctrlKey || event.metaKey);
          }
          // Right/Left open and close the branch, as in any tree.
          else if (event.key === "ArrowRight" && onToggle && !expanded) {
            event.preventDefault(); onToggle();
          } else if (event.key === "ArrowLeft" && onToggle && expanded) {
            event.preventDefault(); onToggle();
          }
        }}
      >
        {/* Always present, even with nothing to disclose: the arrow is what the
            swatch and name align to, and an optic that carries no hardware
            should not sit half a column left of the one above it. */}
        <span
          className="tree-arrow"
          aria-hidden="true"
          onClick={onToggle
            ? (event) => { event.stopPropagation(); onToggle(); }
            : undefined}
        >{onToggle ? (expanded ? "▾" : "▸") : ""}</span>
        <span className="swatch" style={{ background: colorFor(c.type) }} />
        <span className="nm">{c.name}</span>
        <span className="x-hint" title={t("outliner_x_title")}>
          {c.x >= 0 ? "+" : ""}{Math.round(c.x)}
        </span>
      </div>
    );
  };
  const libraryGroups = new Map<string, string[]>();
  for (const libraryAsset of library) {
    const parts = libraryAsset.split("/");
    const group = parts.length > 1 ? parts[0] : "Components";
    const assets = libraryGroups.get(group) ?? [];
    assets.push(libraryAsset);
    libraryGroups.set(group, assets);
  }
  for (const [group, assets] of libraryGroups) {
    assets.sort((left, right) => {
      if (group === "Rod") {
        const numberDifference = rodModelNumber(left) - rodModelNumber(right);
        if (numberDifference !== 0) return numberDifference;
      }
      return left.localeCompare(right, undefined, { numeric: true });
    });
  }
  const selectedGroup = asset.includes("/")
    ? asset.split("/")[0]
    : "Components";
  const selectedAssets = libraryGroups.get(selectedGroup) ?? [];
  return (
    <div className="outliner">
      <div className="outliner-head">
        {/* The heading names the thing; the toggle beside it names the order,
            so spelling the order out again here only made it wrap into the
            toggle. */}
        <div className="section-title">{t("outliner_heading")}</div>
        {sorted.length > 0 && (
          <div className="view-toggle" role="group" aria-label={t("outliner_view")}>
            <button
              type="button"
              className={view === "beam" ? "active" : ""}
              aria-pressed={view === "beam"}
              onClick={() => chooseView("beam")}
              title={t("outliner_view_beam_title")}
            >{t("outliner_view_beam")}</button>
            <button
              type="button"
              className={view === "type" ? "active" : ""}
              aria-pressed={view === "type"}
              onClick={() => chooseView("type")}
              title={t("outliner_view_type_title")}
            >{t("outliner_view_type")}</button>
          </div>
        )}
      </div>
      {sorted.length === 0 && <div className="empty">{t("outliner_empty")}</div>}

      {view === "beam" && sorted.length > 0 && (
        <div className="tree" role="tree" aria-label={t("outliner_title_beam")}>
          {tree.chain.map(({ component, hardware }) => {
            const open = openOptics.has(component.name);
            return (
              <div key={component.name} className="beam-node">
                {componentRow(component, {
                  expanded: hardware.length > 0 ? open : undefined,
                  onToggle: hardware.length > 0
                    ? () => toggleOptic(component.name) : undefined,
                })}
                {hardware.length > 0 && (
                  <>
                    {!open && (
                      <div className="mount-hint">
                        {hardware.length === 1
                          ? t("outliner_mounts_one")
                          : t("outliner_mounts", { n: hardware.length })}
                      </div>
                    )}
                    {open && (
                      <div className="type-members" role="group">
                        {hardware.map((part) => componentRow(part, { depth: 1 }))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}

          {tree.loose.length > 0 && (
            <div className="type-group">
              {/* Hardware the beam never touches and that sits too far from any
                  one optic to say which it holds — cage rods spanning plates,
                  mostly. Named for what it is rather than filed under a guess. */}
              <button
                type="button"
                className="type-head"
                aria-expanded={looseOpen}
                onClick={() => setLooseOpen((open) => !open)}
              >
                <span className="tree-arrow" aria-hidden="true">{looseOpen ? "▾" : "▸"}</span>
                <span className="nm">{t("outliner_hardware")}</span>
                <span className="x-hint">{tree.loose.length}</span>
              </button>
              {looseOpen && (
                <div className="type-members" role="group">
                  {tree.loose.map((part) => componentRow(part, { depth: 1 }))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {view === "type" && sorted.length > 0 && (
      <div className="tree" role="tree" aria-label={t("outliner_title")}>
      {componentTypes.map((type) => {
        const typeComponents = componentsByType.get(type) ?? [];
        const expanded = expandedTypes.has(type);
        return (
          <div key={type} className="type-group">
            <button
              type="button"
              className="type-head"
              aria-expanded={expanded}
              onClick={() => toggleType(type)}
            >
              <span className="swatch" style={{ background: colorFor(type) }} />
              <span className="tree-arrow" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
              <span className="nm">{displayType(type)}</span>
              <span className="x-hint">{typeComponents.length}</span>
            </button>
            {expanded && (
              <div className="type-members" role="group">
                {typeComponents.map((c) => componentRow(c, { depth: 1 }))}
              </div>
            )}
          </div>
        );
      })}
      </div>
      )}

      {library.length > 0 && (
        <div className="outliner-add">
          <button
            type="button"
            className="browse-parts-btn"
            onClick={onBrowse}
            title={t("browse_parts_title")}
          >
            ▦ {t("browse_parts")}
          </button>
          {libraryGroups.size > 1 && (
            <select
              className="component-group-select"
              aria-label="Component category"
              value={selectedGroup}
              onChange={(event) => {
                const firstAsset = libraryGroups.get(event.target.value)?.[0];
                if (firstAsset) onAssetChange(firstAsset);
              }}
            >
              {[...libraryGroups.keys()].map((group) => (
                <option key={group} value={group}>{group}</option>
              ))}
            </select>
          )}
          <select
            className="component-asset-select"
            aria-label={`${selectedGroup} components`}
            value={asset}
            onChange={(event) => onAssetChange(event.target.value)}
          >
            {selectedAssets.map((libraryAsset) => (
              <option key={libraryAsset} value={libraryAsset}>
                {libraryAsset
                  .replace(`${selectedGroup}/`, "")
                  .replace(".usda", "")}
              </option>
            ))}
          </select>
          <button className={`icon-btn ${isPlacing ? 'primary' : ''}`} onClick={onAdd} title={t("add_part")}>+</button>
        </div>
      )}
    </div>
  );
}

export function displayType(type: string): string {
  const normalized = type.trim().toLowerCase();
  const labels: Record<string, string> = {
    slm: "SLM",
    led: "LED",
    beamsplitter: "Beam Splitter",
    cylindrical_lens: "Cylindrical Lens",
    mount: "Cage",
  };
  return labels[normalized] ?? normalized
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
