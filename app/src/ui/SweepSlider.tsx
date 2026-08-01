import { useEffect, useState } from "react";

/**
 * A drag bar with a ball handle, plus the exact number beside it.
 *
 * Beam widths are a judgement call — you want to see the tube fatten while you
 * drag, not guess a millimetre figure and nudge a spinner arrow. The number
 * stays editable for when a real value is known (a 6 mm collimated output),
 * and typing past the bar's range widens the bar instead of clamping the value.
 */
export default function SweepSlider({
  label, value, min, max, step, unit = "mm", title, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  title?: string;
  onChange: (value: number) => void;
}) {
  const decimals = step < 1 ? 1 : 0;
  const show = (v: number) => v.toFixed(decimals);

  // Local echo so a half-typed number ("0.", "") survives the round trip to USD.
  const [draft, setDraft] = useState(() => show(value));
  useEffect(() => setDraft(show(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const top = Math.max(max, value);
  const fill = ((value - min) / (top - min || 1)) * 100;

  function commit(raw: string) {
    setDraft(raw);
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < min) return;
    if (Math.abs(parsed - value) < step / 2) return;
    onChange(parsed);
  }

  return (
    <div className="sweep" title={title}>
      <div className="sweep-head">
        <span className="sweep-label">{label}</span>
        <input
          className="sweep-value"
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => setDraft(show(value))}
        />
        <span className="sweep-unit">{unit}</span>
      </div>
      <input
        className="sweep-range"
        type="range"
        min={min}
        max={top}
        step={step}
        value={value}
        style={{ ["--fill" as string]: `${fill}%` }}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}
