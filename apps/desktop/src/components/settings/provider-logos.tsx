import * as React from "react";
import { cn } from "@berry/desktop-ui/lib/utils";
// Monochrome marks use fill="currentColor", so inlining the raw SVG lets them
// adapt to the theme; "-color" variants carry their own brand colors.
import anthropicSvg from "@lobehub/icons-static-svg/icons/anthropic.svg?raw";
import claudeColorSvg from "@lobehub/icons-static-svg/icons/claude-color.svg?raw";
import deepseekColorSvg from "@lobehub/icons-static-svg/icons/deepseek-color.svg?raw";
import fireworksColorSvg from "@lobehub/icons-static-svg/icons/fireworks-color.svg?raw";
import geminiColorSvg from "@lobehub/icons-static-svg/icons/gemini-color.svg?raw";
import grokSvg from "@lobehub/icons-static-svg/icons/grok.svg?raw";
import groqSvg from "@lobehub/icons-static-svg/icons/groq.svg?raw";
import lmstudioSvg from "@lobehub/icons-static-svg/icons/lmstudio.svg?raw";
import mistralColorSvg from "@lobehub/icons-static-svg/icons/mistral-color.svg?raw";
import moonshotSvg from "@lobehub/icons-static-svg/icons/moonshot.svg?raw";
import ollamaSvg from "@lobehub/icons-static-svg/icons/ollama.svg?raw";
import openaiSvg from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import openrouterSvg from "@lobehub/icons-static-svg/icons/openrouter.svg?raw";
import togetherColorSvg from "@lobehub/icons-static-svg/icons/together-color.svg?raw";
import xaiSvg from "@lobehub/icons-static-svg/icons/xai.svg?raw";

/**
 * Keyword → raw brand SVG. Matched against preset id, provider name, and base
 * URL. Specific providers come first: several OpenAI-compatible base URLs
 * (Groq, Gemini) contain the substring "openai", so that rule must be last.
 */
const LOGO_RULES: Array<{ match: RegExp; svg: string }> = [
  { match: /openrouter/i, svg: openrouterSvg },
  { match: /groq/i, svg: groqSvg },
  { match: /gemini|generativelanguage|google/i, svg: geminiColorSvg },
  { match: /deepseek/i, svg: deepseekColorSvg },
  { match: /mistral/i, svg: mistralColorSvg },
  { match: /grok|api\.x\.ai|xai/i, svg: xaiSvg },
  { match: /moonshot|kimi/i, svg: moonshotSvg },
  { match: /together/i, svg: togetherColorSvg },
  { match: /fireworks/i, svg: fireworksColorSvg },
  { match: /anthropic/i, svg: anthropicSvg },
  { match: /claude/i, svg: claudeColorSvg },
  { match: /ollama/i, svg: ollamaSvg },
  { match: /lm ?studio|lmstudio|localhost:1234/i, svg: lmstudioSvg },
  { match: /grok/i, svg: grokSvg },
  { match: /openai|gpt/i, svg: openaiSvg },
];

export function findProviderLogo(...hints: Array<string | null | undefined>): string | null {
  const haystack = hints.filter(Boolean).join(" ");
  for (const rule of LOGO_RULES) {
    if (rule.match.test(haystack)) return rule.svg;
  }
  return null;
}

/** Deterministic soft hue for letter avatars when no brand mark matches. */
function hueFor(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash % 360;
}

/**
 * Provider avatar: a brand mark inside a subtle tile when we recognize the
 * provider, otherwise a tinted letter monogram. `hints` are matched in order
 * (preset id, name, base URL); `name` drives the monogram letter/color.
 */
export function ProviderLogo({
  hints,
  name,
  size = "md",
  className,
}: {
  hints: Array<string | null | undefined>;
  /** Display name used for the fallback monogram; defaults to the first hint. */
  name?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const haystack = hints.filter(Boolean).join(" ");
  const sizeClasses = size === "lg" ? "size-10 rounded-xl" : size === "sm" ? "size-6 rounded-md" : "size-8 rounded-lg";
  const glyphSize = size === "lg" ? "[&_svg]:size-6" : size === "sm" ? "[&_svg]:size-4" : "[&_svg]:size-5";
  if (/berry/i.test(haystack)) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center border border-border/60 bg-background shadow-xs",
          sizeClasses,
          className,
        )}
      >
        <img
          src="/berry-logo.svg"
          alt=""
          draggable={false}
          className={cn("object-contain", size === "lg" ? "size-6" : size === "sm" ? "size-4" : "size-5")}
        />
      </span>
    );
  }
  const svg = findProviderLogo(...hints);
  const label = name?.trim() || hints.find((hint): hint is string => Boolean(hint && hint.trim())) || "?";
  if (svg) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center border border-border/60 bg-background text-foreground shadow-xs",
          sizeClasses,
          glyphSize,
          className,
        )}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center border font-semibold uppercase",
        size === "lg" ? "text-base" : size === "sm" ? "text-[10px]" : "text-xs",
        sizeClasses,
        className,
      )}
      style={{
        backgroundColor: `oklch(0.32 0.055 ${hueFor(label)})`,
        borderColor: `oklch(0.45 0.07 ${hueFor(label)} / 45%)`,
        color: `oklch(0.87 0.06 ${hueFor(label)})`,
      }}
    >
      {label.trim().charAt(0)}
    </span>
  );
}
