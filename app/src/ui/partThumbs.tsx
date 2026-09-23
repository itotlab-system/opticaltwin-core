/**
 * Thumbnails for the part browser, rendered from the catalogue geometry the
 * project payload already carries (`libraryPreviews`).
 *
 * One offscreen canvas renders the parts **one at a time** into cached PNG data
 * URLs, rather than a live <Canvas> per tile: a browser gives a page ~16 WebGL
 * contexts and the catalogue is 70-odd parts, so a canvas per tile would start
 * losing contexts halfway down the grid. Rendering the real geometry (instead
 * of shipping hand-made icons) also means the tile is exactly what lands on the
 * bench when it is placed.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { Component } from "../types";
import Component3D from "../scene/Component3D";
import { api } from "../api";

const SIZE = 320;                 // rendered thumbnail, in pixels (square)
const SETTLE_FRAMES = 2;          // let textures/materials land before capture
// Covers fetching the part's geometry as well as drawing it, so a part that
// never resolves stalls the queue for this long and no longer.
const CAPTURE_TIMEOUT_MS = 8000;

// asset id → PNG data URL. Module-level so reopening the browser, or switching
// projects, reuses what was already drawn.
const CACHE = new Map<string, string>();

export function cachedThumb(asset: string): string | undefined {
  return CACHE.get(asset);
}

/* ---- across-session cache -------------------------------------------------
 * The module-level CACHE dies with the page, so every reload paid for the whole
 * catalogue again — 86 parts at ~3 s each. The pictures are pure functions of
 * the CAD, so they belong on disk. IndexedDB rather than localStorage: the PNGs
 * total a few MB and localStorage's ~5 MB budget is shared with the project
 * clipboard and viewport settings, which must not be evicted by thumbnails.
 * A store bump invalidates every tile at once when the render changes.
 */
const DB_NAME = "ot.partThumbs";
const STORE = "v1";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      // Old stores are the previous render; drop them rather than migrate.
      for (const name of Array.from(db.objectStoreNames)) {
        db.deleteObjectStore(name);
      }
      db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Fills CACHE from disk. Resolves even when storage is unavailable. */
let loaded: Promise<void> | null = null;
function loadPersisted(): Promise<void> {
  if (loaded) return loaded;
  loaded = openDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) return resolve();
        try {
          const tx = db.transaction(STORE, "readonly");
          const cursor = tx.objectStore(STORE).openCursor();
          cursor.onsuccess = () => {
            const at = cursor.result;
            if (!at) return resolve();
            // A tile drawn this session is newer than the stored one.
            if (!CACHE.has(String(at.key))) {
              CACHE.set(String(at.key), at.value as string);
            }
            at.continue();
          };
          cursor.onerror = () => resolve();
        } catch {
          resolve();
        }
      }),
  );
  return loaded;
}

function persistThumb(asset: string, dataUrl: string) {
  // Fire and forget: a tile that fails to store is redrawn next session, which
  // is exactly today's behaviour and never a reason to interrupt browsing.
  void openDb().then((db) => {
    if (!db) return;
    try {
      db.transaction(STORE, "readwrite").objectStore(STORE).put(dataUrl, asset);
    } catch {
      /* quota or a closed db — the in-memory cache still serves this session */
    }
  });
}

const noop = () => {};

/** Frame the part in an orthographic 3/4 view, render, and hand back a PNG. */
function ForgeSubject({
  component,
  onCapture,
}: {
  component: Component;
  onCapture: (dataUrl: string | null) => void;
}) {
  const { gl, scene, camera } = useThree();
  const subject = useRef<THREE.Group | null>(null);
  const frames = useRef(0);
  const done = useRef(false);

  useFrame(() => {
    if (done.current) return;
    frames.current += 1;
    if (frames.current <= SETTLE_FRAMES) return;

    const group = subject.current;
    if (!group) return;
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) {
      done.current = true;
      onCapture(null);
      return;
    }

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    // Looking down the bench from front-right, Z up, so a lens reads as a disc
    // in a barrel rather than as an edge-on line.
    const direction = new THREE.Vector3(0.9, -1, 0.45).normalize();
    camera.up.set(0, 0, 1);
    camera.position.copy(center).addScaledVector(direction, radius * 4);
    camera.lookAt(center);

    const ortho = camera as THREE.OrthographicCamera;
    const half = radius * 1.12;
    ortho.left = -half;
    ortho.right = half;
    ortho.top = half;
    ortho.bottom = -half;
    ortho.near = 0.01;
    ortho.far = radius * 12;
    ortho.updateProjectionMatrix();

    gl.render(scene, camera);
    done.current = true;
    onCapture(gl.domElement.toDataURL("image/png"));
  });

  return (
    <Component3D
      c={component}
      selected={false}
      interactive={false}
      onSelect={noop}
      onMove={noop}
      setRef={(_name, ref) => {
        subject.current = ref;
      }}
    />
  );
}

/**
 * Renders the pending parts one per mount and fills CACHE. Mounted once, hidden,
 * for as long as the browser is open.
 */
function ThumbnailForge({
  order,
  previews,
  onCaptured,
}: {
  /** Assets to draw, most-wanted first. May be reordered at any time. */
  order: string[];
  previews: Record<string, Component>;
  onCaptured: () => void;
}) {
  // Tracked by asset id, never by position in `order`: the caller re-sorts the
  // queue as the user filters the grid, and an index into a list that moves
  // under you silently skips parts.
  const attempted = useRef<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [detailed, setDetailed] = useState<Component | null>(null);
  // Geometry already fetched, so the network wait for part n+1 overlaps the
  // render of part n instead of following it.
  const fetched = useRef<Map<string, Component>>(new Map());

  // The queue re-sorts as the grid scrolls. Read it through a ref inside the
  // fetch effect: depending on `order` there re-ran the effect on every scroll
  // and re-issued the fetch for the part already being drawn — measured at 47
  // requests for 13 tiles, each one ~940 kB that was then thrown away.
  const queue = useRef(order);
  queue.current = order;

  const pendingFrom = (from: number) =>
    queue.current
      .slice(from)
      .find(
        (asset) =>
          !CACHE.has(asset) && !attempted.current.has(asset) && previews[asset],
      ) ?? null;

  useEffect(() => {
    if (current === null) setCurrent(pendingFrom(0));
    // `order` is in the deps so a re-sort can supply work when the forge is
    // idle; it must not interrupt a part already being drawn.
  }, [order, current]);

  // The catalogue in the project payload is `lo`, and a lo asset is a
  // bounding-box stand-in — every post holder would be the same anonymous
  // block. Pull the real geometry for this one part, then draw it.
  useEffect(() => {
    setDetailed(null);
    if (!current) return;
    let live = true;

    const ready = fetched.current.get(current);
    if (ready) {
      setDetailed(ready);
    } else {
      api
        .libraryPreview(current, "hi")
        .then((r) => {
          if (live) setDetailed(r.component);
        })
        // The lo part still makes a recognisable silhouette; a tile of it beats
        // no tile at all.
        .catch(() => {
          if (live) setDetailed(previews[current]);
        });
    }

    // Warm the part behind this one, so its download overlaps this render
    // instead of following it. Exactly one spare is held: these assets are
    // ~940 kB each and a deeper queue is memory spent on guesses about where
    // the user will scroll.
    const at = queue.current.indexOf(current);
    const upcoming = at < 0 ? null : pendingFrom(at + 1);
    if (upcoming && !fetched.current.has(upcoming)) {
      api
        .libraryPreview(upcoming, "hi")
        .then((r) => {
          fetched.current.clear();
          fetched.current.set(upcoming, r.component);
        })
        .catch(() => {
          /* it will be fetched again, in its own turn */
        });
    }

    return () => {
      live = false;
    };
  }, [current, previews]);

  // A part whose geometry never arrives, or never renders, would otherwise hold
  // up every tile behind it.
  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => {
      attempted.current.add(current);
      onCaptured();
      setCurrent(null);
    }, CAPTURE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [current, onCaptured]);

  // The Canvas itself stays mounted for as long as there is work, and only the
  // subject inside it changes. Returning null between parts tore down and
  // rebuilt a WebGL context per tile — measured at 20 contexts for 19 tiles and
  // ~3.2 s each, which is the whole reason the catalogue took minutes to fill.
  const finish = (dataUrl: string | null) => {
    if (current && dataUrl) {
      CACHE.set(current, dataUrl);
      persistThumb(current, dataUrl);
    }
    if (current) attempted.current.add(current);
    onCaptured();
    setCurrent(null);
  };

  return (
    <div className="thumb-forge" aria-hidden="true">
      <Canvas
        orthographic
        frameloop="always"
        dpr={1}
        gl={{ preserveDrawingBuffer: true, alpha: true, antialias: true }}
        camera={{ position: [1, -1, 1], zoom: 1, near: 0.01, far: 10000 }}
        style={{ width: SIZE, height: SIZE }}
      >
        <hemisphereLight args={["#cfe0ff", "#10131a", 0.6]} />
        <ambientLight intensity={0.45} />
        <directionalLight position={[300, -400, 600]} intensity={2.4} />
        <directionalLight position={[-400, 300, 200]} intensity={0.7} />
        <Suspense fallback={null}>
          {/* Keyed so each part gets a fresh subject and frame counter. */}
          {current && detailed && (
            <ForgeSubject key={current} component={detailed} onCapture={finish} />
          )}
        </Suspense>
      </Canvas>
    </div>
  );
}

/**
 * Drives the forge for a set of assets and reports which thumbnails exist.
 * Parts that ship a real photograph are skipped — the photo is the better tile.
 */
export function useThumbnails(
  previews: Record<string, Component> | undefined,
  /** Assets currently on screen — drawn first, so the visible grid fills first. */
  visible: string[],
  enabled: boolean,
) {
  const [, bump] = useState(0);
  const onCaptured = useCallback(() => bump((n) => n + 1), []);

  // Tiles drawn in an earlier session are on disk; adopt them before drawing
  // anything, so a returning user waits for nothing.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let live = true;
    void loadPersisted().then(() => {
      if (!live) return;
      setRestored(true);
      onCaptured();
    });
    return () => {
      live = false;
    };
  }, [onCaptured]);

  const order = useMemo(() => {
    // Drawing before the disk cache is read would redraw tiles that already
    // exist, which is the exact cost this is here to avoid.
    if (!enabled || !previews || !restored) return [];
    const wanted = Object.keys(previews).filter(
      // A part with a real photograph already has its picture.
      (asset) => !previews[asset]?.photo,
    );
    const onScreen = new Set(visible);
    return [
      ...wanted.filter((asset) => onScreen.has(asset)),
      ...wanted.filter((asset) => !onScreen.has(asset)).sort(),
    ];
  }, [previews, visible, enabled, restored]);

  const pending = order.filter((asset) => !CACHE.has(asset)).length;

  // Unmounted once every tile is drawn: the canvas runs an always-on frameloop,
  // and an idle forge would keep rendering nothing for as long as the browser
  // stayed open.
  const forge =
    previews && pending > 0 ? (
      <ThumbnailForge order={order} previews={previews} onCaptured={onCaptured} />
    ) : null;

  return { forge, pending };
}
