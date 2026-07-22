export type DiffLineKind = "context" | "add" | "remove" | "hunk" | "meta";

export interface DiffRange {
  start: number;
  end: number;
}

export interface DiffLine {
  id: string;
  kind: DiffLineKind;
  raw: string;
  content: string;
  oldLine: number | null;
  newLine: number | null;
  changed: DiffRange[];
}

export interface DiffFile {
  id: string;
  oldPath: string;
  newPath: string;
  displayPath: string;
  language: string;
  status: "added" | "deleted" | "renamed" | "modified" | "binary";
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export interface DiffAnchor {
  path: string;
  oldPath: string;
  side: "old" | "new";
  line: number;
  contextHash: string;
}

export function parseUnifiedDiff(input: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of input.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const [oldPath, newPath] = diffPaths(raw);
      current = makeFile(oldPath, newPath, files.length);
      files.push(current);
      continue;
    }
    if (!current) {
      if (!raw.trim()) continue;
      current = makeFile("Workspace diff", "Workspace diff", files.length);
      files.push(current);
    }
    if (raw.startsWith("rename from ")) {
      current.oldPath = raw.slice(12);
      current.status = "renamed";
      current.displayPath = `${current.oldPath} -> ${current.newPath}`;
      continue;
    }
    if (raw.startsWith("rename to ")) {
      current.newPath = raw.slice(10);
      current.status = "renamed";
      current.displayPath = `${current.oldPath} -> ${current.newPath}`;
      current.language = languageForPath(current.newPath);
      continue;
    }
    if (raw.startsWith("new file mode ")) current.status = "added";
    if (raw.startsWith("deleted file mode ")) current.status = "deleted";
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) current.status = "binary";

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push(makeLine(current, "hunk", raw, raw, null, null));
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      current.lines.push(makeLine(current, "add", raw, raw.slice(1), null, newLine++));
      current.additions += 1;
      continue;
    }
    if (raw.startsWith("-") && !raw.startsWith("---")) {
      current.lines.push(makeLine(current, "remove", raw, raw.slice(1), oldLine++, null));
      current.deletions += 1;
      continue;
    }
    if (raw.startsWith(" ")) {
      current.lines.push(makeLine(current, "context", raw, raw.slice(1), oldLine++, newLine++));
      continue;
    }
    if (raw.startsWith("\\ No newline")) {
      current.lines.push(makeLine(current, "meta", raw, raw, null, null));
      continue;
    }
    if (raw && !raw.startsWith("index ") && !raw.startsWith("--- ") && !raw.startsWith("+++ ") && !raw.startsWith("similarity index ")) {
      current.lines.push(makeLine(current, "meta", raw, raw, null, null));
    }
  }

  for (const file of files) annotateWordChanges(file.lines);
  return files.filter((file) => file.lines.length > 0 || file.status !== "modified");
}

export function diffLineAnchor(file: DiffFile, line: DiffLine): DiffAnchor | null {
  const number = line.newLine ?? line.oldLine;
  if (number === null) return null;
  return {
    path: file.status === "deleted" ? file.oldPath : file.newPath,
    oldPath: file.oldPath,
    side: line.newLine === null ? "old" : "new",
    line: number,
    contextHash: shortHash(`${line.kind}\0${line.content}`),
  };
}

export function virtualRange(total: number, scrollTop: number, viewportHeight: number, rowHeight: number, overscan = 10) {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end, offsetTop: start * rowHeight, offsetBottom: Math.max(0, (total - end) * rowHeight) };
}

function makeFile(oldPath: string, newPath: string, index: number): DiffFile {
  return {
    id: `${index}:${oldPath}:${newPath}`,
    oldPath,
    newPath,
    displayPath: oldPath === newPath ? newPath : `${oldPath} -> ${newPath}`,
    language: languageForPath(newPath),
    status: "modified",
    additions: 0,
    deletions: 0,
    lines: [],
  };
}

function makeLine(file: DiffFile, kind: DiffLineKind, raw: string, content: string, oldLine: number | null, newLine: number | null): DiffLine {
  return { id: `${file.id}:${file.lines.length}`, kind, raw, content, oldLine, newLine, changed: [] };
}

function diffPaths(header: string): [string, string] {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  return match ? [unquote(match[1]!), unquote(match[2]!)] : [header.slice(11), header.slice(11)];
}

function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  try { return JSON.parse(path) as string; } catch { return path.slice(1, -1); }
}

function annotateWordChanges(lines: DiffLine[]) {
  for (let index = 0; index < lines.length;) {
    if (lines[index]?.kind !== "remove") { index += 1; continue; }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (lines[index]?.kind === "remove") removed.push(lines[index++]!);
    while (lines[index]?.kind === "add") added.push(lines[index++]!);
    const pairs = Math.min(removed.length, added.length);
    for (let pair = 0; pair < pairs; pair += 1) {
      const ranges = changedRanges(removed[pair]!.content, added[pair]!.content);
      removed[pair]!.changed = ranges.left;
      added[pair]!.changed = ranges.right;
    }
  }
}

function changedRanges(left: string, right: string): { left: DiffRange[]; right: DiffRange[] } {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.length > 256 || rightTokens.length > 256) {
    return {
      left: left.length ? [{ start: 0, end: left.length }] : [],
      right: right.length ? [{ start: 0, end: right.length }] : [],
    };
  }
  const table = Array.from({ length: leftTokens.length + 1 }, () => new Uint16Array(rightTokens.length + 1));
  for (let i = leftTokens.length - 1; i >= 0; i -= 1) {
    for (let j = rightTokens.length - 1; j >= 0; j -= 1) {
      table[i]![j] = leftTokens[i]!.value === rightTokens[j]!.value ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const sameLeft = new Set<number>();
  const sameRight = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < leftTokens.length && j < rightTokens.length) {
    if (leftTokens[i]!.value === rightTokens[j]!.value) { sameLeft.add(i++); sameRight.add(j++); }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return { left: mergeRanges(leftTokens.filter((_, at) => !sameLeft.has(at))), right: mergeRanges(rightTokens.filter((_, at) => !sameRight.has(at))) };
}

function tokens(value: string): Array<DiffRange & { value: string }> {
  const output: Array<DiffRange & { value: string }> = [];
  for (const match of value.matchAll(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu)) {
    output.push({ value: match[0], start: match.index, end: match.index + match[0].length });
  }
  return output;
}

function mergeRanges(values: DiffRange[]): DiffRange[] {
  const output: DiffRange[] = [];
  for (const value of values) {
    const previous = output.at(-1);
    if (previous && previous.end === value.start) previous.end = value.end;
    else output.push({ start: value.start, end: value.end });
  }
  return output;
}

function languageForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ({ ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", json: "json", css: "css", scss: "scss", html: "html", md: "markdown", rs: "rust", py: "python", rb: "ruby", go: "go", java: "java", sh: "bash", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql" } as Record<string, string>)[extension] ?? "text";
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
