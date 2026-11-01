/**
 * "What should we call you?" — asked once per browser, then remembered.
 *
 * The name is recorded against every edit (activity.json on the server), which
 * is how the lab counts who actually uses the tool and answers "who moved my
 * mirror?". There is no account behind it: the login stays one shared
 * password, and this is the only thing a member types beyond it.
 *
 * `required` is the first visit, when there is no name yet. It cannot be
 * dismissed then — an edit made before it would be recorded as nobody — but
 * it can later be reopened from the toolbar to change the name, and closed.
 */
import { useEffect, useState } from "react";
import { useSettings } from "../settings";
import { EDITOR_NAME_MAX } from "../editorName";

export default function EditorNamePrompt({
  required = false,
  onClose,
}: {
  required?: boolean;
  onClose?: () => void;
}) {
  const { t, editorName, setEditorName } = useSettings();
  const [draft, setDraft] = useState(editorName);

  useEffect(() => {
    if (required) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose?.();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [required, onClose]);

  function submit() {
    if (!draft.trim()) return;
    setEditorName(draft);
    onClose?.();
  }

  return (
    <div className="modal-back" onClick={required ? undefined : onClose}>
      <div
        className="folder-pick name-pick" role="dialog" aria-modal="true"
        aria-labelledby="editor-name-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="editor-name-title">{t("editor_name_title")}</h2>
        <p className="name-pick-note">{t("editor_name_note")}</p>
        <div className="folder-new">
          <input
            autoFocus
            aria-label={t("editor_name_title")}
            placeholder={t("editor_name_placeholder")}
            value={draft}
            maxLength={EDITOR_NAME_MAX}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button className="primary" disabled={!draft.trim()} onClick={submit}>
            {t("editor_name_save")}
          </button>
        </div>
      </div>
    </div>
  );
}
