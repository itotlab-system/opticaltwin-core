import { useState } from "react";
import type { ProjectSummary, Template } from "../types";
import { useSettings } from "../settings";
import { colorFor } from "./typeColor";

export default function ProjectGallery({
  projects, templates, onOpen, onCreate, onDelete,
}: {
  projects: ProjectSummary[];
  templates: Template[];
  onOpen: (name: string) => void;
  onCreate: (name: string, template: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const { t } = useSettings();
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(templates[0]?.key ?? "blank");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    if (!name.trim()) { setErr(t("err_name")); return; }
    setBusy(true); setErr("");
    try {
      await onCreate(name.trim(), template);
      setShowNew(false); setName("");
    } catch (e: any) {
      setErr(e?.message?.includes("409") ? t("err_exists") : t("err_create"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gallery">
      <div className="gallery-head">
        <div>
          <h1>{t("gallery_title")}</h1>
          <p>{t("gallery_subtitle")}</p>
        </div>
        <button className="primary big" onClick={() => setShowNew((s) => !s)}>
          {showNew ? t("cancel") : t("new_project")}
        </button>
      </div>

      {showNew && (
        <div className="newform">
          <input
            autoFocus placeholder={t("name_placeholder")}
            value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            {templates.map((tp) => (
              <option key={tp.key} value={tp.key}>{t(`tpl_${tp.key}`) || tp.label}</option>
            ))}
          </select>
          <button className="primary" disabled={busy} onClick={submit}>
            {busy ? t("creating") : t("create")}
          </button>
          {err && <span className="err">{err}</span>}
        </div>
      )}

      <div className="cards">
        {projects.map((p) => (
          <div key={p.name} className="card" onClick={() => onOpen(p.name)}>
            <div className="card-top">
              <span className="card-name">{p.name}</span>
              <button
                className="card-del" title="delete project"
                onClick={(e) => { e.stopPropagation(); onDelete(p.name); }}
              >&times;</button>
            </div>
            <div className="swatches">
              {p.types.length === 0 && <span className="muted">{t("empty_bench")}</span>}
              {p.types.map((ty, i) => (
                <span key={i} className="chip" style={{ background: colorFor(ty) }} title={ty} />
              ))}
            </div>
            <div className="card-foot">{t("components_n", { n: p.components })}</div>
          </div>
        ))}
        {projects.length === 0 && (
          <div className="muted" style={{ padding: 20 }}>{t("no_projects")}</div>
        )}
      </div>
    </div>
  );
}
