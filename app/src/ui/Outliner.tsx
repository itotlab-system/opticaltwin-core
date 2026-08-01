import type { Component, ComponentGroup } from "../types";
import { useState } from "react";
import { useSettings } from "../settings";
import { colorFor } from "./typeColor";
import { groupOf } from "../groups";

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
  components, groups, selection, enteredGroupId, onSelect, onDrillIn,
  library, asset, onAssetChange, onAdd, isPlacing,
}: {
  components: Component[];
  groups: ComponentGroup[];
  selection: string[];
  enteredGroupId: string | null;
  onSelect: (name: string | null, additive?: boolean) => void;
  // Double-click drills into the group, same as in the viewport.
  onDrillIn: (name: string) => void;
  library: string[];
  asset: string;
  onAssetChange: (a: string) => void;
  onAdd: () => void;
  isPlacing: boolean;
}) {
  const { t } = useSettings();
  const sorted = [...components].sort((a, b) => a.x - b.x);
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(() => new Set());

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

  const componentRow = (c: Component) => {
    const componentGroup = groupOf(groups, c.name);
    return (
      <div
        key={c.name}
        className={"node" + (selection.includes(c.name) ? " sel" : "")
          + " node-member"
          + (componentGroup ? " grouped-member" : "")
          + (componentGroup?.id === enteredGroupId ? " entered" : "")}
        onClick={(e) => onSelect(c.name, e.ctrlKey || e.metaKey)}
        onDoubleClick={() => onDrillIn(c.name)}
      >
        <span className="swatch" style={{ background: colorFor(c.type) }} />
        <span className="nm">{c.name}</span>
        <span className="x-hint">{c.x >= 0 ? "+" : ""}{Math.round(c.x)}</span>
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
      <div className="section-title">{t("outliner_title")}</div>
      {sorted.length === 0 && <div className="empty">{t("outliner_empty")}</div>}

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
              <div className="type-members">
                {typeComponents.map(componentRow)}
              </div>
            )}
          </div>
        );
      })}

      {library.length > 0 && (
        <div className="outliner-add">
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
