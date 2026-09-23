import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary, Template } from "../types";
import { useSettings } from "../settings";
import { colorFor } from "./typeColor";
import { cachedBenchThumb, pruneBenchThumbs, useBenchThumbnails } from "./benchThumbs";
import { boardLabel, editedLabel } from "./relativeTime";
import CardMenu from "./CardMenu";
import FolderPicker from "./FolderPicker";

// Which folder tab was open last. The gallery unmounts whenever a project is
// opened, so without this every trip back to the list lands on "All" — and a
// lab that works inside one year's folder would re-pick it all day.
const TAB_KEY = "ot.galleryFolder";

export default function ProjectGallery({
  projects, templates, onOpen, onCreate, onDelete, onDuplicate, onRename, onFile,
}: {
  projects: ProjectSummary[];
  templates: Template[];
  onOpen: (name: string) => void;
  /** `folder` files the new project on creation; "" leaves it unfiled. */
  onCreate: (name: string, template: string, folder: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onDuplicate: (name: string) => Promise<void>;
  onRename: (name: string, newName: string) => Promise<void>;
  /** File a project: move it between folders, archive it, restore it. */
  onFile: (name: string, meta: { folder?: string; archived?: boolean }) => Promise<void>;
}) {
  const { t, lang } = useSettings();
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(templates[0]?.key ?? "blank");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Name of the project currently being copied — its card shows "Duplicating…"
  // and both card buttons are disabled until the copy lands.
  const [copying, setCopying] = useState<string | null>(null);
  // The card being renamed in place, and the text typed into it so far.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // The card whose "move to folder" dialog is open, if any.
  const [filing, setFiling] = useState<ProjectSummary | null>(null);
  // Selected folder tab: "" is every folder at once.
  const [tab, setTab] = useState(() => localStorage.getItem(TAB_KEY) ?? "");
  const [archiveOpen, setArchiveOpen] = useState(false);

  // A picture of each bench, drawn once per project revision by a single
  // offscreen canvas. Every card is "visible" — a gallery is a short list, and
  // sorting the queue by scroll position would cost more than it saves.
  const names = useMemo(() => projects.map((p) => p.name), [projects]);
  const { forge } = useBenchThumbnails(projects, names);

  // Deleted and renamed projects leave their picture behind in localStorage.
  useEffect(() => { pruneBenchThumbs(names); }, [names]);

  // Every folder label in use. Archived projects count: their folder must stay
  // on the tab strip, or a folder emptied by archiving takes its own tab away
  // while you are standing in it.
  const folders = useMemo(() => {
    const seen = new Set<string>();
    for (const p of projects) if (p.folder) seen.add(p.folder);
    return [...seen].sort((a, b) => a.localeCompare(b, lang === "ja" ? "ja" : "en"));
  }, [projects, lang]);

  // A folder that no longer exists (its last project was moved out or deleted)
  // must not leave the gallery filtered to nothing with no way back.
  useEffect(() => {
    if (tab && !folders.includes(tab)) setTab("");
  }, [folders, tab]);

  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);

  const inTab = useMemo(
    () => projects.filter((p) => !tab || p.folder === tab),
    [projects, tab]
  );
  const live = useMemo(() => inTab.filter((p) => !p.archived), [inTab]);
  const archived = useMemo(() => inTab.filter((p) => p.archived), [inTab]);

  // In the "all folders" tab the live cards are grouped under their folder,
  // with the unfiled ones last — that section is the pile you haven't sorted
  // yet, and it belongs at the bottom. Inside a single folder's tab there is
  // nothing to group by, so it stays one flat grid.
  const sections = useMemo(() => {
    if (tab) return [{ key: tab, label: "", items: live }];
    const byFolder = new Map<string, ProjectSummary[]>();
    for (const p of live) {
      const key = p.folder || "";
      const list = byFolder.get(key);
      if (list) list.push(p); else byFolder.set(key, [p]);
    }
    const filed = [...byFolder.entries()]
      .filter(([key]) => key)
      .sort((a, b) => a[0].localeCompare(b[0], lang === "ja" ? "ja" : "en"))
      .map(([key, items]) => ({ key, label: key, items }));
    const loose = byFolder.get("") ?? [];
    // Sections only earn a heading once there is more than one of them —
    // a lab that files nothing should see exactly the gallery it has today.
    if (!filed.length) return [{ key: "", label: "", items: loose }];
    return loose.length
      ? [...filed, { key: "__loose", label: t("folder_unfiled"), items: loose }]
      : filed;
  }, [live, tab, lang, t]);

  // The tab strip and the archive drawer are both hidden until the lab
  // actually uses them, so nothing new appears for a gallery of five
  // unsorted projects.
  const showTabs = folders.length > 0;

  async function duplicate(project: string) {
    setCopying(project); setErr("");
    try {
      await onDuplicate(project);
    } catch {
      setErr(t("err_duplicate"));
    } finally {
      setCopying(null);
    }
  }

  async function file(project: string, meta: { folder?: string; archived?: boolean }) {
    setErr("");
    try {
      await onFile(project, meta);
    } catch {
      setErr(t("err_file"));
    }
  }

  function startRename(project: string) {
    setErr("");
    setRenaming(project);
    setDraft(project);
  }

  async function commitRename(project: string) {
    const next = draft.trim();
    setRenaming(null);
    if (!next || next === project) return;
    try {
      await onRename(project, next);
    } catch (e: any) {
      setErr(e?.message?.includes("409") ? t("err_exists") : t("err_rename"));
    }
  }

  async function submit() {
    if (!name.trim()) { setErr(t("err_name")); return; }
    setBusy(true); setErr("");
    try {
      // A project created while a folder tab is open belongs in that folder —
      // that is what "I am working in 2027年度" means. Filing it afterwards
      // from the card menu would be busywork every single time.
      await onCreate(name.trim(), template, tab);
      setShowNew(false); setName("");
    } catch (e: any) {
      setErr(e?.message?.includes("409") ? t("err_exists") : t("err_create"));
    } finally {
      setBusy(false);
    }
  }

  function card(p: ProjectSummary) {
    return (
      // A div rather than a <button>: the card holds its own controls, and
      // a button inside a button is invalid. It carries the button role and
      // keys by hand so it is still reachable without a mouse.
      <div
        key={p.name} className={p.archived ? "card archived" : "card"}
        role="button" tabIndex={0}
        aria-label={p.name}
        onClick={() => renaming !== p.name && onOpen(p.name)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;   // a control inside it
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();                          // Space scrolls
          if (renaming !== p.name) onOpen(p.name);
        }}
      >
        <div className="card-thumb">
          {cachedBenchThumb(p) ? (
            <img src={cachedBenchThumb(p)} alt="" draggable={false} />
          ) : (
            <span className="card-thumb-wait muted">
              {p.components === 0 ? t("empty_bench") : t("thumb_drawing")}
            </span>
          )}
        </div>
        <div className="card-top">
          {renaming === p.name ? (
            <input
              autoFocus className="card-rename" value={draft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitRename(p.name)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename(p.name);
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <span
              className="card-name"
              onDoubleClick={(e) => { e.stopPropagation(); startRename(p.name); }}
            >{p.name}</span>
          )}
          <CardMenu
            label={t("card_actions", { name: p.name })}
            disabled={copying === p.name || renaming === p.name}
            actions={[
              {
                key: "rename",
                label: t("menu_rename"),
                onSelect: () => startRename(p.name),
              },
              {
                key: "duplicate",
                label: t("menu_duplicate"),
                onSelect: () => void duplicate(p.name),
              },
              {
                key: "folder",
                label: t("menu_move_folder"),
                onSelect: () => setFiling(p),
              },
              {
                key: "archive",
                label: p.archived ? t("menu_unarchive") : t("menu_archive"),
                onSelect: () => void file(p.name, { archived: !p.archived }),
              },
              {
                key: "delete",
                label: t("menu_delete"),
                danger: true,
                // deleteProject confirms before it removes anything, so the
                // thumbnail is not dropped here — pruneBenchThumbs clears it
                // once the project is actually gone from the list.
                onSelect: () => void onDelete(p.name),
              },
            ]}
          />
        </div>
        {/* The type colours stay as a thin strip: the picture says what the
            bench looks like, the strip still says what is on it. */}
        <div className="swatches">
          {p.types.map((ty, i) => (
            <span key={i} className="chip" style={{ background: colorFor(ty) }} title={ty} />
          ))}
        </div>
        {/* What a card can say that the picture cannot: when this bench was
            last touched, and which board it is. The part count is gone —
            "47 parts" is mostly posts and holders, and said nothing about
            the setup that the render doesn't say better. */}
        <div className="card-foot">
          {copying === p.name ? (
            t("duplicating")
          ) : (
            <>
              <span>{editedLabel(p.modified, t, lang)}</span>
              <span className="card-board">
                {boardLabel(p.boardSizeX, p.boardSizeY)}
              </span>
            </>
          )}
        </div>
      </div>
    );
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

      {err && !showNew && <div className="err">{err}</div>}

      {showTabs && (
        <div className="folder-tabs" role="tablist" aria-label={t("folder_tabs")}>
          <button
            role="tab" aria-selected={!tab}
            className={tab ? "folder-tab" : "folder-tab on"}
            onClick={() => setTab("")}
          >
            {t("folder_all")}
          </button>
          {folders.map((f) => (
            <button
              key={f} role="tab" aria-selected={f === tab}
              className={f === tab ? "folder-tab on" : "folder-tab"}
              onClick={() => setTab(f)}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      {sections.map((s) => (
        <section key={s.key} className="folder-section">
          {s.label && <h2 className="folder-head">{s.label}</h2>}
          <div className="cards">{s.items.map(card)}</div>
        </section>
      ))}

      {live.length === 0 && (
        <div className="muted" style={{ padding: 20 }}>
          {projects.length === 0 ? t("no_projects") : t("folder_empty")}
        </div>
      )}

      {archived.length > 0 && (
        <section className="archive-drawer">
          <button
            className="archive-toggle"
            aria-expanded={archiveOpen}
            onClick={() => setArchiveOpen((o) => !o)}
          >
            {archiveOpen ? "▾" : "▸"} {t("archive_n", { n: archived.length })}
          </button>
          {archiveOpen && <div className="cards">{archived.map(card)}</div>}
        </section>
      )}

      {filing && (
        <FolderPicker
          project={filing.name}
          current={filing.folder ?? ""}
          folders={folders}
          onClose={() => setFiling(null)}
          onPick={(folder) => {
            const target = filing.name;
            setFiling(null);
            // Land on the folder the project just went into, so the card is
            // still on screen afterwards rather than filed out of view.
            if (folder && tab && folder !== tab) setTab(folder);
            void file(target, { folder });
          }}
        />
      )}
      {forge}
    </div>
  );
}
