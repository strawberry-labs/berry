import * as React from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { BERRY_THEME_CHANGE_EVENT, currentDocumentTheme } from "@/lib/theme";

if (typeof self !== "undefined") {
  self.MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === "json") return new jsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new cssWorker();
      if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
      if (label === "typescript" || label === "javascript") return new tsWorker();
      return new editorWorker();
    },
  };
  loader.config({ monaco });
}

export function MonacoCodeEditor({
  className,
  language,
  onChange,
  path,
  readOnly = false,
  value,
}: {
  className?: string;
  language: string;
  onChange?: (value: string) => void;
  path: string;
  readOnly?: boolean;
  value: string;
}) {
  const theme = useMonacoTheme();

  return (
    <Editor
      {...(className ? { className } : {})}
      height="100%"
      language={language}
      loading={<div className="berry-code-editor-loading">Loading editor…</div>}
      onChange={(next) => onChange?.(next ?? "")}
      options={{
        automaticLayout: true,
        contextmenu: true,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 20,
        minimap: { enabled: false },
        padding: { top: 12, bottom: 12 },
        readOnly,
        renderLineHighlight: readOnly ? "none" : "line",
        scrollBeyondLastLine: false,
        tabSize: 2,
        wordWrap: "on",
      }}
      path={path}
      theme={theme}
      value={value}
    />
  );
}

export function languageForPath(path: string): string {
  const name = path.toLowerCase();
  if (name.endsWith(".d.ts") || /\.(ts|tsx|mts|cts)$/.test(name)) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/.test(name)) return "javascript";
  if (/\.(json|jsonc)$/.test(name)) return "json";
  if (/\.(html|htm|svg)$/.test(name)) return "html";
  if (/\.(css|scss|sass|less)$/.test(name)) return name.endsWith(".less") ? "less" : name.endsWith(".scss") || name.endsWith(".sass") ? "scss" : "css";
  if (/\.(md|mdx)$/.test(name)) return "markdown";
  if (/\.(ya?ml)$/.test(name)) return "yaml";
  if (/\.(py|pyi)$/.test(name)) return "python";
  if (/\.(go)$/.test(name)) return "go";
  if (/\.(rs)$/.test(name)) return "rust";
  if (/\.(java)$/.test(name)) return "java";
  if (/\.(php)$/.test(name)) return "php";
  if (/\.(rb)$/.test(name)) return "ruby";
  if (/\.(c|h)$/.test(name)) return "c";
  if (/\.(cc|cpp|cxx|hpp)$/.test(name)) return "cpp";
  if (/\.(cs)$/.test(name)) return "csharp";
  if (/\.(sh|bash|zsh|fish)$/.test(name)) return "shell";
  if (/\.(sql)$/.test(name)) return "sql";
  if (/\.(xml|xsd|xsl)$/.test(name)) return "xml";
  if (/\.(ini|cfg|conf|toml|env)$/.test(name) || /(^|\/)\.env(?:\.|$)/.test(name)) return "ini";
  if (/\.(dockerfile)$/.test(name) || /(^|\/)dockerfile$/.test(name)) return "dockerfile";
  return "plaintext";
}

function useMonacoTheme() {
  const [theme, setTheme] = React.useState<"vs" | "vs-dark">(() => currentDocumentTheme() === "dark" ? "vs-dark" : "vs");

  React.useEffect(() => {
    const sync = () => setTheme(currentDocumentTheme() === "dark" ? "vs-dark" : "vs");
    sync();
    window.addEventListener(BERRY_THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(BERRY_THEME_CHANGE_EVENT, sync);
  }, []);

  return theme;
}
