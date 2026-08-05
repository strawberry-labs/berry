export const TEMPORARY_PASSWORD_MIN_LENGTH = 12;

export type MemberImportRow = {
  rowNumber: number;
  name: string;
  email: string;
  password: string;
  error?: string;
};

export function createTemporaryPassword(
  name: string,
  randomDigit: () => number = secureRandomDigit,
): string {
  const firstName = name.trim().split(/\s+/)[0] || "Member";
  const capitalized = firstName.charAt(0).toLocaleUpperCase() + firstName.slice(1);
  const digitCount = Math.max(
    6,
    TEMPORARY_PASSWORD_MIN_LENGTH - capitalized.length - 1,
  );
  let digits = "";
  for (let index = 0; index < digitCount; index += 1) {
    digits += String(Math.abs(Math.trunc(randomDigit())) % 10);
  }
  return `${capitalized}@${digits}`;
}

export function parseMemberImportCsv(
  source: string,
  existingEmails: Iterable<string> = [],
): MemberImportRow[] {
  const records = parseCsvRecords(source.replace(/^\uFEFF/, ""));
  if (records.length === 0) throw new Error("The CSV file is empty.");

  const headerRecord = records[0];
  if (!headerRecord) throw new Error("The CSV file is empty.");
  const headers = headerRecord.map((header) => header.trim().toLowerCase());
  const nameIndex = headers.indexOf("name");
  const emailIndex = headers.indexOf("email");
  if (nameIndex === -1 || emailIndex === -1) {
    throw new Error('The CSV must include "name" and "email" columns.');
  }

  const knownEmails = new Set(
    [...existingEmails].map((email) => email.trim().toLowerCase()),
  );
  const fileEmails = new Set<string>();
  const rows = records.slice(1).flatMap<MemberImportRow>((record, index) => {
    if (record.every((value) => value.trim() === "")) return [];
    const rowNumber = index + 2;
    const name = (record[nameIndex] ?? "").trim();
    const email = (record[emailIndex] ?? "").trim().toLowerCase();
    let error: string | undefined;
    if (!name) error = "Name is required.";
    else if (name.length > 100) error = "Name must be 100 characters or fewer.";
    else if (!email) error = "Email is required.";
    else if (!isEmail(email)) error = "Enter a valid email address.";
    else if (knownEmails.has(email)) error = "This email is already a member.";
    else if (fileEmails.has(email)) error = "Duplicate email in this CSV.";
    fileEmails.add(email);
    return [{
      rowNumber,
      name,
      email,
      password: error ? "" : createTemporaryPassword(name),
      ...(error ? { error } : {}),
    }];
  });

  if (rows.length === 0) throw new Error("The CSV does not contain any members.");
  return rows;
}

function secureRandomDigit(): number {
  const value = new Uint8Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0]! % 10;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseCsvRecords(source: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === "") quoted = true;
    else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      if (character === "\r" && source[index + 1] === "\n") index += 1;
    } else field += character;
  }
  if (quoted) throw new Error("The CSV contains an unclosed quoted value.");
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  return records;
}
