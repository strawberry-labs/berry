import * as React from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text as NativeText, View, type TextStyle, type ViewStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Image, type ImageLoadEventData } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import { useTheme, type Theme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { Check, Copy } from "../../ui/icons";
import { Text } from "../../ui/text";
import {
  advanceMarkdownStream,
  parseMarkdown,
  type MarkdownAlign,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownStreamState,
  type MarkdownTableCell,
} from "./parse";

/*
 * Native port of desktop-ui's `berry-markdown.tsx` (the web's assistant
 * message renderer): same block spacing, heading scale, code block chrome,
 * inline code chip, blockquote rail, and table frame, drawn with RN views and
 * nested <Text> runs so prose stays selectable.
 */

export type MarkdownTone = "primary" | "secondary";

export type MarkdownProps = {
  children: string;
  /** Streaming: settled blocks are parsed once, only the growing tail re-parses. */
  live?: boolean | undefined;
  tone?: MarkdownTone | undefined;
  /** Tool output and descriptions: 13px text and tighter block spacing. */
  compact?: boolean | undefined;
};

export const Markdown = React.memo(function Markdown({ children, live = false, tone = "primary", compact = false }: MarkdownProps) {
  const theme = useTheme();
  const styles = React.useMemo(() => createStyles(theme, tone, compact), [theme, tone, compact]);
  const ctx = React.useMemo<RenderContext>(() => contextFor(styles, styles.color), [styles]);
  const blocks = useMarkdownBlocks(children, live);
  if (blocks.length === 0) return null;
  return (
    <View style={styles.root}>
      <BlockList blocks={blocks} ctx={ctx} container="root" />
    </View>
  );
});

/* ------------------------------------------------------------------------ */
/* Parsing hooks                                                              */
/* ------------------------------------------------------------------------ */

const NO_BLOCKS: readonly MarkdownBlock[] = [];

function useMarkdownBlocks(text: string, live: boolean): readonly MarkdownBlock[] {
  // Under load React may skip intermediate token renders; settled text is never deferred.
  const deferred = React.useDeferredValue(text);
  const committed = React.useRef<MarkdownStreamState | null>(null);
  // Advance from the last *committed* state so a discarded concurrent render
  // never leaves the stream ahead of what is on screen.
  const stream = React.useMemo(() => (live ? advanceMarkdownStream(committed.current, deferred) : null), [live, deferred]);
  const settled = React.useMemo(() => (live ? null : parseMarkdown(text)), [live, text]);
  React.useEffect(() => {
    committed.current = stream;
  }, [stream]);
  return stream?.blocks ?? settled?.blocks ?? NO_BLOCKS;
}

/* ------------------------------------------------------------------------ */
/* Styles                                                                     */
/* ------------------------------------------------------------------------ */

type Spacing = {
  paragraph: number;
  headingTop: number;
  headingBottom: number;
  block: number;
  nestedList: number;
  listItem: number;
  quoteParagraph: number;
};

type MarkdownStyles = ReturnType<typeof createStyles>;

type RenderContext = {
  styles: MarkdownStyles;
  /** Current run color: the tone, or muted inside a blockquote. */
  color: string;
  text: TextStyle;
};

function contextFor(styles: MarkdownStyles, color: string): RenderContext {
  return { styles, color, text: { ...styles.body, color } };
}

function createStyles(theme: Theme, tone: MarkdownTone, compact: boolean) {
  const { colors, tokens, typography, fontWeight, fontFamily } = theme;
  // Web: assistant prose is 14/22 (`typography.message`); tool output 13px (`typography.code` metrics).
  const body = compact
    ? { fontSize: typography.code.fontSize, lineHeight: typography.code.lineHeight }
    : { fontSize: typography.message.fontSize, lineHeight: typography.message.lineHeight };
  // Codex rule used across Berry: heading leading = size + 8.
  const heading = (fontSize: number, weight: keyof Theme["fontWeight"]): TextStyle => ({ fontSize, lineHeight: fontSize + 8, fontWeight: fontWeight[weight] });
  const spacing: Spacing = compact
    ? { paragraph: 8, headingTop: 12, headingBottom: 8, block: 10, nestedList: 4, listItem: 4, quoteParagraph: 6 }
    : // Web: p my-3, h* mt-6 mb-4, pre/table/blockquote/hr my-4, nested lists my-1.5, li space-y-1.5, quote p+p mt-2.
      { paragraph: 12, headingTop: 24, headingBottom: 16, block: 16, nestedList: 6, listItem: 6, quoteParagraph: 8 };
  const panelRadius = 12; // rounded-xl
  const frameBorder = { borderWidth: 1, borderColor: colors.border };
  return {
    theme,
    spacing,
    body,
    color: tone === "secondary" ? colors.textSecondary : colors.textPrimary,
    /** Web `text-muted-foreground`: blockquotes, code language label. */
    muted: colors.textTertiary,
    /** Web `text-muted-foreground/70`: list markers, table headers. */
    faint: colors.textFaint,
    headings: {
      1: heading(compact ? 15 : 18, "semibold"),
      2: heading(compact ? 14 : 16, "semibold"),
      3: heading(body.fontSize, "semibold"),
      4: heading(body.fontSize, "semibold"),
      5: heading(body.fontSize, "medium"),
      6: heading(body.fontSize, "body"),
    } satisfies Record<1 | 2 | 3 | 4 | 5 | 6, TextStyle>,
    strong: { fontWeight: fontWeight.medium } satisfies TextStyle,
    emphasis: { fontStyle: "italic" } satisfies TextStyle,
    del: { textDecorationLine: "line-through" } satisfies TextStyle,
    link: { color: tokens.primary, fontWeight: fontWeight.medium, textDecorationLine: "underline" } satisfies TextStyle,
    inlineCode: { fontFamily: fontFamily.mono, fontSize: body.fontSize - 1, backgroundColor: colors.surfaceInset } satisfies TextStyle,
    root: { minWidth: 0 } satisfies ViewStyle,
    rule: { height: 1, backgroundColor: colors.border } satisfies ViewStyle,
    quote: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 12 } satisfies ViewStyle,
    panel: { ...frameBorder, borderRadius: panelRadius, backgroundColor: colors.surfaceInset, overflow: "hidden" } satisfies ViewStyle,
    codeHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingLeft: 12, paddingRight: 4, paddingVertical: 4 } satisfies ViewStyle,
    codeLabel: { flexShrink: 1, color: colors.textTertiary, textTransform: "lowercase" } satisfies TextStyle,
    codeScroll: { paddingHorizontal: 12, paddingBottom: 12 } satisfies ViewStyle,
    mathScroll: { padding: 12 } satisfies ViewStyle,
    tableFrame: { ...frameBorder, borderRadius: panelRadius, overflow: "hidden" } satisfies ViewStyle,
    tableRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border } satisfies ViewStyle,
    tableCell: { paddingHorizontal: 12, paddingVertical: 8 } satisfies ViewStyle,
    tableText: { fontSize: typography.code.fontSize, lineHeight: typography.code.lineHeight } satisfies TextStyle,
    marker: { ...body, color: colors.textFaint, fontVariant: ["tabular-nums"] } satisfies TextStyle,
    checkbox: { width: 14, height: 14, borderRadius: 4, borderWidth: 1.5, alignItems: "center", justifyContent: "center", borderColor: colors.textFaint } satisfies ViewStyle,
    checkboxChecked: { backgroundColor: tokens.primary, borderColor: tokens.primary } satisfies ViewStyle,
    checkColor: tokens["primary-foreground"],
    image: { borderRadius: panelRadius, backgroundColor: colors.surfaceInset } satisfies ViewStyle,
  };
}

/* ------------------------------------------------------------------------ */
/* Blocks                                                                     */
/* ------------------------------------------------------------------------ */

type Container = "root" | "item" | "quote";

function BlockList({ blocks, ctx, container }: { blocks: readonly MarkdownBlock[]; ctx: RenderContext; container: Container }) {
  return blocks.map((block, index) => (
    <BlockView
      // Index keys keep the streaming tail mounted as it grows; the type guards against reuse across kinds.
      key={`${index}:${block.type}`}
      block={block}
      ctx={ctx}
      marginTop={index === 0 ? 0 : gapBetween(blocks[index - 1]!, block, ctx.styles.spacing, container)}
    />
  ));
}

/** CSS margins collapse; RN's do not, so the gap is the larger of the two neighbours' margins. */
function gapBetween(previous: MarkdownBlock, next: MarkdownBlock, spacing: Spacing, container: Container): number {
  const gap = Math.max(margins(previous, spacing, container)[1], margins(next, spacing, container)[0]);
  if (container === "item") return Math.max(gap, spacing.listItem);
  if (container === "quote") return Math.max(gap, spacing.quoteParagraph);
  return gap;
}

function margins(block: MarkdownBlock, spacing: Spacing, container: Container): [number, number] {
  switch (block.type) {
    case "paragraph":
    case "html":
      // Web: `li > p` and blockquote paragraphs have no margin.
      return container === "root" ? [spacing.paragraph, spacing.paragraph] : [0, 0];
    case "heading":
      return [spacing.headingTop, spacing.headingBottom];
    case "list":
      return container === "item" ? [spacing.nestedList, spacing.nestedList] : [spacing.paragraph, spacing.paragraph];
    default:
      return [spacing.block, spacing.block];
  }
}

type BlockViewProps = { block: MarkdownBlock; ctx: RenderContext; marginTop: number };

/** Top margin only; RN Text and View both accept it. */
type Spacer = { marginTop: number } | null;

/** One memoized view per block: unchanged source (same hash) never re-renders, even across re-parses. */
const BlockView = React.memo(
  function BlockView({ block, ctx, marginTop }: BlockViewProps) {
    const spacing: Spacer = marginTop > 0 ? { marginTop } : null;
    switch (block.type) {
      case "paragraph":
        return <Paragraph inlines={block.children} ctx={ctx} style={spacing} />;
      case "heading":
        return (
          <Text variant="message" selectable accessibilityRole="header" style={[ctx.text, ctx.styles.headings[block.level], spacing]}>
            {renderInlines(block.children, ctx)}
          </Text>
        );
      case "code":
        return <CodeBlock code={block.value} language={block.lang} ctx={ctx} style={spacing} />;
      case "math":
        return <MathBlock value={block.value} ctx={ctx} style={spacing} />;
      case "blockquote":
        return <Blockquote blocks={block.children} ctx={ctx} style={spacing} />;
      case "list":
        return <List block={block} ctx={ctx} style={spacing} />;
      case "table":
        return <Table block={block} ctx={ctx} style={spacing} />;
      case "thematicBreak":
        return <View accessibilityRole="none" style={[ctx.styles.rule, spacing]} />;
      case "html":
        return (
          <Text variant="message" selectable style={[ctx.text, spacing]}>
            {block.value.trim()}
          </Text>
        );
      default:
        return null;
    }
  },
  (previous, next) =>
    previous.block.hash === next.block.hash &&
    previous.ctx === next.ctx &&
    previous.marginTop === next.marginTop,
);

type ParagraphRun = { kind: "text"; inlines: MarkdownInline[] } | { kind: "image"; url: string; alt: string; href: string | null };

/** Images are block-level on phones: split them out of the text flow. */
function paragraphRuns(inlines: readonly MarkdownInline[]): ParagraphRun[] {
  const runs: ParagraphRun[] = [];
  let pending: MarkdownInline[] = [];
  const flush = () => {
    if (pending.some((inline) => inline.type !== "break" && !(inline.type === "text" && !inline.value.trim()))) {
      runs.push({ kind: "text", inlines: pending });
    }
    pending = [];
  };
  for (const inline of inlines) {
    const linkedImages =
      inline.type === "link" &&
      inline.children.some((child) => child.type === "image") &&
      inline.children.every((child) => child.type === "image" || (child.type === "text" && !child.value.trim()));
    if (inline.type === "image" || linkedImages) {
      flush();
      if (inline.type === "image") runs.push({ kind: "image", url: inline.url, alt: inline.alt, href: null });
      else for (const child of inline.children) if (child.type === "image") runs.push({ kind: "image", url: child.url, alt: child.alt, href: inline.url });
    } else {
      pending.push(inline);
    }
  }
  flush();
  return runs;
}

function Paragraph({ inlines, ctx, style }: { inlines: readonly MarkdownInline[]; ctx: RenderContext; style: Spacer }) {
  const mayHaveImage = inlines.some((inline) => inline.type === "image" || inline.type === "link");
  const runs = mayHaveImage ? paragraphRuns(inlines) : null;
  if (!runs || (runs.length === 1 && runs[0]!.kind === "text")) {
    return (
      <Text variant="message" selectable style={[ctx.text, style]}>
        {renderInlines(inlines, ctx)}
      </Text>
    );
  }
  return (
    <View style={[{ gap: ctx.styles.spacing.listItem }, style]}>
      {runs.map((run, index) =>
        run.kind === "text" ? (
          <Text key={index} variant="message" selectable style={ctx.text}>
            {renderInlines(run.inlines, ctx)}
          </Text>
        ) : (
          <MarkdownImage key={index} url={run.url} alt={run.alt} href={run.href} ctx={ctx} />
        ),
      )}
    </View>
  );
}

function Blockquote({ blocks, ctx, style }: { blocks: readonly MarkdownBlock[]; ctx: RenderContext; style: Spacer }) {
  const quoteCtx = React.useMemo(() => contextFor(ctx.styles, ctx.styles.muted), [ctx.styles]);
  return (
    <View style={[ctx.styles.quote, style]}>
      <BlockList blocks={blocks} ctx={quoteCtx} container="quote" />
    </View>
  );
}

/* ------------------------------------------------------------------------ */
/* Lists                                                                      */
/* ------------------------------------------------------------------------ */

const BULLET_GUTTER = 20; // Web `ul` pl-5.
const ITEM_INSET = 4; // Web `li` pl-1.

function List({ block, ctx, style }: { block: Extract<MarkdownBlock, { type: "list" }>; ctx: RenderContext; style: Spacer }) {
  const { styles } = ctx;
  const lastNumber = block.start + block.items.length - 1;
  // Ordered markers hang right-aligned so the dots line up (web: list-inside decimal).
  const gutter = block.ordered ? Math.max(BULLET_GUTTER, Math.ceil(`${lastNumber}.`.length * styles.body.fontSize * 0.62)) : BULLET_GUTTER;
  return (
    <View style={[{ gap: styles.spacing.listItem }, style]}>
      {block.items.map((item, index) => (
        <View key={index} style={listStyles.item}>
          <View style={[listStyles.marker, { width: gutter, minHeight: styles.body.lineHeight }]}>
            {item.checked !== null ? (
              <View
                accessible
                accessibilityRole="checkbox"
                accessibilityState={{ checked: item.checked }}
                style={[styles.checkbox, item.checked && styles.checkboxChecked]}
              >
                {item.checked ? <Check size={10} strokeWidth={2.5} color={styles.checkColor} /> : null}
              </View>
            ) : (
              <NativeText
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={[styles.marker, { textAlign: block.ordered ? "right" : "center", width: gutter }]}
              >
                {block.ordered ? `${block.start + index}.` : "•"}
              </NativeText>
            )}
          </View>
          <View style={listStyles.content}>
            <BlockList blocks={item.children} ctx={ctx} container="item" />
          </View>
        </View>
      ))}
    </View>
  );
}

const listStyles = StyleSheet.create({
  item: { flexDirection: "row" },
  marker: { alignItems: "center", justifyContent: "center", alignSelf: "flex-start" },
  content: { flex: 1, minWidth: 0, paddingLeft: ITEM_INSET },
});

/* ------------------------------------------------------------------------ */
/* Code and math                                                              */
/* ------------------------------------------------------------------------ */

/** A styled run inside a code line. v1 is monochrome; a highlighter fills `color`/`fontStyle`. */
export type CodeToken = { content: string; color?: string | undefined; fontStyle?: "normal" | "italic" | undefined; fontWeight?: TextStyle["fontWeight"] | undefined };
export type CodeLine = CodeToken[];

/**
 * Syntax highlighting seam. Returns styled lines, or `null` to render the code
 * as one plain run (cheapest for long blocks). Must stay synchronous and cheap:
 * it runs on every streaming update of an open fence.
 */
function highlightCode(_code: string, _language: string): CodeLine[] | null {
  return null;
}

const COPIED_RESET_MS = 1500;

function CodeBlock({ code, language, ctx, style }: { code: string; language: string | null; ctx: RenderContext; style: Spacer }) {
  const { styles } = ctx;
  const label = (language ?? "").trim().toLowerCase() || "text";
  const lines = React.useMemo(() => highlightCode(code, label), [code, label]);
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = React.useCallback(() => {
    void Clipboard.setStringAsync(code).then(() => setCopied(true), () => undefined);
  }, [code]);
  return (
    <View style={[styles.panel, style]}>
      <View style={styles.codeHeader}>
        <Text variant="secondary" numberOfLines={1} style={styles.codeLabel}>
          {label}
        </Text>
        <Button variant="ghost" size="icon-sm" haptic icon={copied ? Check : Copy} accessibilityLabel={copied ? "Copied" : "Copy code"} onPress={copy} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <Text variant="code" mono selectable style={{ color: ctx.color }}>
          {lines ? renderCodeLines(lines) : code}
        </Text>
      </ScrollView>
    </View>
  );
}

function renderCodeLines(lines: readonly CodeLine[]): React.ReactNode[] {
  return lines.map((line, lineIndex) => (
    <React.Fragment key={lineIndex}>
      {line.map((token, tokenIndex) =>
        token.color || token.fontStyle || token.fontWeight ? (
          <NativeText
            key={tokenIndex}
            style={{
              ...(token.color ? { color: token.color } : {}),
              ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}),
              ...(token.fontWeight ? { fontWeight: token.fontWeight } : {}),
            }}
          >
            {token.content}
          </NativeText>
        ) : (
          token.content
        ),
      )}
      {lineIndex < lines.length - 1 ? "\n" : null}
    </React.Fragment>
  ));
}

/** Display math: the TeX source in mono (no KaTeX on native yet). */
function MathBlock({ value, ctx, style }: { value: string; ctx: RenderContext; style: Spacer }) {
  return (
    <View style={[ctx.styles.panel, style]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ctx.styles.mathScroll}>
        <Text variant="code" mono selectable accessibilityLabel={`Math: ${value}`} style={{ color: ctx.color }}>
          {value}
        </Text>
      </ScrollView>
    </View>
  );
}

/* ------------------------------------------------------------------------ */
/* Tables                                                                     */
/* ------------------------------------------------------------------------ */

const COLUMN_MIN = 96;
const COLUMN_MAX = 288;

function Table({ block, ctx, style }: { block: Extract<MarkdownBlock, { type: "table" }>; ctx: RenderContext; style: Spacer }) {
  const { styles } = ctx;
  // No intrinsic table layout on native: estimate each column from its longest
  // cell, then let columns grow proportionally when the table is narrower than the screen.
  const widths = React.useMemo(() => {
    const charWidth = styles.tableText.fontSize * 0.56;
    return block.align.map((_, column) => {
      const longest = Math.max(0, ...[block.header, ...block.rows].map((row) => inlineText(row[column] ?? []).length));
      return Math.round(Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, longest * charWidth + 24)));
    });
  }, [block, styles.tableText.fontSize]);
  return (
    <View style={[styles.tableFrame, style]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tableStyles.content}>
        <View style={tableStyles.body}>
          <TableRow cells={block.header} align={block.align} widths={widths} ctx={ctx} header last={block.rows.length === 0} />
          {block.rows.map((row, index) => (
            <TableRow key={index} cells={row} align={block.align} widths={widths} ctx={ctx} header={false} last={index === block.rows.length - 1} />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function TableRow({ cells, align, widths, ctx, header, last }: { cells: readonly MarkdownTableCell[]; align: readonly MarkdownAlign[]; widths: readonly number[]; ctx: RenderContext; header: boolean; last: boolean }) {
  const { styles } = ctx;
  return (
    <View style={[styles.tableRow, last && tableStyles.lastRow]}>
      {widths.map((width, column) => (
        <View key={column} style={[styles.tableCell, { flexBasis: width, flexGrow: width, flexShrink: 0 }]}>
          <Text
            variant="message"
            selectable
            style={[ctx.text, styles.tableText, header && { color: styles.faint }, { textAlign: align[column] ?? "left" }]}
          >
            {renderInlines(cells[column] ?? [], ctx)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const tableStyles = StyleSheet.create({
  content: { flexGrow: 1 },
  body: { flexGrow: 1 },
  lastRow: { borderBottomWidth: 0 },
});

/* ------------------------------------------------------------------------ */
/* Images                                                                     */
/* ------------------------------------------------------------------------ */

const PLACEHOLDER_ASPECT = 16 / 9;

function MarkdownImage({ url, alt, href, ctx }: { url: string; alt: string; href: string | null; ctx: RenderContext }) {
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = React.useState(false);
  const onLoad = React.useCallback((event: ImageLoadEventData) => {
    const { width, height } = event.source;
    if (width > 0 && height > 0) setSize({ width, height });
  }, []);
  if (failed || !/^https?:\/\//i.test(url)) {
    // Unloadable or non-remote: keep the alt text, linked to the source.
    return (
      <Text variant="message" selectable style={ctx.text}>
        {renderInlines([{ type: "link", url: href ?? url, title: null, children: [{ type: "text", value: alt || url }] }], ctx)}
      </Text>
    );
  }
  const image = (
    <Image
      source={{ uri: url }}
      accessible
      accessibilityRole="image"
      {...(alt ? { accessibilityLabel: alt } : {})}
      contentFit="contain"
      onLoad={onLoad}
      onError={() => setFailed(true)}
      // Never upscale past the image's own size; never exceed the column.
      style={[
        ctx.styles.image,
        { width: "100%", aspectRatio: size ? size.width / size.height : PLACEHOLDER_ASPECT },
        size ? { maxWidth: size.width, backgroundColor: "transparent" } : null,
      ]}
    />
  );
  if (!href) return image;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={alt || href} onPress={() => void openMarkdownLink(href)} onLongPress={() => void copyLink(href)}>
      {image}
    </Pressable>
  );
}

/* ------------------------------------------------------------------------ */
/* Inline runs                                                                */
/* ------------------------------------------------------------------------ */

function renderInlines(inlines: readonly MarkdownInline[], ctx: RenderContext, keyPrefix = ""): React.ReactNode[] {
  const { styles } = ctx;
  return inlines.map((inline, index) => {
    const key = `${keyPrefix}${index}`;
    switch (inline.type) {
      case "text":
        return inline.value;
      case "break":
        return "\n";
      case "strong":
        return <NativeText key={key} style={styles.strong}>{renderInlines(inline.children, ctx, `${key}.`)}</NativeText>;
      case "emphasis":
        return <NativeText key={key} style={styles.emphasis}>{renderInlines(inline.children, ctx, `${key}.`)}</NativeText>;
      case "delete":
        return <NativeText key={key} style={styles.del}>{renderInlines(inline.children, ctx, `${key}.`)}</NativeText>;
      case "inlineCode":
        return <NativeText key={key} style={styles.inlineCode}>{inline.value}</NativeText>;
      case "inlineMath":
        return <NativeText key={key} style={styles.inlineCode}>{inline.value}</NativeText>;
      case "link":
        return (
          <NativeText
            key={key}
            accessibilityRole="link"
            accessibilityHint={inline.title ?? undefined}
            style={styles.link}
            onPress={() => void openMarkdownLink(inline.url)}
            onLongPress={() => void copyLink(inline.url)}
          >
            {renderInlines(inline.children, ctx, `${key}.`)}
          </NativeText>
        );
      case "image":
        // Images nested in emphasis or link text stay in the flow as a link.
        return (
          <NativeText key={key} accessibilityRole="link" style={styles.link} onPress={() => void openMarkdownLink(inline.url)} onLongPress={() => void copyLink(inline.url)}>
            {inline.alt || inline.url}
          </NativeText>
        );
      default:
        return null;
    }
  });
}

function inlineText(inlines: readonly MarkdownInline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.type) {
        case "text":
        case "inlineCode":
        case "inlineMath":
          return inline.value;
        case "image":
          return inline.alt;
        case "break":
          return " ";
        default:
          return inlineText(inline.children);
      }
    })
    .join("");
}

/* ------------------------------------------------------------------------ */
/* Links                                                                      */
/* ------------------------------------------------------------------------ */

const BLOCKED_SCHEMES = /^(javascript|data|vbscript|file):/i;

/** http(s) opens in the in-app browser; other absolute schemes (mailto:, tel:) go to the OS. Relative links are ignored. */
export async function openMarkdownLink(url: string): Promise<void> {
  const target = url.trim();
  try {
    if (/^https?:\/\//i.test(target)) {
      await WebBrowser.openBrowserAsync(target);
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !BLOCKED_SCHEMES.test(target)) {
      await Linking.openURL(target);
    }
  } catch {
    // No handler for the scheme: nothing to open.
  }
}

async function copyLink(url: string): Promise<void> {
  try {
    await Clipboard.setStringAsync(url);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    // Clipboard unavailable: ignore.
  }
}

