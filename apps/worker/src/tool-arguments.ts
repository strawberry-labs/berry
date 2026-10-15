/**
 * Malformed tool-call arguments (H-011). A call whose arguments are not valid
 * JSON, or break the tool's declared schema, is never run. Its result names
 * the exact problem (JSON position and the text around it, or the field and
 * why) so the model can correct the call in one step instead of looping.
 */

/** Arguments rejected before the tool ran: never transient, never applied. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

export interface JsonSyntaxError {
  /** UTF-16 offset of the first character that makes the text invalid. */
  offset: number;
  reason: string;
  /** The text ended before the JSON value was complete. */
  incomplete: boolean;
}

const ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const HEX = /[0-9a-fA-F]/;

/** The first JSON syntax error in `text` (RFC 8259, as JSON.parse), or null when it is valid. */
export function jsonSyntaxError(text: string): JsonSyntaxError | null {
  const length = text.length;
  let index = 0;
  const fail = (reason: string, at = index): JsonSyntaxError => ({ offset: at, reason, incomplete: at >= length });
  const end = (inside: string) => fail(`the text ends ${inside}`, length);
  const skipWhitespace = () => {
    while (index < length && " \t\n\r".includes(text[index]!)) index += 1;
  };
  const string = (): JsonSyntaxError | null => {
    index += 1;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        return null;
      }
      if (code === 0x5c) {
        const escape = text[index + 1];
        if (escape === undefined) return end("inside a string escape");
        if (escape === "u") {
          for (let digit = 2; digit < 6; digit += 1) {
            const character = text[index + digit];
            if (character === undefined) return end("inside a \\u escape");
            if (!HEX.test(character)) return fail(`bad escape ${quote(text.slice(index, index + digit + 1))}: \\u needs four hex digits`);
          }
          index += 6;
          continue;
        }
        if (!ESCAPES.has(escape)) {
          return fail(`bad escape ${quote(`\\${escape}`)} in a string; a backslash must start \\", \\\\, \\/, \\b, \\f, \\n, \\r, \\t or \\uXXXX, so write a literal backslash as \\\\`);
        }
        index += 2;
        continue;
      }
      if (code < 0x20) {
        const name = code === 0x0a ? "line break" : code === 0x0d ? "carriage return" : code === 0x09 ? "tab" : `control character U+${code.toString(16).padStart(4, "0").toUpperCase()}`;
        const escape = code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
        return fail(`a raw ${name} inside a string; write it as ${escape}`);
      }
      index += 1;
    }
    return end("inside a string, before its closing quote");
  };
  const number = (): JsonSyntaxError | null => {
    const start = index;
    if (text[index] === "-") index += 1;
    const digits = () => {
      const from = index;
      while (index < length && text[index]! >= "0" && text[index]! <= "9") index += 1;
      return index - from;
    };
    if (index >= length) return end("inside a number");
    if (text[index] === "0") index += 1;
    else if (digits() === 0) return fail(`invalid number ${quote(text.slice(start, index + 1))}`);
    if (text[index] === ".") {
      index += 1;
      if (index >= length) return end("inside a number");
      if (digits() === 0) return fail(`invalid number ${quote(text.slice(start, index + 1))}: digits must follow "."`);
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (index >= length) return end("inside a number");
      if (digits() === 0) return fail(`invalid number ${quote(text.slice(start, index + 1))}: digits must follow the exponent`);
    }
    return null;
  };
  const stack: Array<"{" | "["> = [];
  let state: "value" | "key" | "after" = "value";
  for (;;) {
    skipWhitespace();
    if (state === "value") {
      if (index >= length) return end(stack.length === 0 ? "before any JSON value" : `inside ${container(stack.at(-1)!)}, where a value should follow`);
      const character = text[index]!;
      if (character === "{" || character === "[") {
        stack.push(character);
        index += 1;
        skipWhitespace();
        if (text[index] === (character === "{" ? "}" : "]")) {
          index += 1;
          stack.pop();
          state = "after";
        } else {
          state = character === "{" ? "key" : "value";
        }
        continue;
      }
      let problem: JsonSyntaxError | null = null;
      if (character === '"') problem = string();
      else if (character === "-" || (character >= "0" && character <= "9")) problem = number();
      else {
        const literal = ["true", "false", "null"].find((word) => text.startsWith(word, index)
          || (index + word.length > length && word.startsWith(text.slice(index))));
        if (!literal) {
          return fail(character === "'"
            ? "unexpected \"'\": JSON strings use double quotes"
            : `unexpected ${describe(character)} where a value should be`);
        }
        if (index + literal.length > length) return end(`inside the literal ${literal}`);
        index += literal.length;
      }
      if (problem) return problem;
      state = "after";
      continue;
    }
    if (state === "key") {
      if (index >= length) return end("inside an object, before a property name");
      if (text[index] !== '"') {
        return fail(text[index] === "'"
          ? "property names need double quotes, not single quotes"
          : `expected a property name in double quotes, found ${describe(text[index]!)}`);
      }
      const problem = string();
      if (problem) return problem;
      skipWhitespace();
      if (index >= length) return end("after a property name, before \":\"");
      if (text[index] !== ":") return fail(`expected ":" after the property name, found ${describe(text[index]!)}`);
      index += 1;
      state = "value";
      continue;
    }
    if (stack.length === 0) return index < length ? fail(`unexpected text after the end of the JSON value: ${describe(text[index]!)}`) : null;
    const open = stack.at(-1)!;
    const close = open === "{" ? "}" : "]";
    if (index >= length) return end(`inside ${container(open)}, before its closing "${close}"`);
    const character = text[index]!;
    if (character === ",") {
      index += 1;
      skipWhitespace();
      if (text[index] === "}" || text[index] === "]") return fail(`a trailing comma before "${text[index]}"`);
      state = open === "{" ? "key" : "value";
      continue;
    }
    if (character === close) {
      index += 1;
      stack.pop();
      continue;
    }
    return fail(`expected "," or "${close}" after ${open === "{" ? "a property value" : "an array element"}, found ${describe(character)}`);
  }
}

/** Why `text` is not valid JSON, where, and the text around that point. */
export function invalidJsonProblem(text: string): string {
  const error = jsonSyntaxError(text) ?? { offset: 0, reason: "the text is not a JSON object", incomplete: false };
  const before = text.slice(0, error.offset);
  const line = before.split("\n").length;
  const column = error.offset - before.lastIndexOf("\n");
  const from = Math.max(0, error.offset - 40);
  const near = `${from > 0 ? "…" : ""}${visible(text.slice(from, error.offset))}⟨HERE⟩${visible(text.slice(error.offset, error.offset + 20))}${error.offset + 20 < text.length ? "…" : ""}`;
  const cutOff = error.incomplete
    ? " The arguments look cut off: send the complete call again, and split very large content over several smaller calls."
    : "";
  const where = error.incomplete
    ? `after the last of its ${text.length} characters (line ${line}, column ${column})`
    : `at character ${error.offset + 1} of ${text.length} (line ${line}, column ${column})`;
  return `its arguments are invalid JSON: ${error.reason}, ${where}, near ${near}.${cutOff}`;
}

/**
 * Model adapters keep arguments that did not parse as `{ raw: text }`. Returns
 * that text when `value` is such a marker, unless the schema declares `raw`.
 */
export function unparsedToolArguments(value: unknown, schema?: unknown): string | null {
  const object = plainObject(value);
  if (!object || Object.keys(object).length !== 1 || typeof object.raw !== "string") return null;
  if (plainObject(plainObject(schema)?.properties)?.raw !== undefined) return null;
  return jsonSyntaxError(object.raw) === null ? null : object.raw;
}

/**
 * Definite violations of a JSON schema: wrong types, missing required fields
 * and values outside an enum, with nested objects and array items. Keywords
 * it does not know (oneOf, $ref, patterns, lengths) are not judged, and null
 * for an optional field counts as absent, so a valid call is never refused.
 */
export function schemaArgumentProblems(schema: unknown, value: unknown, limit = 5): string[] {
  const problems: string[] = [];
  const visit = (node: unknown, item: unknown, path: string, depth: number): void => {
    const rule = plainObject(node);
    if (!rule || problems.length >= limit || depth > 32) return;
    const types = (Array.isArray(rule.type) ? rule.type : [rule.type]).filter((type): type is string => typeof type === "string");
    if (types.length > 0 && !types.some((type) => matchesType(type, item))) {
      problems.push(`${field(path)} must be ${types.map(typeName).join(" or ")}, but ${describeValue(item)} was sent${typeHint(types, item)}`);
      return;
    }
    if (Array.isArray(rule.enum) && rule.enum.length > 0 && !rule.enum.some((option) => JSON.stringify(option) === JSON.stringify(item))) {
      problems.push(`${field(path)} must be one of ${rule.enum.slice(0, 12).map((option) => JSON.stringify(option)).join(", ")}, but ${JSON.stringify(item)?.slice(0, 60)} was sent`);
      return;
    }
    const object = plainObject(item);
    if (object) {
      const properties = plainObject(rule.properties) ?? {};
      const required = Array.isArray(rule.required) ? rule.required.filter((name): name is string => typeof name === "string") : [];
      for (const name of required) {
        if (object[name] !== undefined || problems.length >= limit) continue;
        const sent = Object.keys(object).slice(0, 8);
        problems.push(`${field(join(path, name))} is required but missing (sent ${sent.length > 0 ? `fields: ${sent.join(", ")}` : "no fields"})`);
      }
      for (const [name, child] of Object.entries(object)) {
        if (properties[name] === undefined || (child === null && !required.includes(name))) continue;
        visit(properties[name], child, join(path, name), depth + 1);
      }
    } else if (Array.isArray(item) && plainObject(rule.items)) {
      item.forEach((element, index) => visit(rule.items, element, `${path}[${index}]`, depth + 1));
    }
  };
  visit(schema, value, "", 0);
  return problems;
}

/** The result text for a call that was not run. */
export function notRunMessage(toolName: string, problem: string): string {
  return `${toolName} was not run: ${problem}. Correct the arguments and call it again.`;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object": return plainObject(value) !== null;
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

function typeName(type: string): string {
  return type === "integer" ? "an integer" : type === "array" ? "an array" : type === "object" ? "an object" : type === "null" ? "null" : `a ${type}`;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return `a string (${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)})`;
  return `${typeof value === "number" ? "the number" : ""} ${String(value)}`.trim();
}

function typeHint(types: readonly string[], value: unknown): string {
  if (typeof value !== "string") return "";
  if (types.some((type) => type === "object" || type === "array")) {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "; send the value itself, not JSON text inside a string";
  }
  if (types.some((type) => type === "number" || type === "integer") && value.trim() !== "" && Number.isFinite(Number(value))) {
    return "; send the number without quotes";
  }
  return "";
}

function field(path: string): string {
  return path ? `"${path}"` : "the arguments";
}

function join(path: string, name: string): string {
  return path ? `${path}.${name}` : name;
}

function container(open: "{" | "["): string {
  return open === "{" ? "an object" : "an array";
}

function describe(character: string): string {
  const code = character.charCodeAt(0);
  return code < 0x20 ? `control character U+${code.toString(16).padStart(4, "0").toUpperCase()}` : `"${character}"`;
}

function quote(value: string): string {
  return `"${visible(value)}"`;
}

/** Control characters shown as their Unicode control pictures, so the excerpt stays on one line. */
function visible(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, (character) => String.fromCharCode(0x2400 + character.charCodeAt(0)));
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
