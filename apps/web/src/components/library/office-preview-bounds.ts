import type { OfficePreviewKind } from "./office-preview-types";

export function requiredOfficeEntries(kind: OfficePreviewKind): readonly string[] {
  if (kind === "docx") return ["[Content_Types].xml", "word/document.xml"];
  if (kind === "pptx") return ["[Content_Types].xml", "ppt/presentation.xml"];
  return ["[Content_Types].xml", "xl/workbook.xml"];
}

export function hasRequiredOfficeEntries(kind: OfficePreviewKind, names: ReadonlySet<string>): boolean {
  return requiredOfficeEntries(kind).every((name) => names.has(name));
}

export function hasExternalMediaRelationship(xml: string, sourceXml = ""): boolean {
  const relationships = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = relationships.exec(xml))) {
    const tag = match[0];
    const relationshipId = decodeXmlEntities(tag.match(/\bId\s*=\s*["']([^"']+)["']/i)?.[1] ?? "");
    const relationshipType = decodeXmlEntities(tag.match(/\bType\s*=\s*["']([^"']+)["']/i)?.[1] ?? "");
    const targetMode = tag.match(/TargetMode\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    const target = tag.match(/Target\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    const externalMode = decodeXmlEntities(targetMode).trim().toLowerCase() === "external";
    const decodedTarget = decodeXmlEntities(target).trim();
    const absoluteTarget = /^(?:https?:|data:|\/\/)/i.test(decodedTarget);
    const mediaType = /(?:image|video|audio|media)/i.test(relationshipType);
    const mediaTarget = !/hyperlink/i.test(relationshipType) && /\.(?:avif|bmp|gif|jpe?g|png|svg|webp|mp4|webm|mov|mp3|wav)(?:[?#].*)?$/i.test(decodedTarget);
    const referencedByMedia = relationshipId.length > 0 && sourceReferencesMedia(decodeXmlEntities(sourceXml), relationshipId);
    // Hyperlinks are harmless to the renderer when they remain ordinary
    // <a> targets, but media relationships are dereferenced as <img>/<video>
    // sources. Match both declared media Types and the relationship ID used by
    // a:blip/video/audio nodes so a custom Type cannot smuggle remote media.
    if ((mediaType || mediaTarget || referencedByMedia) && (externalMode || absoluteTarget)) return true;
  }
  return false;
}

export function hasUnboundedEmbeddedMediaRelationship(xml: string, sourceXml = ""): boolean {
  const relationships = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  const normalizedSourceXml = decodeXmlEntities(sourceXml);
  while ((match = relationships.exec(xml))) {
    const tag = match[0];
    const relationshipId = decodeXmlEntities(tag.match(/\bId\s*=\s*["']([^"']+)["']/i)?.[1] ?? "");
    const relationshipType = decodeXmlEntities(tag.match(/\bType\s*=\s*["']([^"']+)["']/i)?.[1] ?? "");
    const targetMode = decodeXmlEntities(tag.match(/TargetMode\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").trim().toLowerCase();
    const target = decodeXmlEntities(tag.match(/Target\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").trim();
    const external = targetMode === "external" || /^(?:https?:|data:|\/\/)/i.test(target);
    if (external) continue;
    const mediaType = /(?:image|video|audio|media)/i.test(relationshipType);
    const referencedByMedia = relationshipId.length > 0 && sourceReferencesMedia(normalizedSourceXml, relationshipId);
    if (/hyperlink/i.test(relationshipType) && !referencedByMedia) continue;
    if ((mediaType || referencedByMedia) && !/\.(?:avif|gif|ico|jpe?g|png|webp)$/i.test(target)) return true;
  }
  return false;
}

export function hasUnsafeDocxMarkup(xml: string): boolean {
  // docx-preview maps legacy VML styles directly into SVG/CSS. Reject those
  // constructs instead of allowing an uploaded document to request remote
  // resources through url(), behavior, or expression CSS.
  const normalized = decodeXmlEntities(xml);
  return /<(?:[A-Za-z_][\w.-]*:)?pict\b/i.test(normalized)
    || /<(?:[A-Za-z_][\w.-]*:)?shape\b/i.test(normalized)
    || /\bstyle\s*=\s*["'][^"']*(?:url\s*\(|expression\s*\(|behavior\s*:)/i.test(normalized);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceReferencesMedia(sourceXml: string, relationshipId: string): boolean {
  const id = escapeRegExp(relationshipId);
  return new RegExp(`<[^>]*(?:[A-Za-z_][\\w.-]*:)?(?:blip|videoFile|audioFile|imagedata)\\b[^>]*\\b(?:[A-Za-z_][\\w.-]*:)?(?:link|embed|id)\\s*=\\s*["']${id}["']`, "i").test(sourceXml);
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function countPptxSlideIds(xml: string, maxSlides: number): number {
  const slideIds = /<[^>]*sldId(?:\s|>)/gi;
  let count = 0;
  while (slideIds.exec(xml)) {
    count += 1;
    if (count > maxSlides) return count;
  }
  return count;
}

export function countDocxPages(xml: string, maxPages: number): number {
  const normalized = decodeXmlEntities(xml);
  let breaks = 0;
  const pageBreakPattern = /<(?:[A-Za-z_][\w.-]*:)?br\b[^>]*?(?:[A-Za-z_][\w.-]*:)?type\s*=\s*["']page["'][^>]*\/?>|<(?:[A-Za-z_][\w.-]*:)?lastRenderedPageBreak\b[^>]*\/?>/gi;
  while (pageBreakPattern.exec(normalized)) {
    breaks += 1;
    if (breaks + 1 > maxPages) return maxPages + 1;
  }
  let structuralUnits = 0;
  const structuralPattern = /<[^>]*(?:[A-Za-z_][\w.-]*:)?(?:p|tr|drawing|object|pict)\b[^>]*>/gi;
  while (structuralPattern.exec(normalized)) {
    structuralUnits += 1;
    if (structuralUnits > maxPages * 40) return maxPages + 1;
  }
  // A single paragraph can still contain an enormous number of runs/text
  // nodes. Those nodes are expensive for docx-preview even when the visible
  // text and page estimate are small, so keep XML/DOM complexity bounded too.
  let renderNodes = 0;
  const renderNodePattern = /<[^>]*(?:[A-Za-z_][\w.-]*:)?(?:r|t|tbl|tc|hyperlink|fldSimple)\b[^>]*>/gi;
  while (renderNodePattern.exec(normalized)) {
    renderNodes += 1;
    if (renderNodes > maxPages * 400) return maxPages + 1;
  }
  const visibleTextLength = normalized.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  return Math.max(1, breaks + 1, Math.ceil(structuralUnits / 40), Math.ceil(visibleTextLength / 3_000));
}
