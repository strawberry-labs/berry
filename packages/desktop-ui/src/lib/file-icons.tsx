import { cn } from "@berry/desktop-ui/lib/utils";

/**
 * File-type icons using MIT-licensed Material Icon Theme SVGs bundled under
 * assets/file-icons. Icons carry their own colors, so we render the raw SVG
 * inline -- CSP-safe (no external/img fetch) -- and scale it to the box.
 */
const RAW = import.meta.glob("../assets/file-icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ICONS: Record<string, string> = {};
for (const [path, svg] of Object.entries(RAW)) {
  const name = path.split("/").pop()!.replace(/\.svg$/, "");
  ICONS[name] = svg;
}

/** Filename (or stem) to icon name, aligned with common editor icon themes. */
const NAME_ICONS: Record<string, string> = {
  readme: "readme",
  ".editorconfig": "editorconfig",
  ".env": "settings",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".npmrc": "npm",
  ".nvmrc": "nodejs",
  ".prettierrc": "prettier",
  ".yarnrc": "yarn",
  "babel.config": "babel",
  bun: "lock",
  "bun.lock": "lock",
  cargo: "rust",
  "cargo.lock": "lock",
  dockerfile: "docker",
  eslint: "eslint",
  "eslint.config": "eslint",
  gemfile: "gemfile",
  jest: "jest",
  "jest.config": "jest",
  makefile: "makefile",
  "package-lock": "lock",
  "pnpm-lock": "lock",
  tsconfig: "tsconfig",
  vitest: "vitest",
  "vitest.config": "vitest",
  yarn: "yarn",
  vite: "vite",
  "vite.config": "vite",
  "tailwind.config": "tailwindcss",
  prisma: "prisma",
};

/** Extension to icon name, aligned with common editor icon themes. */
const EXT_ICONS: Record<string, string> = {
  md: "berry-text",
  mdx: "berry-text",
  markdown: "berry-text",
  js: "berry-code",
  mjs: "berry-code",
  cjs: "berry-code",
  jsx: "react",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "react_ts",
  json: "berry-code",
  jsonl: "berry-code",
  json5: "berry-code",
  jsonc: "berry-code",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  php: "php",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  sql: "database",
  db: "database",
  sh: "console",
  bash: "console",
  zsh: "console",
  fish: "console",
  ps1: "powershell",
  svg: "svg",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  png: "berry-image",
  jpg: "berry-image",
  jpeg: "berry-image",
  gif: "berry-image",
  webp: "berry-image",
  ico: "berry-image",
  bmp: "berry-image",
  mp4: "berry-video",
  mov: "berry-video",
  webm: "berry-video",
  mp3: "berry-audio",
  wav: "berry-audio",
  flac: "berry-audio",
  pdf: "berry-pdf",
  doc: "berry-word",
  docx: "berry-word",
  xls: "berry-excel",
  xlsx: "berry-excel",
  csv: "berry-excel",
  ppt: "berry-powerpoint",
  pptx: "berry-powerpoint",
  zip: "berry-zip",
  tar: "berry-zip",
  gz: "berry-zip",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  graphql: "graphql",
  gql: "graphql",
  txt: "berry-text",
  log: "berry-text",
};

function iconNameFor(path: string, isDirectory: boolean): string {
  if (isDirectory) return "berry-folder";
  const base = (path.split("/").pop() ?? path).toLowerCase();
  // Try full name, then progressively stripped stems (e.g. "vite.config.ts").
  const parts = base.split(".");
  for (let i = 0; i < parts.length; i += 1) {
    const stem = parts.slice(0, parts.length - i).join(".");
    if (NAME_ICONS[stem]) return NAME_ICONS[stem];
  }
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return EXT_ICONS[ext] ?? "berry-file";
}

export function FileTypeIcon({
  path,
  isDirectory = false,
  className,
}: {
  path: string;
  isDirectory?: boolean;
  className?: string;
}) {
  const name = iconNameFor(path, isDirectory);
  const svg = ICONS[name] ?? ICONS["berry-file"] ?? ICONS.document ?? "";
  return (
    <span
      className={cn("inline-flex size-4 shrink-0 items-center justify-center [&>svg]:size-full", className)}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
