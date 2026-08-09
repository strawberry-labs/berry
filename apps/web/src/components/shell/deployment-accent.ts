// Leave room for three-decimal CSS serialization while staying above WCAG AA.
const MIN_TEXT_CONTRAST = 4.6;
const LIGHT_SURFACE = hexToLinearRgb("#ffffff")!;
const DARKEST_TEXT = hexToLinearRgb("#0d0d0d")!;
const LIGHTEST_DARK_SURFACE = hexToLinearRgb("#2d2d2d")!;

type LinearRgb = { r: number; g: number; b: number };
type Oklch = { l: number; c: number; h: number };

export type DeploymentAccentTokens = {
  light: string;
  dark: string;
  lightContrast: number;
  darkContrast: number;
};

export function deploymentAccentTokens(value: string | null | undefined): DeploymentAccentTokens | null {
  const rgb = value ? hexToLinearRgb(value) : null;
  if (!rgb) return null;
  const base = linearRgbToOklch(rgb);
  const light = accessibleVariant(base, LIGHT_SURFACE, "darker");
  const dark = accessibleVariant(base, LIGHTEST_DARK_SURFACE, "lighter");
  return {
    light: formatOklch(light),
    dark: formatOklch(dark),
    lightContrast: contrastRatio(light.rgb, LIGHT_SURFACE),
    darkContrast: Math.min(
      contrastRatio(dark.rgb, LIGHTEST_DARK_SURFACE),
      contrastRatio(dark.rgb, DARKEST_TEXT),
    ),
  };
}

function accessibleVariant(base: Oklch, surface: LinearRgb, direction: "darker" | "lighter") {
  const original = gamutMapped(base);
  if (contrastRatio(original.rgb, surface) >= MIN_TEXT_CONTRAST) return original;

  if (direction === "darker") {
    let passing = 0;
    let failing = base.l;
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const candidateLightness = (passing + failing) / 2;
      const candidate = gamutMapped({ ...base, l: candidateLightness });
      if (contrastRatio(candidate.rgb, surface) >= MIN_TEXT_CONTRAST) passing = candidateLightness;
      else failing = candidateLightness;
    }
    return gamutMapped({ ...base, l: passing });
  }

  let failing = base.l;
  let passing = 1;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const candidateLightness = (failing + passing) / 2;
    const candidate = gamutMapped({ ...base, l: candidateLightness });
    if (contrastRatio(candidate.rgb, surface) >= MIN_TEXT_CONTRAST) passing = candidateLightness;
    else failing = candidateLightness;
  }
  return gamutMapped({ ...base, l: passing });
}

function gamutMapped(color: Oklch): Oklch & { rgb: LinearRgb } {
  const unclamped = oklchToLinearRgb(color);
  if (inSrgbGamut(unclamped)) return { ...color, rgb: unclamped };
  let low = 0;
  let high = color.c;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const chroma = (low + high) / 2;
    if (inSrgbGamut(oklchToLinearRgb({ ...color, c: chroma }))) low = chroma;
    else high = chroma;
  }
  const mapped = { ...color, c: low };
  return { ...mapped, rgb: oklchToLinearRgb(mapped) };
}

function linearRgbToOklch(rgb: LinearRgb): Oklch {
  const l = Math.cbrt(0.4122214708 * rgb.r + 0.5363325363 * rgb.g + 0.0514459929 * rgb.b);
  const m = Math.cbrt(0.2119034982 * rgb.r + 0.6806995451 * rgb.g + 0.1073969566 * rgb.b);
  const s = Math.cbrt(0.0883024619 * rgb.r + 0.2817188376 * rgb.g + 0.6299787005 * rgb.b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, b);
  const hue = chroma < 0.000_001 ? 0 : (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  return { l: lightness, c: chroma, h: hue };
}

function oklchToLinearRgb(color: Oklch): LinearRgb {
  const hue = color.h * Math.PI / 180;
  const a = color.c * Math.cos(hue);
  const b = color.c * Math.sin(hue);
  const lRoot = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = color.l - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function hexToLinearRgb(value: string): LinearRgb | null {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return null;
  const channel = (offset: number) => {
    const encoded = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  };
  return { r: channel(1), g: channel(3), b: channel(5) };
}

function contrastRatio(left: LinearRgb, right: LinearRgb): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(rgb: LinearRgb): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function inSrgbGamut(rgb: LinearRgb): boolean {
  const epsilon = 0.000_001;
  return rgb.r >= -epsilon && rgb.r <= 1 + epsilon
    && rgb.g >= -epsilon && rgb.g <= 1 + epsilon
    && rgb.b >= -epsilon && rgb.b <= 1 + epsilon;
}

function formatOklch(color: Oklch): string {
  return `oklch(${formatNumber(color.l)} ${formatNumber(color.c)} ${formatNumber(color.h)})`;
}

function formatNumber(value: number): string {
  const formatted = value.toFixed(3).replace(/\.?0+$/, "");
  return formatted === "-0" ? "0" : formatted;
}
