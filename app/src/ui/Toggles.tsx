import { useState } from "react";
import { useSettings } from "../settings";
import EditorNamePrompt from "./EditorNamePrompt";
import ToolbarPopover from "./ToolbarPopover";
import { ChevronIcon } from "./icons";
import type { ViewportBg } from "../settings";

// The three canvas backgrounds, in order from darkest to lightest.
const BACKGROUNDS: Exclude<ViewportBg, "auto">[] = ["dark", "gray", "light"];

// The right end of the toolbar: the viewport background swatches, and one
// settings chip holding who you are, the language and the theme.
//
// Language and theme used to be two more text buttons in the row; with the
// rest of the toolbar they pushed it onto two lines on a 13" laptop (worse in
// Japanese). They are set once and rarely touched, so they sit behind the name
// chip now. The chip itself stays visible: who edits are recorded as should be
// seen before editing, not looked up.
//
// `showBg` is off in the project gallery: the background belongs to a bench,
// so there is nothing for the swatches to apply to until one is open.
export default function Toggles({ showBg = true }: { showBg?: boolean }) {
  const {
    theme, lang, toggleTheme, toggleLang, resolvedBg, setViewportBg, t,
    editorName,
  } = useSettings();
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      {showBg && (
        <div className="bg-toggle" role="group" aria-label={t("viewport_bg")}>
          {BACKGROUNDS.map((bg) => (
            <button
              key={bg}
              type="button"
              className={`bg-swatch bg-${bg}${resolvedBg === bg ? " active" : ""}`}
              aria-pressed={resolvedBg === bg}
              aria-label={t(`viewport_bg_${bg}`)}
              title={`${t("viewport_bg")} — ${t(`viewport_bg_${bg}`)}`}
              onClick={() => setViewportBg(bg)}
            />
          ))}
        </div>
      )}

      <ToolbarPopover
        triggerClassName="ghost toggle settings-chip"
        label={editorName ? `${editorName} — ${t("settings")}` : t("settings")}
        triggerContent={
          <>
            <span className="editor-chip">{editorName || t("settings")}</span>
            <ChevronIcon />
          </>
        }
        popClassName="settings-pop"
      >
        {(close) => (
          <>
            {editorName && (
              <div className="settings-row">
                <span className="settings-k">{t("editing_as")}</span>
                <div className="settings-name">
                  <span className="settings-name-v">{editorName}</span>
                  <button
                    type="button"
                    className="ghost settings-rename"
                    title={t("editor_name_change")}
                    onClick={() => { close(); setRenaming(true); }}
                  >
                    {t("change")}
                  </button>
                </div>
              </div>
            )}
            <div className="settings-row">
              <span className="settings-k" id="settings-lang">{t("language")}</span>
              <div className="seg-toggle" role="group" aria-labelledby="settings-lang">
                <button
                  type="button" lang="en"
                  className={lang === "en" ? "active" : ""}
                  aria-pressed={lang === "en"}
                  onClick={() => { if (lang !== "en") toggleLang(); }}
                >
                  English
                </button>
                <button
                  type="button" lang="ja"
                  className={lang === "ja" ? "active" : ""}
                  aria-pressed={lang === "ja"}
                  onClick={() => { if (lang !== "ja") toggleLang(); }}
                >
                  日本語
                </button>
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-k" id="settings-theme">{t("theme")}</span>
              <div className="seg-toggle" role="group" aria-labelledby="settings-theme">
                <button
                  type="button"
                  className={theme === "dark" ? "active" : ""}
                  aria-pressed={theme === "dark"}
                  onClick={() => { if (theme !== "dark") toggleTheme(); }}
                >
                  {t("theme_dark")}
                </button>
                <button
                  type="button"
                  className={theme === "light" ? "active" : ""}
                  aria-pressed={theme === "light"}
                  onClick={() => { if (theme !== "light") toggleTheme(); }}
                >
                  {t("theme_light")}
                </button>
              </div>
            </div>
          </>
        )}
      </ToolbarPopover>
      {renaming && <EditorNamePrompt onClose={() => setRenaming(false)} />}
    </>
  );
}
