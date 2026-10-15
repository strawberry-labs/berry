import { describe, expect, it } from "vitest";
import {
  invalidJsonProblem,
  jsonSyntaxError,
  schemaArgumentProblems,
  unparsedToolArguments,
} from "./tool-arguments.js";

describe("tool argument checks (H-011)", () => {
  it("locates the JSON error a model typically makes", () => {
    const edit = '{"path": "a.ts", "edits": [{"oldText": "x", "newText": "\\d+"}]}';
    expect(jsonSyntaxError(edit)).toMatchObject({ offset: edit.indexOf("\\d"), reason: expect.stringContaining('bad escape "\\d"'), incomplete: false });
    expect(invalidJsonProblem(edit)).toContain(`at character ${edit.indexOf("\\d") + 1} of ${edit.length} (line 1, column ${edit.indexOf("\\d") + 1}), near …`);
    expect(invalidJsonProblem(edit)).toContain('"newText": "⟨HERE⟩\\d+"}]}');

    const truncated = '{"path": "notes.md", "content": "First line\\nSecond';
    expect(jsonSyntaxError(truncated)).toMatchObject({ offset: truncated.length, incomplete: true, reason: "the text ends inside a string, before its closing quote" });
    expect(invalidJsonProblem(truncated)).toContain("The arguments look cut off");

    const rawNewline = '{"content": "a\nb"}';
    expect(jsonSyntaxError(rawNewline)).toMatchObject({ offset: 14, reason: "a raw line break inside a string; write it as \\n" });
    expect(invalidJsonProblem(rawNewline)).toContain('"a⟨HERE⟩␊b"}');
    expect(jsonSyntaxError('{"a": [1, 2,]}')?.reason).toBe('a trailing comma before "]"');
    expect(jsonSyntaxError("{'a': 1}")?.reason).toBe("property names need double quotes, not single quotes");
    expect(jsonSyntaxError('{"a": 1}}')?.reason).toContain("unexpected text after the end");
  });

  it("agrees with JSON.parse on which texts are valid", () => {
    let seed = 7;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const pieces = ["{", "}", "[", "]", ",", ":", '"', '"a"', "\\", "\\n", "\\u00e9", "\\u12", "1", "-", "0", "01", ".5", "1e", "e+3", "true", "tru", "null", " ", "\n", "\t", "x", "'"];
    for (let round = 0; round < 5_000; round += 1) {
      const text = Array.from({ length: 1 + next(12) }, () => pieces[next(pieces.length)]).join("");
      let valid = true;
      try { JSON.parse(text); } catch { valid = false; }
      expect(jsonSyntaxError(text) === null, text).toBe(valid);
    }
    expect(jsonSyntaxError(JSON.stringify({ deep: Array.from({ length: 50 }, (_, index) => ({ index, text: "é\n\"\\" })) }))).toBeNull();
  });

  it("recognises only unparsed arguments as the raw marker", () => {
    expect(unparsedToolArguments({ raw: '{"path": "a' })).toBe('{"path": "a');
    expect(unparsedToolArguments({ raw: '{"path": "a"}' })).toBeNull();
    expect(unparsedToolArguments({ raw: "x", other: 1 })).toBeNull();
    expect(unparsedToolArguments({ raw: "hello" }, { type: "object", properties: { raw: { type: "string" } } })).toBeNull();
  });

  it("names the field and why for schema violations, and never refuses a valid call", () => {
    const schema = {
      type: "object",
      required: ["id", "kind", "variants"],
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["email", "other"] },
        count: { type: "integer" },
        variants: { type: "array", items: { type: "object", required: ["body"], properties: { body: { type: "string" } } } },
        choice: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
    };
    expect(schemaArgumentProblems(schema, { id: "a", kind: "sms", variants: '[{"body": "hi"}]', count: "3" })).toEqual([
      '"kind" must be one of "email", "other", but "sms" was sent',
      '"variants" must be an array, but a string ("[{\\"body\\": \\"hi\\"}]") was sent; send the value itself, not JSON text inside a string',
      '"count" must be an integer, but a string ("3") was sent; send the number without quotes',
    ]);
    expect(schemaArgumentProblems(schema, { kind: "email", variants: [{ subject: "x" }] })).toEqual([
      '"id" is required but missing (sent fields: kind, variants)',
      '"variants[0].body" is required but missing (sent fields: subject)',
    ]);
    expect(schemaArgumentProblems(schema, "a string")).toEqual(['the arguments must be an object, but a string ("a string") was sent']);
    expect(schemaArgumentProblems(schema, { id: "a", kind: "email", variants: [], count: null, choice: true, extra: 1 })).toEqual([]);
  });
});
