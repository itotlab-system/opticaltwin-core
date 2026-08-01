import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Lang, translate } from "./i18n";

type Theme = "dark" | "light";

// The 3D viewport background, chosen independently of the UI theme.
// "auto" is the original behaviour: the canvas follows the theme.
export type ViewportBg = "auto" | "dark" | "gray" | "light";

// Mid gray is the CAD-standard neutral, and it's here for visibility rather
// than taste: black anodized mounts stay readable against it (they vanish on
// the near-black) and silver optics keep their highlights (they wash out on
// the near-white).
export const VIEWPORT_BG: Record<Exclude<ViewportBg, "auto">, string> = {
  dark: "#0c0e12",
  gray: "#5a6069",
  light: "#e7ebf1",
};

interface Settings {
  theme: Theme;
  lang: Lang;
  viewportBg: ViewportBg;                     // the raw choice, incl. "auto"
  resolvedBg: Exclude<ViewportBg, "auto">;    // what the canvas actually shows
  bgColor: string;                            // …as a hex colour
  setViewportBg: (bg: ViewportBg) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  toggleTheme: () => void;
  toggleLang: () => void;
}

const Ctx = createContext<Settings>(null!);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("ot.theme") as Theme) || "dark"
  );
  const [lang, setLang] = useState<Lang>(
    () => (localStorage.getItem("ot.lang") as Lang) || "en"
  );
  const [viewportBg, setViewportBg] = useState<ViewportBg>(
    () => (localStorage.getItem("ot.viewportBg") as ViewportBg) || "auto"
  );

  useEffect(() => {
    localStorage.setItem("ot.viewportBg", viewportBg);
  }, [viewportBg]);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ot.theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("ot.lang", lang);
  }, [lang]);

  const resolvedBg = viewportBg === "auto" ? theme : viewportBg;

  const value: Settings = {
    theme,
    lang,
    viewportBg,
    resolvedBg,
    bgColor: VIEWPORT_BG[resolvedBg],
    setViewportBg,
    t: (key, vars) => translate(lang, key, vars),
    toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    toggleLang: () => setLang((l) => (l === "en" ? "ja" : "en")),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSettings = () => useContext(Ctx);
