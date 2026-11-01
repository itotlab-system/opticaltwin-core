import { Html, Line } from "@react-three/drei";
import type { BeamSegment, Component } from "../types";
import { FOLD_TYPES } from "../beamFirst";
import type { Turn } from "../beamFirst";
import { useSettings } from "../settings";

// How far out from the mirror the two "send the beam here" targets float.
const REACH_MM = 70;

/**
 * Fold targets for a selected mirror or beamsplitter that the beam reaches.
 *
 * Two markers float where the beam would go — one on each side of the
 * incoming beam — and clicking one turns the part to send it there. They are
 * placed in the scene rather than labelled "left" / "right", because which
 * side is "left" depends on where the camera is and the user is looking at
 * the bench, not at a compass.
 */
export default function FoldArrows({
  component, beam, onFold,
}: {
  component: Component;
  beam: BeamSegment[];
  onFold: (name: string, turn: Turn) => void;
}) {
  const { t } = useSettings();
  if (!FOLD_TYPES.has(component.type)) return null;
  const incoming = beam.find((leg) => leg.to === component.name);
  if (!incoming) return null;
  const a = incoming.pts[0];
  const b = incoming.pts[incoming.pts.length - 1];
  const plan = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (plan < 1e-6) return null;
  const d = [(b[0] - a[0]) / plan, (b[1] - a[1]) / plan];
  const hit = b;

  // The way the beam leaves now, to mark the current choice.
  const leaving = beam
    .filter((leg) => leg.from === component.name)
    .map((leg) => {
      const s = leg.pts[0];
      const e = leg.pts[leg.pts.length - 1];
      const n = Math.hypot(e[0] - s[0], e[1] - s[1]) || 1;
      return [(e[0] - s[0]) / n, (e[1] - s[1]) / n];
    });

  const turns: Turn[] = ["left", "right"];
  return (
    <>
      {turns.map((turn) => {
        const sign = turn === "left" ? 1 : -1;
        const out = [-sign * d[1], sign * d[0]];
        const target: [number, number, number] = [
          hit[0] + out[0] * REACH_MM, hit[1] + out[1] * REACH_MM, hit[2],
        ];
        const current = leaving.some((v) => v[0] * out[0] + v[1] * out[1] > 0.99);
        return (
          <group key={turn}>
            {!current && (
              <Line
                points={[[hit[0], hit[1], hit[2]], target]}
                color="#7aa2ff" lineWidth={1.5} dashed dashSize={4} gapSize={3}
              />
            )}
            <Html position={target} center zIndexRange={[45, 35]}>
              <button
                className={current ? "fold-target current" : "fold-target"}
                data-testid={`fold-${turn}`}
                disabled={current}
                title={t(turn === "left" ? "fold_left" : "fold_right")}
                onClick={(e) => { e.stopPropagation(); onFold(component.name, turn); }}
              >
                {current ? "●" : "◎"}
                <span>{current ? t("fold_current") : t("fold_send")}</span>
              </button>
            </Html>
          </group>
        );
      })}
    </>
  );
}
