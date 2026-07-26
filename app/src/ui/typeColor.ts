// Swatch colors per component type (matches the USD displayColors loosely).
export const TYPE_COLOR: Record<string, string> = {
  laser: "#33cc44",
  polarizer: "#6a5acd",
  lens: "#66b3ff",
  cylindrical_lens: "#7fd0e6",
  beamsplitter: "#9fcfe0",
  slm: "#e04b4b",
  iris: "#e6d23a",
  eyepiece: "#888a90",
  camera: "#cfd2d6",
  mirror: "#d8d8e0",
  detector: "#9aa0a8",
};
export const colorFor = (t: string) => TYPE_COLOR[t] ?? "#9aa0a8";
