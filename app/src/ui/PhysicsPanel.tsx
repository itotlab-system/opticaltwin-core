import type { ParaxialSegment } from "../types";

function fmt(v: number | undefined, digits = 3): string {
  if (v === undefined) return "—";
  return v.toFixed(digits);
}

function fmtMm(v: number | undefined): string {
  if (v === undefined) return "—";
  // show in µm when < 0.1 mm for readability
  if (v < 0.1) return `${(v * 1000).toFixed(1)} µm`;
  return `${v.toFixed(2)} mm`;
}

export default function PhysicsPanel({ segments }: { segments: ParaxialSegment[] }) {
  if (!segments.length) return null;

  // All segments share the same input beam (info from first segment)
  const info0 = segments[0].info;

  return (
    <div className="physics-panel">
      <div className="section-title">Beam physics</div>

      {/* ---- global input beam stats ---- */}
      <div className="physics-block">
        <div className="physics-row">
          <span className="physics-label">Fiber waist w₀</span>
          <span className="physics-value">{fmtMm(info0.w0_mm)}</span>
        </div>
        <div className="physics-row">
          <span className="physics-label">Rayleigh range z_R</span>
          <span className="physics-value">{fmtMm(info0.z_R0_mm)}</span>
        </div>
        <div className="physics-row">
          <span className="physics-label">Divergence (half-angle)</span>
          <span className="physics-value">{fmt(info0.divergence_input_mrad)} mrad</span>
        </div>
      </div>

      {/* ---- per-segment element tables ---- */}
      {segments.map((seg, si) => (
        <div key={si} className="physics-block">
          {segments.length > 1 && (
            <div className="physics-seg-label">
              Segment {si + 1} — {seg.wavelength} nm
            </div>
          )}
          <table className="physics-table">
            <thead>
              <tr>
                <th>Element</th>
                <th>w in</th>
                <th>w out / focus</th>
                <th>z_R / θ</th>
              </tr>
            </thead>
            <tbody>
              {seg.info.elements.map((el, ei) => (
                <tr key={ei} className={el.w_out_mm !== undefined ? "row-lens" : ""}>
                  <td>
                    <span className="el-name">{el.name}</span>
                    <span className="el-type">{el.type}</span>
                  </td>
                  <td>{fmtMm(el.w_in_mm)}</td>
                  <td>
                    {el.w_out_mm !== undefined ? (
                      <>
                        <div>{fmtMm(el.w_out_mm)}</div>
                        {el.z_waist_mm !== undefined && (
                          <div className="sub">
                            focus {el.z_waist_mm > 0 ? "+" : ""}
                            {el.z_waist_mm.toFixed(0)} mm
                          </div>
                        )}
                        {el.w_waist_mm !== undefined && (
                          <div className="sub">w = {fmtMm(el.w_waist_mm)}</div>
                        )}
                      </>
                    ) : "—"}
                  </td>
                  <td>
                    {el.z_R_after_mm !== undefined ? (
                      <>
                        <div>{fmtMm(el.z_R_after_mm)}</div>
                        {el.divergence_after_mrad !== undefined && (
                          <div className="sub">
                            {fmt(el.divergence_after_mrad)} mrad
                          </div>
                        )}
                      </>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="physics-row final">
            <span className="physics-label">Spot at detector</span>
            <span className="physics-value">{fmtMm(seg.info.w_final_mm)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
