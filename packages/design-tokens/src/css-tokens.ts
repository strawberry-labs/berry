/**
 * Resolves CSS custom properties from the web stylesheets into plain values a
 * native client can use. Only `:root` and `.dark` blocks at the top level are
 * read, in cascade order, mirroring how the browser layers the same files.
 */

export type ThemeName = "light" | "dark";
export type RawTokens = Record<string, string>;
export type ResolvedTheme = {
  /** Colors as `#rrggbb` or `rgba(r, g, b, a)`. */
  colors: Record<string, string>;
  /** Simple non-color values: lengths, durations, easings, numbers, font stacks. */
  values: Record<string, string>;
};

/** Collects declarations from top-level `:root` and `.dark` blocks of one stylesheet. */
export function extractThemeBlocks(css: string): { light: RawTokens; dark: RawTokens } {
  const source = stripComments(css);
  const light: RawTokens = {};
  const dark: RawTokens = {};
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{", index);
    if (open === -1) break;
    const selector = source.slice(index, open).trim().split(/[;}]/).pop()!.trim();
    const close = matchingBrace(source, open);
    if (close === -1) break;
    const body = source.slice(open + 1, close);
    if (selector === ":root") Object.assign(light, declarations(body));
    else if (selector === ".dark") Object.assign(dark, declarations(body));
    index = close + 1;
  }
  return { light, dark };
}

/** Merges stylesheets in cascade order; dark inherits every light token it does not override. */
export function cascadeThemes(sheets: string[]): { light: RawTokens; dark: RawTokens } {
  const light: RawTokens = {};
  const darkOverrides: RawTokens = {};
  for (const sheet of sheets) {
    const blocks = extractThemeBlocks(sheet);
    Object.assign(light, blocks.light);
    Object.assign(darkOverrides, blocks.dark);
  }
  return { light, dark: { ...light, ...darkOverrides } };
}

export function resolveTheme(tokens: RawTokens): ResolvedTheme {
  const colors: Record<string, string> = {};
  const values: Record<string, string> = {};
  for (const name of Object.keys(tokens).sort()) {
    const resolved = resolveVariables(tokens, name, new Set());
    if (resolved === null) continue;
    const color = evaluateColor(resolved);
    if (color) colors[name] = formatColor(color);
    else if (isSimpleValue(resolved)) values[name] = resolved;
  }
  return { colors, values };
}

function resolveVariables(tokens: RawTokens, name: string, seen: Set<string>): string | null {
  if (seen.has(name)) return null;
  const raw = tokens[name];
  if (raw === undefined) return null;
  return substitute(raw, tokens, new Set([...seen, name]));
}

function substitute(value: string, tokens: RawTokens, seen: Set<string>): string | null {
  let output = "";
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("var(", index);
    if (start === -1) {
      output += value.slice(index);
      break;
    }
    output += value.slice(index, start);
    const close = matchingParen(value, start + 3);
    if (close === -1) return null;
    const inner = value.slice(start + 4, close);
    const comma = topLevelComma(inner);
    const reference = (comma === -1 ? inner : inner.slice(0, comma)).trim().replace(/^--/, "");
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
    const resolved = resolveVariables(tokens, reference, seen) ?? (fallback === null ? null : substitute(fallback, tokens, seen));
    if (resolved === null) return null;
    output += resolved;
    index = close + 1;
  }
  return output.trim();
}

/* ------------------------------------------------------------------------ */
/* Color evaluation                                                          */
/* ------------------------------------------------------------------------ */

export type Rgba = { r: number; g: number; b: number; a: number };

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 1, g: 1, b: 1, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

export function evaluateColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();
  if (NAMED[value]) return NAMED[value]!;
  if (value.startsWith("#")) return parseHex(value);
  if (value.startsWith("rgb")) return parseRgb(value);
  if (value.startsWith("oklch(")) return parseOklch(value);
  if (value.startsWith("color-mix(")) return parseColorMix(value);
  return null;
}

export function formatColor(color: Rgba): string {
  const channel = (value: number) => Math.round(clamp(value) * 255);
  const alpha = Math.round(clamp(color.a) * 1000) / 1000;
  if (alpha >= 1) return `#${[color.r, color.g, color.b].map((value) => channel(value).toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${alpha})`;
}

function parseHex(value: string): Rgba | null {
  const hex = value.slice(1);
  if (!/^[0-9a-f]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
  const expanded = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
  const byte = (offset: number) => parseInt(expanded.slice(offset, offset + 2), 16) / 255;
  return { r: byte(0), g: byte(2), b: byte(4), a: expanded.length === 8 ? byte(6) : 1 };
}

function parseRgb(value: string): Rgba | null {
  const match = /^rgba?\((.*)\)$/.exec(value);
  if (!match) return null;
  const [channels, alphaPart] = splitAlpha(match[1]!);
  const parts = channels.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 4 && alphaPart === null) return parseRgb(`rgb(${parts.slice(0, 3).join(" ")} / ${parts[3]})`);
  if (parts.length !== 3) return null;
  const channel = (part: string) => part.endsWith("%") ? Number(part.slice(0, -1)) / 100 : Number(part) / 255;
  const [r, g, b] = parts.map(channel) as [number, number, number];
  const a = alphaPart === null ? 1 : parseAlpha(alphaPart);
  return [r, g, b, a].every(Number.isFinite) ? { r, g, b, a } : null;
}

function parseOklch(value: string): Rgba | null {
  const [channels, alphaPart] = splitAlpha(value.slice(6, -1));
  const parts = channels.split(/\s+/).filter(Boolean);
  if (parts.length !== 3) return null;
  const lightness = parts[0]!.endsWith("%") ? Number(parts[0]!.slice(0, -1)) / 100 : Number(parts[0]);
  const chroma = Number(parts[1]);
  const hue = (Number(parts[2]!.replace(/deg$/, "")) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (linear: number) => (linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.max(linear, 0) ** (1 / 2.4) - 0.055);
  return {
    r: clamp(encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp(encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp(encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
    a: alphaPart === null ? 1 : parseAlpha(alphaPart),
  };
}

/** `color-mix(in srgb, A p%, B [q%])` with premultiplied alpha, per CSS Color 5. */
function parseColorMix(value: string): Rgba | null {
  const inner = value.slice("color-mix(".length, -1);
  const parts = splitTopLevel(inner).map((part) => part.trim());
  if (parts.length !== 3 || parts[0] !== "in srgb") return null;
  const first = colorStop(parts[1]!);
  const second = colorStop(parts[2]!);
  if (!first || !second) return null;
  let p1 = first.percent;
  let p2 = second.percent;
  if (p1 === null && p2 === null) { p1 = 0.5; p2 = 0.5; }
  else if (p1 === null) p1 = 1 - p2!;
  else if (p2 === null) p2 = 1 - p1;
  const total = p1 + p2!;
  const w1 = p1 / total;
  const w2 = p2! / total;
  const alpha = first.color.a * w1 + second.color.a * w2;
  const mix = (c1: number, c2: number) => alpha === 0 ? 0 : (c1 * first.color.a * w1 + c2 * second.color.a * w2) / alpha;
  // A sum below 100% scales the result's alpha.
  const scale = Math.min(1, total);
  return { r: mix(first.color.r, second.color.r), g: mix(first.color.g, second.color.g), b: mix(first.color.b, second.color.b), a: alpha * scale };
}

function colorStop(part: string): { color: Rgba; percent: number | null } | null {
  const match = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(part);
  if (!match) return null;
  const color = evaluateColor(match[1]!);
  if (!color) return null;
  return { color, percent: match[2] === undefined ? null : Number(match[2]) / 100 };
}

function splitAlpha(channels: string): [string, string | null] {
  const slash = channels.indexOf("/");
  return slash === -1 ? [channels.trim(), null] : [channels.slice(0, slash).trim(), channels.slice(slash + 1).trim()];
}

function parseAlpha(value: string): number {
  return value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/* ------------------------------------------------------------------------ */
/* Parsing helpers                                                           */
/* ------------------------------------------------------------------------ */

function isSimpleValue(value: string): boolean {
  return value.length <= 200 && !/[{};]/.test(value) && !/\d+px\s+\d+px/.test(value) && !value.includes("color-mix(") && !value.includes("calc(");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function declarations(body: string): RawTokens {
  const tokens: RawTokens = {};
  for (const statement of splitTopLevel(body, ";")) {
    const match = /^\s*--([a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i.exec(statement);
    if (match) tokens[match[1]!] = match[2]!.replace(/\s+/g, " ");
  }
  return tokens;
}

function splitTopLevel(value: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.filter((part) => part.trim().length > 0);
}

function topLevelComma(value: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")") depth -= 1;
    else if (value[index] === "," && depth === 0) return index;
  }
  return -1;
}

function matchingBrace(value: string, open: number): number {
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    if (value[index] === "{") depth += 1;
    else if (value[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function matchingParen(value: string, open: number): number {
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
