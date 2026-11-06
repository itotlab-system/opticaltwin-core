// What Ctrl+C holds: component names *and* the project they were copied from,
// since a paste can land in a different project. Kept in localStorage
// so it also survives a reload or a second tab — the same place the browser's
// own clipboard would put it.
export type Clipboard = { project: string; names: string[] };

const CLIPBOARD_KEY = "ot.clipboard";

export function readClipboard(): Clipboard | null {
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    const c = raw ? JSON.parse(raw) : null;
    if (!c || typeof c.project !== "string" || !Array.isArray(c.names)) return null;
    const names = c.names.filter((n: unknown) => typeof n === "string");
    return names.length ? { project: c.project, names } : null;
  } catch {
    return null;                       // unreadable or from an older version
  }
}

export function writeClipboard(c: Clipboard) {
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(c));
  } catch {
    /* private mode / quota — the in-memory clipboard still works */
  }
}
