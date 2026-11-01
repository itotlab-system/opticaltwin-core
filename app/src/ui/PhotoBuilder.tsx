import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GenericRole, GenericSpec, PhotoBuildPart, PhotoLabels, PhotoPart, ProjectData,
} from "../types";
import { api } from "../api";
import { useSettings } from "../settings";
import { partCategory, partModel } from "./partLabels";
import PartBrowser from "./PartBrowser";
import {
  apply, assignCorners, buildDraft, calibrate, cornerIndex, holeAxes, placeOnDraft,
  snapToHole, squarePath,
} from "../photoCalib";
import type { CalibPoint, DraftTurn, Point } from "../photoCalib";

// Building a bench from a photo of it.
//
//   1. upload a photo (shrunk in the browser to ~2000 px before it is sent)
//   2. calibrate: click four holes -- by default the board's corners -- and
//      check the predicted hole grid lands on the real holes
//   3. mark each part at its FOOT (where it meets the board); drag instead of
//      clicking to also give its direction; say what it is -- a catalogue
//      part or a placeholder
//   4. build: the server places the laser, then each part in beam order, so
//      lenses take the beam's direction and mirrors fold it
//
// Everything marked is saved beside the layer (photo_labels.json) as you go,
// so the screen can be closed and reopened from the editor.

const MAX_PHOTO_PX = 2000;
const ROLES: GenericRole[] = ["laser", "lens", "mirror", "beamsplitter", "iris", "camera", "block"];
const FOLD_TYPES = new Set(["mirror", "beamsplitter"]);
// A placeholder's optics:type, by role (mirrors generic_parts.ROLES).
const ROLE_TYPE: Record<GenericRole, string> = {
  laser: "laser", lens: "lens", mirror: "mirror", beamsplitter: "beamsplitter",
  iris: "iris", camera: "camera", block: "target",
};
// A press that moves less than this (screen px) is a click: foot only.
const DRAG_PX = 10;

async function shrinkToJpeg(file: File): Promise<{ blob: Blob; w: number; h: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_PHOTO_PX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85));
  return { blob, w, h };
}

function newId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function partName(p: PhotoPart, t: (k: string) => string): string {
  if (p.asset) return partModel(p.asset);
  if (p.generic) return p.generic.label || `${t("photo_generic")}: ${t(`role_${p.generic.role}`)}`;
  return t("photo_unassigned");
}

export default function PhotoBuilder({
  project, data, renderMode, onClose, onBuilt, onBoardModel,
}: {
  project: string;
  data: ProjectData;
  renderMode: string;
  onClose: () => void;
  onBuilt: (payload: ProjectData) => void;
  onBoardModel: (asset: string) => Promise<void>;
}) {
  const { t } = useSettings();
  const [labels, setLabels] = useState<PhotoLabels | null>(null);
  const [tab, setTab] = useState<"calib" | "path" | "parts">("calib");
  // The beam path being drawn (index into labels.paths), and the cursor, for
  // the rubber-band leg that follows it.
  const [drawing, setDrawing] = useState<number | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The picture catalogue, open for this part id.
  const [browsing, setBrowsing] = useState<string | null>(null);
  // Which way round the clicked corners are: 0 = photo taken from the near
  // side (the usual), each step turns the board a quarter.
  const [turn, setTurn] = useState(0);
  // Marking hardware and other parts that are not in the beam.
  const [offBeamMode, setOffBeamMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [vb, setVb] = useState<[number, number, number, number] | null>(null);
  const [drag, setDrag] = useState<{ px: number; py: number; ex: number; ey: number; sx: number; sy: number } | null>(null);
  const [unit, setUnit] = useState(1);   // photo px per screen px
  const svgRef = useRef<SVGSVGElement>(null);
  const pan = useRef<{ x: number; y: number; vb: [number, number, number, number] } | null>(null);

  useEffect(() => {
    api.getPhotoLabels(project).then((l) => {
      setLabels(l);
      if ((l.calib?.length ?? 0) === 4) setTab((l.paths?.[0]?.length ?? 0) >= 2 ? "parts" : "path");
    });
  }, [project]);

  // Save what is marked as it changes; the build map is the server's own.
  useEffect(() => {
    if (!labels) return;
    const timer = window.setTimeout(() => {
      const { built: _built, ...rest } = labels;
      void api.savePhotoLabels(project, rest);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [labels, project]);

  useEffect(() => {
    if (labels?.imgW && labels.imgH && !vb) setVb([0, 0, labels.imgW, labels.imgH]);
  }, [labels, vb]);

  // How big a screen pixel is in photo pixels, so markers keep their size
  // on screen whatever the zoom.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !vb) return;
    const measure = () => {
      const r = svg.getBoundingClientRect();
      if (r.width && r.height) setUnit(Math.max(vb[2] / r.width, vb[3] / r.height));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, [vb]);

  const holes = data.board.holes ?? [];
  const axes = useMemo(() => holeAxes(holes), [holes]);
  const calib = labels?.calib ?? [];
  const maps = useMemo(() => calibrate(calib, axes), [calib, axes]);
  const parts = labels?.parts ?? [];
  const sel = parts.find((p) => p.id === selected) ?? null;

  const typeOf = (p: PhotoPart) => p.generic
    ? ROLE_TYPE[p.generic.role]
    : (p.asset ? data.libraryPreviews?.[p.asset]?.type ?? "" : "");
  // The drafted beam, in board millimetres, squared to the grid.
  const rawPaths = labels?.paths ?? [];
  const draft = useMemo(() => maps
    ? buildDraft(rawPaths.map((path) => path.map((q) => apply(maps.toBoard, q))))
    : null, [rawPaths, maps]);
  const hasPath = Boolean(draft && draft.segs.length > 0);
  // Where each marked part goes: onto the draft, or (off the beam / too far
  // from it) where it was marked.
  const placed = useMemo(() => {
    const m = new Map<string, { at: Point; out: Point; turn: DraftTurn | null }>();
    if (!maps || !draft) return m;
    for (const p of parts) {
      if (p.offBeam) continue;
      const hit = placeOnDraft(apply(maps.toBoard, [p.px, p.py]), typeOf(p), draft);
      if (hit) m.set(p.id, hit);
    }
    return m;
  }, [parts, maps, draft, data.libraryPreviews]);
  // Corners of the draft no marked mirror/splitter takes: filled in on build,
  // so the beam still follows the drawing.
  const autoTurns = useMemo(() => (draft?.turns ?? []).filter((turn) => !parts.some((p) => {
    const at = placed.get(p.id);
    return at?.turn === turn && FOLD_TYPES.has(typeOf(p));
  })), [draft, parts, placed]);
  const needsLaser = hasPath && !parts.some((p) => placed.has(p.id) && typeOf(p) === "laser");
  const beamHeight = labels?.beamHeight ?? 100;

  const update = (patch: Partial<PhotoLabels>) =>
    setLabels((l) => ({ ...(l ?? {}), ...patch }));
  const updatePart = (id: string, patch: Partial<PhotoPart>) =>
    update({ parts: parts.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

  // --- photo -----------------------------------------------------------------
  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true); setMessage("");
    try {
      const { blob, w, h } = await shrinkToJpeg(file);
      const r = await api.uploadPhoto(project, blob);
      setVb([0, 0, w, h]);
      update({ photo: r.file, imgW: w, imgH: h, calib: [], parts: [] });
      setTab("calib");
    } catch {
      setMessage(t("photo_upload_failed"));
    } finally {
      setBusy(false);
    }
  }

  // --- pointer ---------------------------------------------------------------
  function toPhoto(e: { clientX: number; clientY: number }): Point {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [p.x, p.y];
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (!vb) return;
    if (e.button === 1 || e.button === 2) {
      pan.current = { x: e.clientX, y: e.clientY, vb };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const [px, py] = toPhoto(e);
    if (tab === "calib") {
      if (calib.length >= 4) return;
      const next = [...calib, { px, py, col: 0, row: 0 }];
      // Any order: once all four are in, which corner is which follows from
      // where they sit in the photo.
      update({ calib: next.length === 4 ? assignCorners(next, axes, turn) : next });
      return;
    }
    if (tab === "path") {
      if (drawing === null) {
        update({ paths: [...rawPaths, [[px, py]]] });
        setDrawing(rawPaths.length);
      } else {
        const path = rawPaths[drawing] ?? [];
        const last = path[path.length - 1];
        // The second click of a double-click lands on the first: not a leg.
        if (last && Math.hypot(last[0] - px, last[1] - py) < 4 * unit) return;
        update({ paths: rawPaths.map((q, k) => (k === drawing ? [...q, [px, py]] : q)) });
      }
      return;
    }
    setDrag({ px, py, ex: px, ey: py, sx: e.clientX, sy: e.clientY });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (pan.current) {
      const svg = svgRef.current!;
      const r = svg.getBoundingClientRect();
      const s = Math.max(pan.current.vb[2] / r.width, pan.current.vb[3] / r.height);
      const [x, y, w, h] = pan.current.vb;
      setVb([x - (e.clientX - pan.current.x) * s, y - (e.clientY - pan.current.y) * s, w, h]);
      return;
    }
    if (tab === "path") { setHover(drawing === null ? null : toPhoto(e)); return; }
    if (!drag) return;
    const [ex, ey] = toPhoto(e);
    setDrag({ ...drag, ex, ey });
  }

  function finishPath() {
    // A one-point path is a stray click, not a beam.
    if (drawing !== null && (rawPaths[drawing]?.length ?? 0) < 2) {
      update({ paths: rawPaths.filter((_, k) => k !== drawing) });
    }
    setDrawing(null); setHover(null);
  }
  function undoPathPoint() {
    const k = drawing ?? rawPaths.length - 1;
    if (k < 0) return;
    const path = rawPaths[k];
    if (path.length <= 1) {
      update({ paths: rawPaths.filter((_, i) => i !== k) });
      setDrawing(null);
    } else {
      update({ paths: rawPaths.map((q, i) => (i === k ? q.slice(0, -1) : q)) });
      setDrawing(k);
    }
  }
  useEffect(() => {
    if (tab !== "path") return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") finishPath();
      if (e.key === "Backspace") undoPathPoint();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (pan.current) { pan.current = null; return; }
    if (!drag) return;
    const moved = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) >= DRAG_PX;
    const part: PhotoPart = {
      id: newId(), px: drag.px, py: drag.py,
      ...(moved ? { ex: drag.ex, ey: drag.ey } : {}),
      ...(offBeamMode ? { offBeam: true } : {}),
    };
    setDrag(null);
    update({ parts: [...parts, part] });
    setSelected(part.id);
    // Straight to the pictures: a part is recognised by how it looks, not by
    // its model number.
    setBrowsing(part.id);
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    if (!vb) return;
    const [mx, my] = toPhoto(e);
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const [x, y, w, h] = vb;
    const nw = Math.min(Math.max(w * k, 80), (labels?.imgW ?? w) * 2);
    const f = nw / w;
    setVb([mx - (mx - x) * f, my - (my - y) * f, w * f, h * f]);
  }

  // --- build -----------------------------------------------------------------
  const incomplete = parts.filter((p) => !p.asset && !p.generic);
  async function build() {
    if (!maps) return;
    finishPath();
    setBusy(true); setMessage("");
    try {
      const out: PhotoBuildPart[] = parts
        .filter((p) => p.asset || p.generic)
        .map((p) => {
          const raw = apply(maps.toBoard, [p.px, p.py]);
          const hit = placed.get(p.id);
          // On the beam: where the draft puts it, facing the way the beam
          // leaves it. Off it: where it was marked, on a hole if near one.
          const foot = hit?.at ?? snapToHole(raw, holes).p;
          const part: PhotoBuildPart = {
            id: p.id, x: foot[0], y: foot[1],
            ...(p.asset ? { asset: p.asset } : { generic: p.generic }),
            ...(hit ? {} : { offBeam: true }),
            ...(hit && typeOf(p) === "laser" ? { emitAt: true } : {}),
          };
          if (hit) {
            part.dir = hit.out;
          } else if (p.ex !== undefined && p.ey !== undefined) {
            const tip = apply(maps.toBoard, [p.ex, p.ey]);
            part.dir = [tip[0] - raw[0], tip[1] - raw[1]];
          }
          return part;
        });
      // Whatever the drawing needs and nobody marked: a laser at its start,
      // a mirror at each bend, a splitter where a branch leaves.
      if (needsLaser && draft?.start && draft.startDir) {
        out.push({ id: "auto-laser", generic: { role: "laser", label: t("photo_auto_laser") },
          x: draft.start[0], y: draft.start[1], dir: draft.startDir, emitAt: true });
      }
      autoTurns.forEach((turn, i) => {
        out.push({ id: `auto-turn-${i}`,
          generic: turn.split
            ? { role: "beamsplitter", label: t("photo_auto_splitter") }
            : { role: "mirror", label: t("photo_auto_mirror") },
          x: turn.at[0], y: turn.at[1], dir: turn.outDir });
      });
      const payload = await api.buildFromPhoto(project, beamHeight, out, renderMode);
      update({ built: payload.built });
      onBuilt(payload);
      setMessage(t("photo_built", { n: Object.keys(payload.built).length }));
    } catch {
      setMessage(t("photo_build_failed"));
    } finally {
      setBusy(false);
    }
  }

  if (!labels) return <div className="photo-builder"><div className="photo-empty">…</div></div>;

  const r = 7 * unit;            // marker radius, ~7 screen px
  const stroke = 2 * unit;
  const predicted: Point[] = maps ? holes.map((h) => apply(maps.toPhoto, h)) : [];

  return (
    <div className="photo-builder" role="dialog" aria-label={t("photo_title")}>
      <div className="photo-head">
        <strong>{t("photo_title")}</strong>
        {labels.photo && (
          <div className="seg">
            <button className={tab === "calib" ? "active" : "ghost"} onClick={() => setTab("calib")}>
              ① {t("photo_step_calib")}
            </button>
            <button
              className={tab === "path" ? "active" : "ghost"} disabled={!maps}
              onClick={() => setTab("path")} data-testid="photo-tab-path"
            >
              ② {t("photo_step_path")}
            </button>
            <button
              className={tab === "parts" ? "active" : "ghost"} disabled={!maps}
              onClick={() => { finishPath(); setTab("parts"); }} data-testid="photo-tab-parts"
            >
              ③ {t("photo_step_parts")}
            </button>
          </div>
        )}
        <span className="photo-msg">{message}</span>
        <button className="ghost" onClick={onClose} data-testid="photo-close">{t("photo_close")}</button>
      </div>

      <div className="photo-body">
        <div className="photo-stage">
          {labels.photo && vb && (
            <div className="photo-banner" data-testid="photo-banner">
              {tab === "calib" ? (
                <>
                  <BoardDiagram done={calib.length} />
                  <div>
                    <strong>
                      {calib.length < 4
                        ? t("photo_banner_calib", { n: calib.length + 1 })
                        : t("photo_banner_check")}
                    </strong>
                    <small>{calib.length < 4 ? t("photo_banner_calib_sub") : t("photo_banner_check_sub")}</small>
                  </div>
                  {calib.length === 4 && (
                    <div className="photo-banner-actions">
                      <button onClick={() => {
                        const next = (turn + 1) % 4;
                        setTurn(next);
                        update({ calib: assignCorners(calib, axes, next) });
                      }} title={t("photo_turn_hint")}>↻ {t("photo_turn")}</button>
                      <button onClick={() => update({ calib: [] })}>{t("photo_reset")}</button>
                      <button className="primary" disabled={!maps} onClick={() => setTab("path")}>
                        {t("photo_next_path")}
                      </button>
                    </div>
                  )}
                </>
              ) : tab === "path" ? (
                <>
                  <div>
                    <strong>
                      {!hasPath && drawing === null ? t("photo_banner_path_start")
                        : drawing !== null ? t("photo_banner_path_next")
                          : t("photo_banner_path_done")}
                    </strong>
                    <small>
                      {drawing !== null ? t("photo_banner_path_next_sub")
                        : hasPath ? t("photo_banner_path_done_sub") : t("photo_banner_path_start_sub")}
                    </small>
                  </div>
                  <div className="photo-banner-actions">
                    {drawing !== null && (
                      <button onClick={finishPath} data-testid="photo-path-finish">{t("photo_path_finish")}</button>
                    )}
                    <button onClick={undoPathPoint} disabled={!rawPaths.length}>{t("photo_undo_point")}</button>
                    <button onClick={() => { update({ paths: [] }); setDrawing(null); }} disabled={!rawPaths.length}>
                      {t("photo_reset")}
                    </button>
                    {drawing === null && hasPath && (
                      <button className="primary" onClick={() => setTab("parts")} data-testid="photo-next-parts">
                        {t("photo_next_parts")}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <strong>
                      {offBeamMode ? t("photo_banner_offbeam") : t("photo_banner_onpath")}
                    </strong>
                    <small>
                      {offBeamMode ? t("photo_banner_offbeam_sub") : t("photo_banner_onpath_sub")}
                    </small>
                  </div>
                  <div className="photo-banner-actions">
                    <button
                      className={offBeamMode ? "active" : ""} data-testid="photo-offbeam"
                      onClick={() => setOffBeamMode((m) => !m)}
                    >
                      {offBeamMode ? t("photo_back_to_beam") : t("photo_offbeam")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {!labels.photo || !vb ? (
            <label className="photo-drop">
              <input
                type="file" accept="image/jpeg,image/png,image/webp" data-testid="photo-file"
                onChange={(e) => onFile(e.target.files?.[0])} disabled={busy}
              />
              <span>{busy ? t("photo_uploading") : t("photo_pick")}</span>
              <small>{t("photo_pick_hint")}</small>
            </label>
          ) : (
            <svg
              ref={svgRef} className={`photo-svg ${tab}`} data-testid="photo-svg"
              viewBox={vb.join(" ")} preserveAspectRatio="xMidYMid meet"
              onPointerDown={onPointerDown} onPointerMove={onPointerMove}
              onPointerUp={onPointerUp} onWheel={onWheel}
              onDoubleClick={() => { if (tab === "path") finishPath(); }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <image href={api.photoUrl(project, labels.photo)} width={labels.imgW} height={labels.imgH} />
              {predicted.map(([x, y], i) => (
                <circle key={`h${i}`} cx={x} cy={y} r={r * 0.45} className="photo-hole" />
              ))}
              {calib.map((c, i) => (
                <g key={`c${i}`}>
                  <circle cx={c.px} cy={c.py} r={r * 1.3} className="photo-calib" strokeWidth={stroke} />
                  <text x={c.px + r * 1.8} y={c.py - r * 1.2} fontSize={r * 2.2} className="photo-tag">
                    {cornerIndex(c, axes) >= 0 ? t(`corner_short_${cornerIndex(c, axes) + 1}`) : i + 1}
                  </text>
                </g>
              ))}
              {tab !== "calib" && maps && draft && (
                <g data-testid="photo-draft">
                  {draft.paths.map((path, k) => path.length > 1 && (
                    <polyline key={`d${k}`} className="photo-beam" data-testid="photo-beam"
                      points={path.map((q) => apply(maps.toPhoto, q).join(",")).join(" ")}
                      strokeWidth={stroke * 1.6} />
                  ))}
                  {/* The leg being drawn, squared the way it will be. */}
                  {tab === "path" && drawing !== null && hover && rawPaths[drawing]?.length > 0 && (() => {
                    const pts = draft.paths[drawing] ?? [];
                    const last = pts[pts.length - 1];
                    if (!last) return null;
                    const sq = squarePath([last, apply(maps.toBoard, hover)]);
                    if (sq.length < 2) return null;
                    return (
                      <polyline className="photo-beam rubber"
                        points={sq.map((q) => apply(maps.toPhoto, q).join(",")).join(" ")}
                        strokeWidth={stroke * 1.2} />
                    );
                  })()}
                  {draft.paths.flatMap((path, k) => path.map((q, i) => {
                    const [x, y] = apply(maps.toPhoto, q);
                    return <circle key={`v${k}-${i}`} cx={x} cy={y} r={r * 0.6} className="photo-vertex" />;
                  }))}
                  {draft.start && (() => {
                    const [x, y] = apply(maps.toPhoto, draft.start);
                    return <text x={x + r} y={y + r * 2.6} fontSize={r * 1.8} className="photo-turn-tag">▶ {t("role_laser")}</text>;
                  })()}
                  {draft.turns.map((turn, i) => {
                    const [x, y] = apply(maps.toPhoto, turn.at);
                    const auto = autoTurns.includes(turn);
                    return (
                      <g key={`t${i}`} className={`photo-turn${auto ? " auto" : ""}${turn.impossible ? " bad" : ""}`}>
                        <rect x={x - r} y={y - r} width={r * 2} height={r * 2}
                          transform={`rotate(45 ${x} ${y})`} strokeWidth={stroke} />
                        {turn.impossible && (
                          <text x={x + r * 1.5} y={y - r * 1.2} fontSize={r * 1.7} className="photo-turn-tag bad">
                            ⚠ {t("photo_turn_impossible")}
                          </text>
                        )}
                        {tab === "parts" && auto && (
                          <text x={x + r * 1.5} y={y + r * 2.6} fontSize={r * 1.7} className="photo-turn-tag">
                            {turn.split ? t("photo_auto_splitter") : t("photo_auto_mirror")}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              )}
              {tab === "parts" && parts.map((p, i) => {
                const done = Boolean(p.asset || p.generic);
                const at = maps && placed.get(p.id)?.at;
                const [qx, qy] = at ? apply(maps.toPhoto, at) : [p.px, p.py];
                return (
                  <g
                    key={p.id}
                    className={`photo-part${p.id === selected ? " on" : ""}${done ? "" : " todo"}`}
                    onPointerDown={(e) => { e.stopPropagation(); setSelected(p.id); }}
                  >
                    {p.ex !== undefined && p.ey !== undefined && (
                      <line x1={p.px} y1={p.py} x2={p.ex} y2={p.ey} strokeWidth={stroke}
                        markerEnd="url(#photo-arrow)" />
                    )}
                    {/* Where it was clicked, tied to where it lands on the beam. */}
                    {at && (
                      <>
                        <line x1={p.px} y1={p.py} x2={qx} y2={qy} strokeWidth={stroke * 0.6}
                          className="photo-pull" />
                        <circle cx={p.px} cy={p.py} r={r * 0.35} className="photo-clicked" />
                      </>
                    )}
                    <circle cx={qx} cy={qy} r={r} strokeWidth={stroke}
                      className={p.offBeam ? "off" : ""} />
                    {/* Just the number: names of neighbouring parts on a rail
                        overlap into an unreadable strip. The selected one
                        says what it is. */}
                    <text x={qx + r * 1.4} y={qy - r * 1.1} fontSize={r * 2}>
                      {p.id === selected ? `${i + 1} ${partName(p, t)}` : i + 1}
                    </text>
                  </g>
                );
              })}
              {drag && (
                <g className="photo-part on">
                  <line x1={drag.px} y1={drag.py} x2={drag.ex} y2={drag.ey} strokeWidth={stroke} />
                  <circle cx={drag.px} cy={drag.py} r={r} strokeWidth={stroke} />
                </g>
              )}
              <defs>
                <marker id="photo-arrow" viewBox="0 0 10 10" refX="8" refY="5"
                  markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className="photo-arrowhead" />
                </marker>
              </defs>
            </svg>
          )}
        </div>

        <aside className="photo-panel">
          {!labels.photo ? (
            <p className="muted">{t("photo_intro")}</p>
          ) : tab === "calib" ? (
            <>
              <p className="muted">{t("photo_calib_help")}</p>
              <label className="photo-field">
                {t("photo_board")}
                <select
                  value={data.board.model?.asset ?? ""}
                  onChange={(e) => { void onBoardModel(e.target.value); update({ calib: [] }); }}
                >
                  {(data.boardModels ?? []).map((m) => (
                    <option key={m} value={m}>{partModel(m)}</option>
                  ))}
                </select>
              </label>
              <small className="muted">
                {t("photo_grid", { cols: axes.xs.length, rows: axes.ys.length })}
              </small>
              <details className="photo-hidden-corner" open={calib.some((c) => cornerIndex(c, axes) < 0)}>
                <summary>{t("photo_hidden_corner")}</summary>
                <p className="muted">{t("photo_hidden_corner_help")}</p>
              <ol className="photo-calib-list">
                {[0, 1, 2, 3].map((i) => {
                  const c: CalibPoint | undefined = calib[i];
                  return (
                    <li key={i} className={c ? "" : "muted"}>
                      <span>
                        {c && cornerIndex(c, axes) >= 0
                          ? t(`photo_corner_${cornerIndex(c, axes) + 1}`)
                          : `${t("photo_point")} ${i + 1}`}
                      </span>
                      {c && (
                        <span className="photo-colrow">
                          {t("photo_col")}
                          <input type="number" min={1} max={axes.xs.length} value={c.col}
                            onChange={(e) => update({ calib: calib.map((q, k) => k === i ? { ...q, col: Number(e.target.value) } : q) })} />
                          {t("photo_row")}
                          <input type="number" min={1} max={axes.ys.length} value={c.row}
                            onChange={(e) => update({ calib: calib.map((q, k) => k === i ? { ...q, row: Number(e.target.value) } : q) })} />
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
              </details>
              <div className="photo-row">
                <button onClick={() => update({ calib: calib.slice(0, -1) })} disabled={!calib.length}>
                  {t("photo_undo_point")}
                </button>
                <button onClick={() => update({ calib: [] })} disabled={!calib.length}>{t("photo_reset")}</button>
              </div>
              <label className="photo-field">
                {t("beam_height")} (mm)
                <input type="number" min={10} max={300} value={beamHeight}
                  onChange={(e) => update({ beamHeight: Number(e.target.value) })} />
              </label>
              <button className="primary" disabled={!maps} onClick={() => setTab("path")}>
                {t("photo_next_path")}
              </button>
              <label className="photo-replace">
                {t("photo_replace")}
                <input type="file" accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
            </>
          ) : tab === "path" ? (
            <>
              <p className="muted">{t("photo_path_help")}</p>
              <ul className="photo-path-summary" data-testid="photo-path-summary">
                <li>{t("photo_path_lines", { n: draft?.paths.filter((q) => q.length > 1).length ?? 0 })}</li>
                <li>{t("photo_path_turns", { n: draft?.turns.length ?? 0 })}</li>
              </ul>
              <label className="photo-field">
                {t("beam_height")} (mm)
                <input type="number" min={10} max={300} value={beamHeight}
                  onChange={(e) => update({ beamHeight: Number(e.target.value) })} />
              </label>
            </>
          ) : (
            <>
              <p className="muted">{t("photo_parts_help")}</p>
              <ol className="photo-part-list">
                {parts.map((p, i) => (
                  <li key={p.id} className={`${p.id === selected ? "on" : ""}${p.asset || p.generic ? "" : " todo"}`}>
                    <button className="linkish" onClick={() => setSelected(p.id)}>
                      {i + 1}. {partName(p, t)}{p.ex !== undefined ? " ➜" : ""}
                    </button>
                  </li>
                ))}
              </ol>

              {sel && (
                <div className="photo-editor" data-testid="photo-editor">
                  <div className="seg">
                    <button className={!sel.generic ? "active" : "ghost"}
                      onClick={() => updatePart(sel.id, { generic: undefined })}>
                      {t("photo_kind_catalogue")}
                    </button>
                    <button className={sel.generic ? "active" : "ghost"}
                      onClick={() => updatePart(sel.id, { asset: undefined, generic: sel.generic ?? { role: "lens" } })}>
                      {t("photo_kind_generic")}
                    </button>
                  </div>
                  {!sel.generic ? (
                    <button className="photo-pick" data-testid="photo-pick-part"
                      onClick={() => setBrowsing(sel.id)}>
                      {sel.asset ? (
                        <>
                          <small>{partCategory(sel.asset)}</small>
                          <strong>{partModel(sel.asset)}</strong>
                          <span>{t("photo_change_part")}</span>
                        </>
                      ) : (
                        <strong>{t("photo_choose_part")}</strong>
                      )}
                    </button>
                  ) : (
                    <GenericEditor spec={sel.generic} onChange={(g) => updatePart(sel.id, { generic: g })} />
                  )}
                  <div className="photo-row">
                    {sel.ex !== undefined && (
                      <button onClick={() => updatePart(sel.id, { ex: undefined, ey: undefined })}>
                        {t("photo_clear_arrow")}
                      </button>
                    )}
                    <button className="danger" onClick={() => {
                      update({ parts: parts.filter((p) => p.id !== sel.id) });
                      setSelected(null);
                    }}>
                      {t("photo_remove_part")}
                    </button>
                  </div>
                </div>
              )}

              <div className="photo-build">
                {incomplete.length > 0 && (
                  <small className="err">{t("photo_incomplete", { n: incomplete.length })}</small>
                )}
                <button className="primary" data-testid="photo-build"
                  disabled={busy || !maps || parts.length === incomplete.length} onClick={build}>
                  {busy ? t("photo_building") : t("photo_build")}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>

      {browsing && (
        <PartBrowser
          title={t("photo_which_part", { n: parts.findIndex((p) => p.id === browsing) + 1 })}
          initialCategory={(() => {
            const p = parts.find((q) => q.id === browsing);
            if (!p || p.offBeam || !maps || !draft?.start || !needsLaser) return undefined;
            const foot = apply(maps.toBoard, [p.px, p.py]);
            // Marked at the start of the drawn beam: it is the laser.
            return Math.hypot(foot[0] - draft.start[0], foot[1] - draft.start[1]) < 60 ? "Laser" : undefined;
          })()}
          library={data.library.filter((a) => !a.startsWith("Breadboard/"))}
          previews={data.libraryPreviews}
          asset={parts.find((p) => p.id === browsing)?.asset ?? ""}
          onPick={(asset) => {
            updatePart(browsing, { asset, generic: undefined });
            setBrowsing(null);
          }}
          onClose={() => setBrowsing(null)}
        />
      )}
    </div>
  );
}

/**
 * A tiny board seen from the near side, as in the photo: which corners to
 * click, and how many are in. The near edge is at the bottom, labelled, so
 * "near" means the side the photo was taken from.
 */
function BoardDiagram({ done }: { done: number }) {
  const { t } = useSettings();
  const corners: [number, number][] = [[8, 44], [72, 44], [72, 8], [8, 8]];
  return (
    <svg className="photo-diagram" viewBox="0 0 80 62" aria-hidden>
      <rect x={8} y={8} width={64} height={36} rx={2} />
      {corners.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={4.5} className={i < done ? "done" : ""} />
      ))}
      <text x={40} y={58} textAnchor="middle">{t("photo_near_side")}</text>
    </svg>
  );
}

function GenericEditor({ spec, onChange }: { spec: GenericSpec; onChange: (g: GenericSpec) => void }) {
  const { t } = useSettings();
  const size = spec.size ?? [NaN, NaN, NaN];
  const setSize = (i: number, v: string) => {
    const next = [...size] as [number, number, number];
    next[i] = Number(v);
    onChange({ ...spec, size: next });
  };
  return (
    <div className="photo-generic">
      <label className="photo-field">
        {t("photo_role")}
        <select value={spec.role} data-testid="photo-role"
          onChange={(e) => onChange({ ...spec, role: e.target.value as GenericRole })}>
          {ROLES.map((r) => <option key={r} value={r}>{t(`role_${r}`)}</option>)}
        </select>
      </label>
      <div className="photo-size">
        {[t("photo_size_x"), t("photo_size_y"), t("photo_size_z")].map((lab, i) => (
          <label key={i}>
            {lab}
            <input type="number" min={1} placeholder={t("photo_auto")}
              value={Number.isFinite(size[i]) ? size[i] : ""} onChange={(e) => setSize(i, e.target.value)} />
          </label>
        ))}
      </div>
      <input placeholder={t("photo_label")} value={spec.label ?? ""}
        onChange={(e) => onChange({ ...spec, label: e.target.value })} />
      <input placeholder={t("photo_model")} value={spec.model ?? ""}
        onChange={(e) => onChange({ ...spec, model: e.target.value })} />
      <label className="photo-check">
        <input type="checkbox" checked={Boolean(spec.requestPart)}
          onChange={(e) => onChange({ ...spec, requestPart: e.target.checked })} />
        {t("photo_request")}
      </label>
    </div>
  );
}
