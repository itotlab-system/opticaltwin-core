// Filename + download helpers for the viewport "Snapshot" button (issue #92).

const UNSAFE_FILENAME_CHARS = /[/\\:*?"<>|]/g;

export function sanitizeProjectName(name: string): string {
  return name.trim().replace(/\s+/g, "_").replace(UNSAFE_FILENAME_CHARS, "_");
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatTimestamp(d: Date): string {
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
  return `${date}_${time}`;
}

export function buildSnapshotFilename(projectName: string, d: Date = new Date()): string {
  return `${sanitizeProjectName(projectName)}-${formatTimestamp(d)}.png`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
