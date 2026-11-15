/**
 * Human-readable identity for a catalogue asset.
 *
 * A lab member picking a part reads three things: what kind of optic it is,
 * which 型番 to order, and the one or two numbers that decide whether it fits
 * the bench (focal length, clear aperture, length). `Lens/LA1417-AB-Step.usda`
 * on its own tells them none of that.
 */
import type { Component } from "../types";

/** `Lens/LA1417-AB-Step.usda` → `Lens`; a bare asset falls into "Components". */
export function partCategory(asset: string): string {
  const parts = asset.split("/");
  return parts.length > 1 ? parts[0] : "Components";
}

/** `Lens/LA1417-AB-Step.usda` → `LA1417-AB`, `Low_model/lens_f100.usda` → `Lens F100`. */
export function partModel(asset: string): string {
  const bare = (asset.split("/").pop() ?? asset)
    .replace(/\.usda$/i, "")
    .replace(/-Step$/i, "");
  // The generated Low_model parts are named in lower snake_case rather than by
  // a catalogue number, so they read better title-cased: `camera` as well as
  // `lens_f100`, or the two sit side by side in the browser looking unrelated.
  if (!/[A-Z]/.test(bare)) {
    return bare
      .split("_")
      .filter(Boolean)
      .map((word) => (
        ACRONYMS.has(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)
      ))
      .join(" ");
  }
  return bare;
}

const ACRONYMS = new Set(["slm", "led"]);

/** The folder of generated stand-in parts; its name is not one to show people. */
export const GENERATED_CATEGORY = "Low_model";

/**
 * A placed part's name as a person reads it: `LA1417_AB_Step_2` → `LA1417_AB (2)`.
 *
 * Prim names carry the CAD import's `_Step` suffix and a `_2`, `_3` for each
 * copy, so the outliner read like a file listing. The prim name itself is
 * unchanged (it is the part's identity in USD); show it in a tooltip.
 */
export function displayName(name: string): string {
  const m = /^(.*?)(?:_Step)?(?:_(\d+))?$/i.exec(name);
  if (!m || !m[1]) return name;
  return m[2] ? `${m[1]} (${m[2]})` : m[1];
}

function mm(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function numeric(component: Component, key: string): number | null {
  const value = component.attrs?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The short spec chips under a tile — at most three, most-decisive first, so
 * two lenses of the same 型番 family are still told apart at a glance.
 */
export function partSpecs(component: Component | undefined): string[] {
  if (!component) return [];
  const specs: string[] = [];
  const focal = numeric(component, "focalLength_mm");
  if (focal !== null) specs.push(`f = ${mm(focal)} mm`);

  const diameter =
    numeric(component, "diameter_mm") ?? numeric(component, "outerDiameter_mm");
  if (diameter !== null) specs.push(`Ø${mm(diameter)} mm`);

  const wavelength = numeric(component, "wavelength_nm");
  if (wavelength !== null) specs.push(`${mm(wavelength)} nm`);

  // Only when the optical numbers haven't already said enough: an f and a Ø
  // identify a lens, and adding its envelope wraps the line onto a third row.
  if (specs.length < 2) {
    // The whole envelope, X × Y × Z, rather than one picked dimension. Reporting
    // just sizeX gave every post holder "L 38 mm" — its footprint depth, which
    // barely moves across the family — while the number that tells a PH20E from
    // a PH50E is the height. Picking the longest side instead labelled the same
    // family inconsistently. Three numbers in bench axes are unambiguous.
    const envelope = [
      numeric(component, "sizeX_mm"),
      numeric(component, "sizeY_mm"),
      numeric(component, "sizeZ_mm"),
    ];
    if (envelope.every((value): value is number => value !== null)) {
      specs.push(`${envelope.map(mm).join(" × ")} mm`);
    } else {
      const length = numeric(component, "length_mm") ?? envelope[0];
      if (length !== null) specs.push(`L ${mm(length)} mm`);
    }
  }
  return specs.slice(0, 3);
}

/** Everything a search box should match: 型番, category, type and specs. */
export function partSearchText(asset: string, component?: Component): string {
  return [
    asset,
    partModel(asset),
    partCategory(asset),
    component?.type ?? "",
    ...partSpecs(component),
  ]
    .join(" ")
    .toLowerCase();
}
