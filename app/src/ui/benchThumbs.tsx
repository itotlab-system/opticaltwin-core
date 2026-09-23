/**
 * Bench thumbnails for the project gallery: a small render of the setup itself
 * on each card, in place of the grid of type-colour chips.
 *
 * Same shape as `partThumbs.tsx`, one level up — a *single* offscreen canvas
 * draws the projects one at a time into cached data URLs, rather than a live
 * <Canvas> per card. A browser gives a page ~16 WebGL contexts, and a lab can
 * have more benches than that on screen at once.
 *
 * A drawn bench is only correct for the setup it was drawn from, so every
 * thumbnail is keyed by the layer's mtime (`ProjectSummary.modified`). Editing
 * a project and coming back to the gallery therefore redraws its card instead
 * of showing yesterday's arrangement.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { ProjectData, ProjectSummary } from "../types";
import Component3D from "../scene/Component3D";
import Breadboard from "../scene/Breadboard";
import Beam from "../scene/Beam";
import { api } from "../api";
import { VIEWPORT_BG } from "../settings";

const WIDTH = 480;                // rendered thumbnail, in pixels
const HEIGHT = 300;               // 16:10, the aspect the card reserves
const SETTLE_FRAMES = 2;          // let materials land before capture
// Covers fetching the project payload as well as drawing it, so a bench that
// never resolves stalls the queue for this long and no longer.
const CAPTURE_TIMEOUT_MS = 15000;
// JPEG, not PNG: these are photographs of a scene, not icons — a 480x300 PNG of
// a lit bench is ~150 kB, the JPEG ~25 kB, and they are kept in localStorage.
const MIME = "image/jpeg";
const QUALITY = 0.82;
// The viewport's mid gray, not a theme colour: a thumbnail is drawn once and
// then shown under whichever theme the viewer has, so it cannot follow either.
// This is the same gray the toolbar offers for visibility — black anodized
// mounts vanish on a dark backdrop and silver optics wash out on a light one.
const BACKDROP = VIEWPORT_BG.gray;
const STORE_PREFIX = "ot.benchThumb.";

type Thumb = { rev: string; url: string };

// project name → thumbnail. Module-level so returning from the editor to the
// gallery reuses what was already drawn.
const CACHE = new Map<string, Thumb>();

/** Revision a thumbnail must carry to still count as current. */
export function revOf(project: ProjectSummary): string {
  return String(project.modified ?? 0);
}

function remember(name: string, thumb: Thumb) {
  CACHE.set(name, thumb);
  try {
    localStorage.setItem(STORE_PREFIX + name, JSON.stringify(thumb));
  } catch {
    // Full or disabled storage costs us persistence across reloads, nothing
    // more — the in-memory cache still serves this session.
  }
}

function recall(name: string): Thumb | undefined {
  const held = CACHE.get(name);
  if (held) return held;
  try {
    const raw = localStorage.getItem(STORE_PREFIX + name);
    if (!raw) return undefined;
    const thumb = JSON.parse(raw) as Thumb;
    if (typeof thumb?.url !== "string" || typeof thumb?.rev !== "string") {
      return undefined;
    }
    CACHE.set(name, thumb);
    return thumb;
  } catch {
    return undefined;
  }
}

/** The cached picture for a project, or undefined if it hasn't been drawn. */
export function cachedBenchThumb(project: ProjectSummary): string | undefined {
  const thumb = recall(project.name);
  return thumb && thumb.rev === revOf(project) ? thumb.url : undefined;
}

/**
 * Drop the thumbnails of projects that no longer exist.
 *
 * Called with the gallery's current list rather than from the delete and rename
 * handlers: a project can also go away because a teammate deleted it, and a
 * delete the user cancels at the confirm must not lose its picture.
 */
export function pruneBenchThumbs(live: string[]) {
  // An empty list is the gallery's first render, before the projects have
  // loaded — not a lab with no projects. Pruning against it threw away every
  // cached picture on every visit, and each one had to be drawn again.
  if (live.length === 0) return;
  const kept = new Set(live);
  for (const name of [...CACHE.keys()]) {
    if (!kept.has(name)) CACHE.delete(name);
  }
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(STORE_PREFIX)) continue;
      if (!kept.has(key.slice(STORE_PREFIX.length))) localStorage.removeItem(key);
    }
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

const noop = () => {};

/** Frame the whole bench in an orthographic 3/4 view, render, hand back a JPEG. */
function ForgeSubject({
  data,
  onCapture,
}: {
  data: ProjectData;
  onCapture: (dataUrl: string | null) => void;
}) {
  const { gl, scene, camera } = useThree();
  const subject = useRef<THREE.Group | null>(null);
  const parts = useRef<THREE.Group | null>(null);
  const frames = useRef(0);
  const done = useRef(false);

  useFrame(() => {
    if (done.current) return;
    frames.current += 1;
    if (frames.current <= SETTLE_FRAMES) return;

    const group = subject.current;
    if (!group) return;
    const whole = new THREE.Box3().setFromObject(group);
    if (whole.isEmpty()) {
      done.current = true;
      onCapture(null);
      return;
    }

    // Frame the *parts*, not the whole scene. A bench is usually a cluster of
    // optics on a much larger board, and framing the board leaves the setup a
    // speck in the middle of empty aluminium. The beam is excluded for the same
    // reason: a ray that escapes the bench is drawn as a long stub.
    const partsBox = parts.current
      ? new THREE.Box3().setFromObject(parts.current)
      : whole;
    const box = partsBox.isEmpty() ? whole : partsBox;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(whole.getSize(new THREE.Vector3()).length() / 2, 1);
    // Down the bench from front-right, Z up: the optical axis runs across the
    // card and the parts stand up off the board, which is how a bench is
    // recognised at a glance.
    const direction = new THREE.Vector3(0.75, -1, 0.55).normalize();
    camera.up.set(0, 0, 1);
    camera.position.copy(center).addScaledVector(direction, radius * 4);
    camera.lookAt(center);
    camera.updateMatrixWorld();

    // Exact fit: the box's silhouette in camera space, rather than its bounding
    // sphere. A bench is long and flat, so a sphere fit wastes most of the card.
    const view = new THREE.Vector3();
    let halfX = 1;
    let halfY = 1;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          view.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
          halfX = Math.max(halfX, Math.abs(view.x));
          halfY = Math.max(halfY, Math.abs(view.y));
        }
      }
    }
    // Grow whichever axis is short of the card's aspect, so the fit is snug on
    // one axis and never cropped on the other.
    const margin = 1.08;
    halfX *= margin;
    halfY *= margin;
    const aspect = WIDTH / HEIGHT;
    if (halfX / halfY < aspect) halfX = halfY * aspect;
    else halfY = halfX / aspect;

    const ortho = camera as THREE.OrthographicCamera;
    ortho.left = -halfX;
    ortho.right = halfX;
    ortho.top = halfY;
    ortho.bottom = -halfY;
    ortho.near = 0.01;
    ortho.far = radius * 12;
    ortho.updateProjectionMatrix();

    gl.render(scene, camera);
    done.current = true;
    onCapture(gl.domElement.toDataURL(MIME, QUALITY));
  });

  return (
    <group
      ref={(ref) => {
        subject.current = ref;
      }}
    >
      <Breadboard board={data.board} />
      <group
        ref={(ref) => {
          parts.current = ref;
        }}
      >
        {data.components.map((c) => (
          <Component3D
            key={c.name}
            c={c}
            selected={false}
            interactive={false}
            onSelect={noop}
            onMove={noop}
            setRef={noop}
          />
        ))}
      </group>
      <Beam segments={data.beam} />
    </group>
  );
}

/** Draws the pending benches one per mount and fills CACHE. */
function BenchForge({
  order,
  revs,
  onCaptured,
}: {
  /** Projects to draw, most-wanted first. May be reordered at any time. */
  order: string[];
  revs: Record<string, string>;
  onCaptured: () => void;
}) {
  // Tracked by project name, never by position in `order`: the queue re-sorts
  // as cards scroll into view, and an index into a moving list skips entries.
  const attempted = useRef<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [data, setData] = useState<ProjectData | null>(null);

  const next = () =>
    order.find((name) => !attempted.current.has(name)) ?? null;

  useEffect(() => {
    if (current === null) setCurrent(next());
    // `order` is in the deps so a re-sort can supply work when the forge is
    // idle; it must not interrupt a bench already being drawn.
  }, [order, current]);

  // `lo` geometry: a card-sized picture cannot show the difference, and `hi`
  // would pull every CAD asset in the project across the wire per card.
  useEffect(() => {
    setData(null);
    if (!current) return;
    let live = true;
    api
      .getProject(current, "lo")
      .then((project) => {
        if (live) setData(project);
      })
      .catch(() => {
        if (live) finish(null);
      });
    return () => {
      live = false;
    };
  }, [current]);

  // A project whose payload never arrives, or never renders, would otherwise
  // hold up every card behind it.
  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [current, onCaptured]);

  function finish(dataUrl: string | null) {
    if (current) {
      if (dataUrl) remember(current, { rev: revs[current] ?? "0", url: dataUrl });
      attempted.current.add(current);
    }
    onCaptured();
    setCurrent(null);
  }

  if (!current) return null;

  return (
    <div className="thumb-forge" aria-hidden="true">
      <Canvas
        orthographic
        frameloop="always"
        dpr={1}
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        camera={{ position: [1, -1, 1], zoom: 1, near: 0.01, far: 100000 }}
        style={{ width: WIDTH, height: HEIGHT }}
      >
        <color attach="background" args={[BACKDROP]} />
        <hemisphereLight args={["#cfe0ff", "#10131a", 0.6]} />
        <ambientLight intensity={0.4} />
        <directionalLight position={[400, -600, 900]} intensity={2.2} />
        <directionalLight position={[-500, 400, 300]} intensity={0.7} />
        <Suspense fallback={null}>
          {/* Keyed so each bench gets a fresh subject and frame counter. */}
          {data && <ForgeSubject key={current} data={data} onCapture={finish} />}
        </Suspense>
      </Canvas>
    </div>
  );
}

/**
 * Drives the forge for the gallery's projects and reports which pictures exist.
 * Returns the hidden forge element to mount, and a lookup for the cards.
 */
export function useBenchThumbnails(
  projects: ProjectSummary[],
  /** Projects currently on screen — drawn first, so visible cards fill first. */
  visible: string[],
) {
  const [drawn, bump] = useState(0);
  const onCaptured = useCallback(() => bump((n) => n + 1), []);

  const revs = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.name, revOf(p)])),
    [projects],
  );

  const order = useMemo(() => {
    const wanted = projects
      .filter((p) => cachedBenchThumb(p) === undefined)
      .map((p) => p.name);
    const onScreen = new Set(visible);
    return [
      ...wanted.filter((name) => onScreen.has(name)),
      ...wanted.filter((name) => !onScreen.has(name)),
    ];
    // `revs` rather than `projects`: a summary object identity changes on every
    // poll, but only a changed mtime means there is new work. `drawn` retires
    // finished benches from the queue — without it the forge never empties and
    // never unmounts.
  }, [revs, visible, drawn]);

  // Unmounted once every card is drawn: the canvas runs an always-on frameloop,
  // and an idle forge would keep rendering nothing for as long as the gallery
  // stayed open.
  const forge =
    order.length > 0 ? (
      <BenchForge order={order} revs={revs} onCaptured={onCaptured} />
    ) : null;

  return { forge, pending: order.length };
}
