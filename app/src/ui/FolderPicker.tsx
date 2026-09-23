/**
 * "Move to folder…" — the small dialog behind a card's menu.
 *
 * A folder here is just a label a project carries (see PROJECT_META_FILE in
 * server.py), so there is nothing to create ahead of time: a folder exists
 * because some project is in it, and it disappears when the last one leaves.
 * The dialog therefore offers the labels already in use plus a box to type a
 * new one — no separate "manage folders" screen to keep in sync.
 *
 * The existing labels are listed rather than only typed because the whole
 * point is that "2027年度" on two cards is the *same* folder; retyping it by
 * hand invites "2027年度 " and a second, near-identical section.
 */
import { useEffect, useRef, useState } from "react";
import { useSettings } from "../settings";

export default function FolderPicker({
  project,
  current,
  folders,
  onPick,
  onClose,
}: {
  project: string;
  /** The folder this project is in now, "" when unfiled. */
  current: string;
  /** Every folder label in use across the gallery, sorted. */
  folders: string[];
  /** "" moves the project out of every folder. */
  onPick: (folder: string) => void;
  onClose: () => void;
}) {
  const { t } = useSettings();
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  function submit() {
    const next = draft.trim();
    if (!next) return;
    onPick(next);
  }

  return (
    // The backdrop closes on click; the panel stops clicks so a click inside
    // does not fall through to it — or to the card underneath, which would
    // open the project.
    <div className="modal-back" onClick={onClose}>
      <div
        className="folder-pick" ref={box} role="dialog" aria-modal="true"
        aria-label={t("folder_move_title", { name: project })}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{t("folder_move_title", { name: project })}</h2>

        <div className="folder-list">
          <button
            className={current ? "folder-opt" : "folder-opt on"}
            onClick={() => onPick("")}
          >
            {t("folder_none")}
          </button>
          {folders.map((f) => (
            <button
              key={f}
              className={f === current ? "folder-opt on" : "folder-opt"}
              onClick={() => onPick(f)}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="folder-new">
          <input
            autoFocus
            placeholder={t("folder_new_placeholder")}
            value={draft}
            maxLength={60}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button className="primary" disabled={!draft.trim()} onClick={submit}>
            {t("folder_move")}
          </button>
        </div>
      </div>
    </div>
  );
}
