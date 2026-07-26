import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Lang, translate } from "./i18n";

type Theme = "dark" | "light";

interface Settings {
  theme: Theme;
  lang: Lang;
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

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ot.theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("ot.lang", lang);
  }, [lang]);

  const value: Settings = {
    theme,
    lang,
    t: (key, vars) => translate(lang, key, vars),
    toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    toggleLang: () => setLang((l) => (l === "en" ? "ja" : "en")),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSettings = () => useContext(Ctx);
