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

// The background is chosen **per project**: one bench is photographed against
// black anodized mounts, the next is all silver, and a single global choice
// meant picking a background for one project changed every other one.
const bgKey = (project: string | null) =>
  project ? `ot.viewportBg:${project}` : "ot.viewportBg";

function readBg(project: string | null): ViewportBg {
  const own = localStorage.getItem(bgKey(project)) as ViewportBg | null;
  if (own) return own;
  // A project with no choice of its own starts from the legacy global value
  // (nothing writes it any more), so an existing user's setting still applies.
  return (localStorage.getItem("ot.viewportBg") as ViewportBg) || "auto";
}

// The choice is keyed by project name, so rename/duplicate/delete have to
// carry it across (or drop it) — otherwise a renamed bench silently reverts.
export function moveViewportBg(
  from: string,
  to: string | null,
  keepSource = false
) {
  const chosen = localStorage.getItem(bgKey(from));
  if (chosen && to) localStorage.setItem(bgKey(to), chosen);
  if (!keepSource) localStorage.removeItem(bgKey(from));
}

interface Settings {
  theme: Theme;
  lang: Lang;
  viewportBg: ViewportBg;                     // the raw choice, incl. "auto"
  resolvedBg: Exclude<ViewportBg, "auto">;    // what the canvas actually shows
  bgColor: string;                            // …as a hex colour
  setViewportBg: (bg: ViewportBg) => void;
  setBgProject: (project: string | null) => void;  // which project's choice is live
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
  const [bgProject, setBgProject] = useState<string | null>(null);
  const [viewportBg, setViewportBgState] = useState<ViewportBg>(() => readBg(null));

  // Swap in the open project's own background when it changes.
  useEffect(() => setViewportBgState(readBg(bgProject)), [bgProject]);

  const setViewportBg = (bg: ViewportBg) => {
    setViewportBgState(bg);
    localStorage.setItem(bgKey(bgProject), bg);
  };
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ot.theme", theme);
  }, [theme]);
  useEffect(() => {
    // Not just for screen readers: the browser picks its font and its
    // line-breaking rules from this, and `:lang()` in theme.css keys off it.
    document.documentElement.lang = lang;
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
    setBgProject,
    t: (key, vars) => translate(lang, key, vars),
    toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    toggleLang: () => setLang((l) => (l === "en" ? "ja" : "en")),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSettings = () => useContext(Ctx);
