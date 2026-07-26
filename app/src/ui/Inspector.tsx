import type { ReactNode } from "react";
import type { BeamNode, Component } from "../types";
import { useSettings } from "../settings";
import { colorFor } from "./typeColor";

const AXES: Array<{ k: keyof Component; tkey: string; step: number }> = [
  { k: "x", tkey: "field_x", step: 25 },
  { k: "y", tkey: "field_y", step: 25 },
  { k: "z", tkey: "field_z", step: 5 },
  { k: "rotZ", tkey: "field_rotz", step: 15 },
];

const nodeRef = (n: BeamNode) => (typeof n === "string" ? n : n.ref);
const nodePin = (n: BeamNode) => (typeof n === "string" ? undefined : n.pin);
const oneDecimal = (value: number) => Math.round(value * 10) / 10;

export default function Inspector({
  component, prev, onEdit, onDelete, beamPath, onPinBeamNode, footer,
}: {
  component: Component | null;
  prev: Component | null;
  onEdit: (field: "x" | "y" | "z" | "rotZ", value: number) => void;
  onDelete: () => void;
  beamPath: BeamNode[][];
  onPinBeamNode: (segment: number, node: number, position: [number, number, number] | null) => void;
  footer?: ReactNode;
}) {
  const { t } = useSettings();
  if (!component) {
    return (
      <div className="inspector">
        <div className="section-title">{t("inspector_title")}</div>
        <div className="empty">{t("inspector_select")}</div>
        {footer}
      </div>
    );
  }

  // Find all beam nodes that reference this component (segment, nodeIndex, isPinned)
  const beamNodes: { seg: number; idx: number; pinned: boolean }[] = [];
  beamPath.forEach((seg, si) =>
    seg.forEach((n, ni) => {
      if (nodeRef(n) === component.name)
        beamNodes.push({ seg: si, idx: ni, pinned: !!nodePin(n) });
    })
  );

  const dist =
    prev &&
    Math.hypot(component.x - prev.x, component.y - prev.y, component.z - prev.z);

  return (
    <div className="inspector">
      <div className="insp-head">
        <div className="nm">{component.name}</div>
        <div className="insp-type-row">
          <span className="type-chip" style={{ background: colorFor(component.type) }} />
          <span className="ty">{component.type}</span>
        </div>
      </div>
      <div className="fieldgrid">
        {AXES.map(({ k, tkey, step }) => (
          <div className="field" key={k}>
            <label>{t(tkey)}</label>
            <input
              type="number"
              step={0.1}
              value={oneDecimal(component[k] as number)}
              onChange={(e) => {
                const value = parseFloat(e.target.value);
                onEdit(
                  k as "x" | "y" | "z" | "rotZ",
                  oneDecimal(isNaN(value) ? 0 : value),
                );
              }}
            />
          </div>
        ))}
      </div>
      {dist != null && (
        <div className="dist">{t("distance", { d: dist.toFixed(1), name: prev!.name })}</div>
      )}

      {/* Beam node pin controls — shown only when this component is in the beam path */}
      {beamNodes.length > 0 && (
        <>
          <div className="section-title">Beam nodes</div>
          <div className="props">
            {beamNodes.map(({ seg, idx, pinned }) => (
              <div className="prop" key={`${seg}-${idx}`}>
                <span className="k">seg {seg + 1} · node {idx + 1}</span>
                <button
                  className={pinned ? "primary" : "ghost"}
                  style={{ fontSize: 11, padding: "3px 9px" }}
                  title={pinned ? "Unpin — beam follows component when moved" : "Pin — lock beam vertex here"}
                  onClick={() =>
                    onPinBeamNode(seg, idx, pinned ? null : [component.x, component.y, component.z])
                  }
                >
                  {pinned ? "📌 Pinned" : "Pin"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">{t("properties")}</div>
      <div className="props">
        {Object.entries(component.attrs).map(([k, v]) => (
          <div className="prop" key={k}>
            <span className="k">{k}</span>
            <span className="v">
              {typeof v === "number" ? Number(v.toFixed(2)) : String(v)}
            </span>
          </div>
        ))}
      </div>
      <div className="row-actions">
        <button className="danger" onClick={onDelete}>
          {t("remove_component")}
        </button>
        <span className="key-hint">Del</span>
      </div>
      {footer}
    </div>
  );
}
