// Who is editing. The login is one shared password, so the server cannot tell
// lab members apart on its own: each browser is asked for a name once, keeps
// it here, and sends it on every edit as X-OT-Editor. The server tallies it
// per project per day in activity.json (see EDITOR_HEADER in server.py).
//
// Percent-encoded because a header value can only carry Latin-1, and names
// are routinely Japanese; the server unquotes it.

const KEY = "ot.editorName";

/** Mirrors EDITOR_MAX_LEN in server.py, which caps what it records. */
export const EDITOR_NAME_MAX = 40;

export const readEditorName = () => (localStorage.getItem(KEY) ?? "").trim();

export function writeEditorName(name: string) {
  localStorage.setItem(KEY, name.trim().slice(0, EDITOR_NAME_MAX));
}

export function editorHeaders(): Record<string, string> {
  const name = readEditorName();
  return name ? { "X-OT-Editor": encodeURIComponent(name) } : {};
}
