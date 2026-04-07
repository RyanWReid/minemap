/** Convert RGB to OKLab color space (perceptual, good for nearest-neighbor matching) */
export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  // Linearize sRGB
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Squared distance between two OKLab colors */
export function oklabDistSq(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dL = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dL * dL + da * da + db * db;
}

/** Squared Euclidean distance in RGB (fast but less perceptual) */
export function rgbDistSq(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/** Apply a shade multiplier to an RGB color */
export function shadeColor(
  color: [number, number, number],
  multiplier: number,
): [number, number, number] {
  return [
    Math.min(255, Math.max(0, Math.floor(color[0] * multiplier))),
    Math.min(255, Math.max(0, Math.floor(color[1] * multiplier))),
    Math.min(255, Math.max(0, Math.floor(color[2] * multiplier))),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}
