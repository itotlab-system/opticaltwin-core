// Toolbar glyphs. Inline SVG so they inherit the button's colour
// (currentColor) and need no asset request.

/** Camera glyph for the snapshot button. */
export function CameraIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 8.5h3.2l1.5-2.2h8.6l1.5 2.2H21a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.5" r="3.4" />
    </svg>
  );
}

/** Show/hide for the figure-label layer; struck through when it is hidden. */
export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.8-6 10-6 10 6 10 6-3.8 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 20 20 4" />}
    </svg>
  );
}
