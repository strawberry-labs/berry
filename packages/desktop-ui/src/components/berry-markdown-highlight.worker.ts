import { codeToTokens, bundledLanguages, type BundledLanguage, type BundledTheme, type ThemedToken } from "shiki";

type HighlightRequest = {
  code: string;
  language: string;
  theme: string;
};

export type HighlightResponse =
  | { status: "highlighted"; lines: ThemedToken[][] }
  | { status: "fallback" };

const THEME_MAP: Record<string, BundledTheme> = {
  "berry-light": "vitesse-light",
  "berry-dark": "vitesse-dark",
  "github-light": "github-light",
  "one-dark": "one-dark-pro",
};

const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  plaintext: "markdown",
  text: "markdown",
};

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
  try {
    const language = resolveLanguage(event.data.language);
    if (!language) {
      self.postMessage({ status: "fallback" } satisfies HighlightResponse);
      return;
    }
    const result = await codeToTokens(event.data.code, {
      lang: language,
      theme: THEME_MAP[event.data.theme] ?? "vitesse-dark",
    });
    self.postMessage({ status: "highlighted", lines: result.tokens } satisfies HighlightResponse);
  } catch {
    self.postMessage({ status: "fallback" } satisfies HighlightResponse);
  }
};

function resolveLanguage(value: string): BundledLanguage | null {
  const normalized = value.trim().toLowerCase();
  return normalized in bundledLanguages
    ? normalized as BundledLanguage
    : LANGUAGE_ALIASES[normalized] ?? null;
}
