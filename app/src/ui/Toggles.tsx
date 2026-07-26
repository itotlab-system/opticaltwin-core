import { useSettings } from "../settings";

// Theme (dark/light) + language (EN/日本語) switches for the toolbar.
export default function Toggles() {
  const { theme, lang, toggleTheme, toggleLang } = useSettings();
  return (
    <>
      <button className="ghost toggle" onClick={toggleLang} title="Language / 言語">
        {lang === "en" ? "日本語" : "EN"}
      </button>
      <button className="ghost toggle" onClick={toggleTheme} title="Theme / テーマ">
        {theme === "dark" ? "☀ Light" : "☾ Dark"}
      </button>
    </>
  );
}
