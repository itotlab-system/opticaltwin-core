/**
 * The export sheet behind the "Export figure" button: what the figure file should be.
 *
 * The three choices are the ones a paper actually forces. Resolution, because a
 * journal wants the figure at print density, not at whatever the laptop's
 * screen happens to be. Background, because the page is white and the editor is
 * not. Format, because PNG is what goes into a slide, PDF is what a journal or a
 * print shop takes as-is, and SVG is what a co-author edits.
 */
import { useEffect, useRef, useState } from "react";
import { useSettings } from "../settings";
import type { FigureBackground, FigureFormat } from "../figureExport";

export interface FigureExportSettings {
  format: FigureFormat;
  scale: number;
  background: FigureBackground;
  hidePins: boolean;
}

export const DEFAULT_FIGURE_SETTINGS: FigureExportSettings = {
  format: "png",
  scale: 2,
  background: "current",
  hidePins: true,
};

export default function FigureExportDialog({
  initial,
  busy,
  onExport,
  onClose,
}: {
  initial: FigureExportSettings;
  busy: boolean;
  onExport: (settings: FigureExportSettings) => void;
  onClose: () => void;
}) {
  const { t } = useSettings();
  const [settings, setSettings] = useState(initial);
  const dialog = useRef<HTMLDivElement>(null);
  // The parent passes a fresh closure each render; keep the latest without
  // re-running the effect, which would steal focus back to the first select.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Esc closes it, as every other sheet in the editor does; the keyboard
  // starts inside it, on the first choice.
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("select")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const set = <K extends keyof FigureExportSettings>(
    key: K, value: FigureExportSettings[K],
  ) => setSettings((s) => ({ ...s, [key]: value }));

  return (
    <div className="figure-export-overlay" onMouseDown={onClose}>
      <div
        ref={dialog}
        className="figure-export-dialog"
        role="dialog" aria-modal="true" aria-labelledby="fx-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="figure-export-title" id="fx-title">{t("fx_title")}</div>

        <label className="figure-export-row">
          <span>{t("fx_format")}</span>
          <select
            value={settings.format}
            onChange={(e) => set("format", e.target.value as FigureFormat)}
          >
            <option value="png">{t("fx_png")}</option>
            <option value="pdf">{t("fx_pdf")}</option>
            <option value="svg">{t("fx_svg")}</option>
          </select>
        </label>

        <label className="figure-export-row">
          <span>{t("fx_resolution")}</span>
          <select
            value={settings.scale}
            onChange={(e) => set("scale", Number(e.target.value))}
          >
            <option value={1}>{t("fx_scale_1")}</option>
            <option value={2}>2×</option>
            <option value={3}>3×</option>
            <option value={4}>{t("fx_scale_4")}</option>
          </select>
        </label>

        <label className="figure-export-row">
          <span>{t("fx_background")}</span>
          <select
            value={settings.background}
            onChange={(e) => set("background", e.target.value as FigureBackground)}
          >
            <option value="current">{t("fx_bg_current")}</option>
            <option value="white">{t("fx_bg_white")}</option>
            <option value="transparent">{t("fx_bg_transparent")}</option>
          </select>
        </label>

        <label className="figure-export-check">
          <input
            type="checkbox"
            checked={settings.hidePins}
            onChange={(e) => set("hidePins", e.target.checked)}
          />
          <span>{t("fx_hide_pins")}</span>
        </label>

        <div className="figure-export-hint">
          {t("fx_hint")}
          {settings.format === "pdf" && t("fx_hint_pdf")}
        </div>

        <div className="figure-export-actions">
          <button type="button" onClick={onClose}>{t("cancel")}</button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onExport(settings)}
          >
            {busy ? t("fx_exporting") : t("fx_export")}
          </button>
        </div>
      </div>
    </div>
  );
}
