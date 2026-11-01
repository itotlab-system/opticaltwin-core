/**
 * The visual part catalogue.
 *
 * The old picker was two dropdowns of raw 型番 (`R3L3S1N-Step`, `LA1417-AB`),
 * so the only way to find out what a part looked like was to place it on the
 * bench and look. This shows every part as a picture — a real photograph where
 * the folder has one, otherwise its own CAD geometry — with the numbers that
 * decide the choice underneath.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Component } from "../types";
import { useSettings } from "../settings";
import { colorFor } from "./typeColor";
import { displayType } from "./Outliner";
import {
  partCategory,
  partModel,
  partSearchText,
  partSpecs,
} from "./partLabels";
import { cachedThumb, useThumbnails } from "./partThumbs";

const ALL = "__all__";

/** Dragged window size. Global, not per project: this is a fact about the
 *  monitor the catalogue is being browsed on, not about the bench — unlike the
 *  viewport background, which is per project because benches differ. */
const SIZE_KEY = "ot.partBrowserSize";

function storedSize(): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (!raw) return null;
    const size = JSON.parse(raw);
    if (typeof size?.w === "number" && typeof size?.h === "number") return size;
  } catch {
    // A corrupt entry just means the default size.
  }
  return null;
}

function PartTile({
  asset,
  preview,
  selected,
  onPick,
  observe,
}: {
  asset: string;
  preview: Component | undefined;
  selected: boolean;
  onPick: () => void;
  /** Registers the tile with the grid's viewport observer. */
  observe: (asset: string, element: HTMLElement | null) => void;
}) {
  const photo = preview?.photo;
  const thumb = photo ?? cachedThumb(asset);
  const specs = partSpecs(preview);
  const type = preview?.type ?? "";
  return (
    <button
      type="button"
      className={"part-tile" + (selected ? " sel" : "")}
      onClick={onPick}
      title={asset}
      ref={(element) => observe(asset, element)}
    >
      <span className="part-thumb">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" draggable={false} />
        ) : (
          // Held until the forge reaches this part. A flat block reads as "this
          // part is a gray box"; the sweep says the picture is still coming, and
          // the type colour keeps the grid from flashing as empty boxes.
          <span
            className="part-thumb-wait"
            style={{ ["--tint" as string]: colorFor(type) }}
          />
        )}
      </span>
      <span className="part-model">{partModel(asset)}</span>
      {type && <span className="part-type">{displayType(type)}</span>}
      {specs.length > 0 && (
        <span className="part-specs">{specs.join(" · ")}</span>
      )}
    </button>
  );
}

export default function PartBrowser({
  library,
  previews,
  asset,
  onPick,
  onClose,
  title,
  initialCategory,
}: {
  /** Heading; defaults to "Add a part". */
  title?: string;
  /** Open on this category (e.g. "Laser") instead of the whole catalogue. */
  initialCategory?: string;
  library: string[];
  previews?: Record<string, Component>;
  asset: string;
  /** Chosen part: the caller selects it and starts placing. */
  onPick: (asset: string) => void;
  onClose: () => void;
}) {
  const { t } = useSettings();
  const [query, setQuery] = useState("");
  // Opens on the whole catalogue, not on the current asset's category: the
  // reason to open this is that you don't yet know which category to look in.
  const [category, setCategory] = useState<string>(initialCategory ?? ALL);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Read once, at mount: applied as an inline style so the CSS default stands
  // until the user has actually dragged the window to a size they wanted.
  const [size] = useState(storedSize);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of library) {
      const group = partCategory(item);
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) =>
      left[0].localeCompare(right[0], undefined, { numeric: true }),
    );
  }, [library]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return library
      .filter((item) => {
        // A search is a search of the whole catalogue: narrowing to the open
        // category as well would hide the very part being looked for.
        if (!needle && category !== ALL && partCategory(item) !== category) {
          return false;
        }
        if (!needle) return true;
        return partSearchText(item, previews?.[item]).includes(needle);
      })
      .sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      );
  }, [library, previews, query, category]);

  // Which tiles are actually on screen, not merely in the filtered results: on
  // an 86-part catalogue only ~12 fit above the fold, and drawing in result
  // order made the visible grid wait behind parts nobody had scrolled to.
  const [onScreen, setOnScreen] = useState<string[]>([]);
  const tiles = useRef(new Map<string, HTMLElement>());
  const observer = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      // Without the observer every result is "visible" — the previous
      // behaviour, which is correct but unprioritised.
      setOnScreen(results);
      return;
    }
    const seen = new Set<string>();
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const asset = (entry.target as HTMLElement).dataset.asset;
          if (!asset) continue;
          if (entry.isIntersecting) seen.add(asset);
          else seen.delete(asset);
        }
        setOnScreen([...seen]);
      },
      // A screen of lookahead, so scrolling meets drawn tiles rather than
      // starting the render when they arrive.
      { root: null, rootMargin: "300px 0px" },
    );
    for (const element of tiles.current.values()) observer.current.observe(element);
    return () => observer.current?.disconnect();
  }, [results]);

  const observe = useCallback((asset: string, element: HTMLElement | null) => {
    const previous = tiles.current.get(asset);
    if (previous && previous !== element) observer.current?.unobserve(previous);
    if (element) {
      element.dataset.asset = asset;
      tiles.current.set(asset, element);
      observer.current?.observe(element);
    } else {
      tiles.current.delete(asset);
    }
  }, []);

  // Whatever is on screen gets drawn first; the rest fills in behind it.
  const { forge, pending } = useThumbnails(previews, onScreen, true);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Remember the dragged size. The observer reads the element's *inline*
  // width/height, which only the resize grip (or our own restore above) writes
  // — the measured box also shrinks when the browser window does, and clamping
  // the dialog to a small screen must not overwrite the size chosen on a large
  // one.
  useEffect(() => {
    const element = dialogRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const w = parseFloat(element.style.width);
      const h = parseFloat(element.style.height);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return;
      localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (event.key === "Enter" && results.length > 0) {
        onPick(results[0]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onPick, results]);

  return (
    <div
      className="part-browser-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="part-browser"
        role="dialog"
        aria-label={t("browse_parts")}
        style={size ? { width: size.w, height: size.h } : undefined}
      >
        <header className="part-browser-head">
          <h2>{title ?? t("browse_parts")}</h2>
          <input
            ref={searchRef}
            className="part-search"
            type="search"
            value={query}
            placeholder={t("part_search_placeholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="icon-btn part-browser-close"
            onClick={onClose}
            title={t("close")}
          >
            ✕
          </button>
        </header>

        <div className="part-browser-body">
          <nav className="part-categories">
            <button
              type="button"
              className={"part-category" + (category === ALL ? " sel" : "")}
              onClick={() => setCategory(ALL)}
            >
              <span className="nm">{t("all_parts")}</span>
              <span className="x-hint">{library.length}</span>
            </button>
            {categories.map(([group, count]) => (
              <button
                key={group}
                type="button"
                className={"part-category" + (category === group ? " sel" : "")}
                onClick={() => setCategory(group)}
              >
                <span className="nm">{group}</span>
                <span className="x-hint">{count}</span>
              </button>
            ))}
          </nav>

          <div className="part-grid">
            {results.length === 0 && (
              <div className="empty">{t("part_no_match")}</div>
            )}
            {results.map((item) => (
              <PartTile
                key={item}
                asset={item}
                preview={previews?.[item]}
                selected={item === asset}
                onPick={() => onPick(item)}
                observe={observe}
              />
            ))}
          </div>
        </div>

        <footer className="part-browser-foot">
          <span className="status">
            {pending > 0
              ? t("part_previews_pending", { n: pending })
              : t("part_pick_hint")}
          </span>
        </footer>
        {forge}
      </div>
    </div>
  );
}
