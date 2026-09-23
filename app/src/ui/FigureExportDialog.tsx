/**
 * The export sheet behind the camera button: what the figure file should be.
 *
 * The three choices are the ones a paper actually forces. Resolution, because a
 * journal wants the figure at print density, not at whatever the laptop's
 * screen happens to be. Background, because the page is white and the editor is
 * not. Format, because PNG is what goes into a slide, PDF is what a journal or a
 * print shop takes as-is, and SVG is what a co-author edits.
 */
import { useState } from "react";
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
  const [settings, setSettings] = useState(initial);
  const set = <K extends keyof FigureExportSettings>(
    key: K, value: FigureExportSettings[K],
  ) => setSettings((s) => ({ ...s, [key]: value }));

  return (
    <div className="figure-export-overlay" onMouseDown={onClose}>
      <div className="figure-export-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="figure-export-title">図として書き出し</div>

        <label className="figure-export-row">
          <span>形式</span>
          <select
            value={settings.format}
            onChange={(e) => set("format", e.target.value as FigureFormat)}
          >
            <option value="png">PNG（画像）</option>
            <option value="pdf">PDF（論文・印刷用）</option>
            <option value="svg">SVG（ラベルは編集可能な文字）</option>
          </select>
        </label>

        <label className="figure-export-row">
          <span>解像度</span>
          <select
            value={settings.scale}
            onChange={(e) => set("scale", Number(e.target.value))}
          >
            <option value={1}>画面と同じ（1×）</option>
            <option value={2}>2×</option>
            <option value={3}>3×</option>
            <option value={4}>4×（印刷用）</option>
          </select>
        </label>

        <label className="figure-export-row">
          <span>背景</span>
          <select
            value={settings.background}
            onChange={(e) => set("background", e.target.value as FigureBackground)}
          >
            <option value="current">ビューポートの色</option>
            <option value="white">白</option>
            <option value="transparent">透過</option>
          </select>
        </label>

        <label className="figure-export-check">
          <input
            type="checkbox"
            checked={settings.hidePins}
            onChange={(e) => set("hidePins", e.target.checked)}
          />
          <span>議論用ピンを隠す</span>
        </label>

        <div className="figure-export-hint">
          図注のラベルはそのまま書き出されます。ラベルは箱をドラッグで移動、
          ダブルクリックで文字を編集できます。
          {settings.format === "pdf" && (
            <> PDF は1ページの可逆圧縮画像として埋め込まれ、用紙サイズはビューポートの
            実寸（96 dpi 換算）です。解像度を上げるほど印刷密度が上がります
            （4× で約 384 dpi）。文字を後から編集したいときは SVG を選んでください。</>
          )}
        </div>

        <div className="figure-export-actions">
          <button type="button" onClick={onClose}>キャンセル</button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onExport(settings)}
          >
            {busy ? "書き出し中…" : "書き出す"}
          </button>
        </div>
      </div>
    </div>
  );
}
