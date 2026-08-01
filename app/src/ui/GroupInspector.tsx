import { useEffect, useState } from "react";
import type { Component, ComponentGroup, ComponentUpdate } from "../types";
import { useSettings } from "../settings";
import { groupPivot, rigidTransform } from "../groups";
import type { TransformDelta } from "../groups";
import { colorFor } from "./typeColor";

// Nudge steps mirror the single-component Inspector: 25 mm on the board,
// 5 mm in height, 15° of rotation.
const NUDGES: Array<{ key: keyof TransformDelta; tkey: string; step: number }> = [
  { key: "dx", tkey: "field_x", step: 25 },
  { key: "dy", tkey: "field_y", step: 25 },
  { key: "dz", tkey: "field_z", step: 5 },
  { key: "dRotX", tkey: "field_rotx", step: 15 },
  { key: "dRotY", tkey: "field_roty", step: 15 },
  { key: "dRotZ", tkey: "field_rotz", step: 15 },
];

const ZERO: TransformDelta = {
  dx: 0, dy: 0, dz: 0, dRotX: 0, dRotY: 0, dRotZ: 0,
};

/**
 * Inspector panel for a multi-selection. When the selection is exactly one
 * group it can be renamed and ungrouped; an ad-hoc selection is offered
 * grouping instead. Either way the nudge fields move every selected part
 * rigidly, rotating about the selection's centroid.
 */
export default function GroupInspector({
  group, selection, components, onNudge, onCreateGroup, onUngroup, onRename, onDelete,
  onDuplicate,
}: {
  group: ComponentGroup | null;
  selection: string[];
  components: Component[];
  onNudge: (updates: ComponentUpdate[]) => void;
  onCreateGroup: () => void;
  onUngroup: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { t } = useSettings();
  const [name, setName] = useState(group?.name ?? "");

  // Follow the selection when the user picks a different group.
  useEffect(() => { setName(group?.name ?? ""); }, [group?.id, group?.name]);

  const members = components.filter((c) => selection.includes(c.name));
  const pivot = groupPivot(components, selection);

  const nudge = (key: keyof TransformDelta, amount: number) => {
    onNudge(rigidTransform(components, selection, { ...ZERO, [key]: amount }, pivot));
  };

  const commitName = () => {
    const trimmed = name.trim();
    if (group && trimmed && trimmed !== group.name) onRename(group.id, trimmed);
    else setName(group?.name ?? "");
  };

  return (
    <>
      <div className="insp-head">
        {group ? (
          <input
            className="group-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{ borderBottomColor: group.color ?? "var(--accent)" }}
            aria-label={t("group_name")}
          />
        ) : (
          <div className="nm">{t("group_adhoc")}</div>
        )}
        <div className="ty">{t("group_members_n", { n: selection.length })}</div>
      </div>

      <div className="section-title">{t("group_nudge")}</div>
      <div className="fieldgrid">
        {NUDGES.map(({ key, tkey, step }) => (
          <div className="field" key={key}>
            <label>{t(tkey)}</label>
            <div className="nudge-row">
              <button type="button" onClick={() => nudge(key, -step)}>−{step}</button>
              <button type="button" onClick={() => nudge(key, step)}>+{step}</button>
            </div>
          </div>
        ))}
      </div>
      <div className="dist">
        {t("group_pivot", {
          x: pivot.x.toFixed(1),
          y: pivot.y.toFixed(1),
          z: pivot.z.toFixed(1),
        })}
      </div>

      <div className="section-title">{t("group_members")}</div>
      <div className="props">
        {members.map((c) => (
          <div className="prop" key={c.name}>
            <span className="k">
              <span className="type-chip" style={{ background: colorFor(c.type) }} />
              {c.name}
            </span>
            <span className="v">{c.x >= 0 ? "+" : ""}{Math.round(c.x)} mm</span>
          </div>
        ))}
      </div>

      <div className="row-actions">
        {group ? (
          <button className="ghost" onClick={onUngroup}>{t("group_ungroup")}</button>
        ) : (
          <button className="primary" onClick={onCreateGroup}>{t("group_create")}</button>
        )}
        <span className="key-hint">{group ? "Ctrl+Shift+G" : "Ctrl+G"}</span>
      </div>
      <div className="row-actions">
        <button className="ghost" onClick={onDuplicate}>
          {t("duplicate_selection_n", { n: selection.length })}
        </button>
        <span className="key-hint">Ctrl+D</span>
      </div>
      <div className="row-actions">
        <button className="danger" onClick={onDelete}>
          {t("remove_selection_n", { n: selection.length })}
        </button>
        <span className="key-hint">Del</span>
      </div>
    </>
  );
}
