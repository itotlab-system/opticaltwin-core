import { useSettings } from "../settings";
import type { ViewportBg } from "../settings";

// The three canvas backgrounds, in order from darkest to lightest (#156).
const BACKGROUNDS: Exclude<ViewportBg, "auto">[] = ["dark", "gray", "light"];

// Theme (dark/light) + language (EN/日本語) + viewport background switches
// for the toolbar.
export default function Toggles() {
  const {
    theme, lang, toggleTheme, toggleLang, resolvedBg, setViewportBg, t,
  } = useSettings();
  return (
    <>
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
      <button className="ghost toggle" onClick={toggleLang} title="Language / 言語">
        {lang === "en" ? "日本語" : "EN"}
      </button>
      <button className="ghost toggle" onClick={toggleTheme} title="Theme / テーマ">
        {theme === "dark" ? "☀ Light" : "☾ Dark"}
      </button>
    </>
  );
}
