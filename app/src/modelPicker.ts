/**
 * Which catalogue assets a part may be swapped to — the 型番 choices.
 *
 * Only holders and posts have interchangeable models today: a PH30E can become
 * a PH50E without changing what the part *is*. Everything else has one asset.
 */

/** PH30E → 30, TR75_M → 75; used to sort the list by size rather than by name. */
function modelNumber(asset: string, type: "holder" | "post"): number {
  const prefix = type === "holder" ? "PH" : "TR";
  const match = new RegExp(`(?:^|/)${prefix}(\\d+)`, "i").exec(asset);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/** The library assets offered for `type`, shortest first. Empty for other types. */
export function modelOptionsFor(library: string[], type: string): string[] {
  if (type !== "holder" && type !== "post") return [];
  const folder = type === "holder" ? "Holder/" : "Post/";
  return library
    .filter((asset) => asset.startsWith(folder))
    .sort((left, right) => modelNumber(left, type) - modelNumber(right, type));
}

/** `Holder/PH30E-Step.usda` → `PH30E`, the label a lab member reads. */
export const modelLabel = (asset: string) =>
  asset.split("/").pop()?.replace(/-Step\.usda$/, "") ?? asset;
