/**
 * A company's brand colour as the back-office's accent (RFC 0018 §4.5). Only its hue and chroma are used: the
 * themes fix the accent's lightness (light: dark enough for white text; dark: light enough for dark text), so any
 * brand colour keeps text on buttons and links readable (WCAG AA) in both.
 */

/** OKLCH of an sRGB hex colour (`#4f46e5` → `{ l, c, h }`), or null when it is not one. */
export function hexToOklch(hex: string): { l: number; c: number; h: number } | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) return null;
  const linear = (v: string) => {
    const x = Number.parseInt(v, 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [linear(m[1] as string), linear(m[2] as string), linear(m[3] as string)];
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.sqrt(A * A + B * B);
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c, h: h < 0 ? h + 360 : h };
}

/** The CSS variables a brand colour sets (`--accent-h`, `--accent-c`), or none for the default accent. */
export function accentVariables(hex: string | null | undefined): Record<string, string> {
  const color = hex === null || hex === undefined ? null : hexToOklch(hex);
  if (color === null) return {};
  // Chroma is capped (very saturated colours glare as large surfaces); greys stay grey.
  return {
    '--accent-h': color.h.toFixed(1),
    '--accent-c': Math.min(color.c, 0.2).toFixed(3),
  };
}
