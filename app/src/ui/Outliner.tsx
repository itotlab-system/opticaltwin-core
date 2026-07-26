import type { Component } from "../types";
import { useSettings } from "../settings";
import { colorFor } from "./typeColor";

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
  components, selected, onSelect, library, asset, onAssetChange, onAdd, isPlacing,
}: {
  components: Component[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  library: string[];
  asset: string;
  onAssetChange: (a: string) => void;
  onAdd: () => void;
  isPlacing: boolean;
}) {
  const { t } = useSettings();
  const sorted = [...components].sort((a, b) => a.x - b.x);
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
      {sorted.map((c) => (
        <div
          key={c.name}
          className={"node" + (selected === c.name ? " sel" : "")}
          onClick={() => onSelect(c.name)}
        >
          <span className="swatch" style={{ background: colorFor(c.type) }} />
          <span className="nm">{c.name}</span>
          <span className="x-hint">{c.x >= 0 ? "+" : ""}{Math.round(c.x)}</span>
        </div>
      ))}
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
