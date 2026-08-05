import { describe, expect, it } from "vitest";
import {
  createTemporaryPassword,
  parseMemberImportCsv,
  TEMPORARY_PASSWORD_MIN_LENGTH,
} from "./member-import";

describe("member CSV imports", () => {
  it("creates a password from the capitalized first name and at least six digits", () => {
    const password = createTemporaryPassword("alice Morgan", () => 7);
    expect(password).toBe("Alice@777777");
    expect(password.length).toBeGreaterThanOrEqual(TEMPORARY_PASSWORD_MIN_LENGTH);
  });

  it("pads short names to the temporary password minimum", () => {
    expect(createTemporaryPassword("Li", () => 4)).toBe("Li@444444444");
  });

  it("parses required columns case-insensitively and supports quoted commas", () => {
    const rows = parseMemberImportCsv(
      'Email,Name,Department\nada@example.com,"Ada, Lovelace",Engineering',
    );
    expect(rows).toMatchObject([
      { rowNumber: 2, name: "Ada, Lovelace", email: "ada@example.com" },
    ]);
    expect(rows[0]!.password).toMatch(/^Ada,@\d{6,}$/);
  });

  it("marks existing, duplicate, and invalid emails without generating passwords", () => {
    const rows = parseMemberImportCsv(
      "name,email\nExisting,old@example.com\nOne,new@example.com\nTwo,new@example.com\nBad,nope",
      ["old@example.com"],
    );
    expect(rows.map((row) => row.error)).toEqual([
      "This email is already a member.",
      undefined,
      "Duplicate email in this CSV.",
      "Enter a valid email address.",
    ]);
    expect(rows[0]!.password).toBe("");
  });

  it("requires name and email headers", () => {
    expect(() => parseMemberImportCsv("full name,address\nAda,a@example.com"))
      .toThrow('The CSV must include "name" and "email" columns.');
  });
});
