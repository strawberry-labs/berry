import { deflateRawSync } from "node:zlib";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SkillPackageError,
  inspectSkillPackage,
  installInspectedSkillPackage,
  parseSkillMetadata,
} from "./skill-package.ts";

interface FixtureEntry {
  name: string;
  localName?: string;
  data?: string | Buffer;
  method?: 0 | 8;
  flags?: number;
  externalAttributes?: number;
  versionMadeBy?: number;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe(".skill package inspection", () => {
  it("accepts a single top-level skill directory and reports resources", () => {
    const path = fixture([
      entry("example/SKILL.md", skill("example", "Example workflow", "license: MIT\ncompatibility: Requires git")),
      entry("example/scripts/run.sh", "#!/bin/sh\necho ok\n"),
      entry("example/references/guide.md", "Guide"),
      entry("example/assets/data.json", "{}"),
    ]);
    const inspected = inspectSkillPackage(path);
    expect(inspected.preview).toMatchObject({
      name: "example",
      description: "Example workflow",
      license: "MIT",
      compatibility: "Requires git",
      rootLayout: "top-level-directory",
      fileCount: 4,
      hasScripts: true,
    });
    expect(inspected.preview.resources).toEqual([
      "assets/data.json",
      "references/guide.md",
      "scripts/run.sh",
    ]);
  });

  it("accepts SKILL.md at the archive root and preserves unknown files", () => {
    const path = fixture([
      entry("SKILL.md", skill("root-skill", "Root package")),
      entry("NOTICE", "keep me"),
    ]);
    const inspected = inspectSkillPackage(path);
    const destination = join(makeTemp(), "root-skill");
    installInspectedSkillPackage(inspected, destination, { replace: false, expectedFingerprint: inspected.preview.fingerprint });
    expect(readFileSync(join(destination, "NOTICE"), "utf8")).toBe("keep me");
    expect(parseSkillMetadata(readFileSync(join(destination, "SKILL.md"), "utf8"), null).name).toBe("root-skill");
  });

  it.each([
    ["invalid YAML", "---\nname: [\ndescription: bad\n---\n", "invalid_skill_metadata"],
    ["missing name", "---\ndescription: Missing name\n---\n", "invalid_skill_metadata"],
    ["missing description", "---\nname: missing-description\n---\n", "invalid_skill_metadata"],
    ["unsafe name", skill("Unsafe Name", "Bad"), "invalid_skill_metadata"],
  ])("rejects %s", (_label, markdown, code) => {
    expectError(() => inspectSkillPackage(fixture([entry("SKILL.md", markdown)])), code);
  });

  it("rejects a directory/frontmatter name mismatch", () => {
    expectError(
      () => inspectSkillPackage(fixture([entry("folder/SKILL.md", skill("other-name", "Mismatch"))])),
      "skill_name_mismatch",
    );
  });

  it.each([
    ["../escape", "../SKILL.md"],
    ["absolute Unix path", "/SKILL.md"],
    ["Windows drive path", "C:\\evil\\SKILL.md"],
    ["UNC path", "\\\\server\\share\\SKILL.md"],
  ])("rejects %s", (_label, name) => {
    expectError(() => inspectSkillPackage(fixture([entry(name, skill("evil", "Unsafe"))])), "unsafe_archive_path");
  });

  it("rejects symlink entries", () => {
    const symlinkMode = (0o120777 << 16) >>> 0;
    expectError(
      () => inspectSkillPackage(fixture([
        entry("example/SKILL.md", skill("example", "Example")),
        { ...entry("example/scripts/link", "../../outside"), externalAttributes: symlinkMode },
      ])),
      "link_entry",
    );
  });

  it("rejects encrypted entries", () => {
    expectError(() => inspectSkillPackage(fixture([
      { ...entry("SKILL.md", skill("encrypted", "Encrypted")), flags: 1 },
    ])), "encrypted_entry");
  });

  it("rejects portable path collisions and mismatched local headers", () => {
    expectError(() => inspectSkillPackage(fixture([
      entry("SKILL.md", skill("duplicate", "Duplicate")),
      entry("skill.md", "duplicate path on a case-insensitive filesystem"),
    ])), "invalid_zip");

    expectError(() => inspectSkillPackage(fixture([
      { ...entry("SKILL.md", skill("mismatch", "Mismatch")), localName: "other.md" },
    ])), "invalid_zip");
  });

  it("rejects excessive expansion, file counts, and compression ratios", () => {
    const large = fixture([entry("SKILL.md", skill("large", "Large")), entry("assets/large.txt", "x".repeat(10_000))]);
    expectError(() => inspectSkillPackage(large, { maxExtractedBytes: 1_000 }), "archive_limit_exceeded");

    const many = fixture([entry("SKILL.md", skill("many", "Many")), entry("a", "1"), entry("b", "2")]);
    expectError(() => inspectSkillPackage(many, { maxFiles: 2 }), "archive_limit_exceeded");

    const bomb = fixture([entry("SKILL.md", skill("bomb", "Bomb")), entry("assets/bomb.txt", "0".repeat(100_000), 8)]);
    expectError(() => inspectSkillPackage(bomb, { maxCompressionRatio: 10, maxEntryCompressionRatio: 20 }), "compression_ratio_exceeded");
  });

  it("rejects multiple skill roots and files outside a top-level skill directory", () => {
    expectError(() => inspectSkillPackage(fixture([
      entry("one/SKILL.md", skill("one", "One")),
      entry("two/SKILL.md", skill("two", "Two")),
    ])), "ambiguous_skill_root");
    expectError(() => inspectSkillPackage(fixture([
      entry("one/SKILL.md", skill("one", "One")),
      entry("outside.txt", "hidden"),
    ])), "ambiguous_skill_root");
  });

  it("does not overwrite without confirmation and replaces atomically when confirmed", () => {
    const root = makeTemp();
    const destination = join(root, "example");
    const first = inspectSkillPackage(fixture([entry("example/SKILL.md", skill("example", "First"))]));
    installInspectedSkillPackage(first, destination, { replace: false });
    const second = inspectSkillPackage(fixture([entry("example/SKILL.md", skill("example", "Second"))]));
    expectError(() => installInspectedSkillPackage(second, destination, { replace: false }), "skill_conflict");
    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toContain("First");
    installInspectedSkillPackage(second, destination, { replace: true });
    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toContain("Second");
    expect(existsSync(join(root, ".skill-stage"))).toBe(false);
  });

  it("pins the reviewed archive fingerprint", () => {
    const inspected = inspectSkillPackage(fixture([entry("SKILL.md", skill("pinned", "Pinned"))]));
    expectError(
      () => installInspectedSkillPackage(inspected, join(makeTemp(), "pinned"), { replace: false, expectedFingerprint: "different" }),
      "archive_changed",
    );
  });
});

function entry(name: string, data: string | Buffer, method: 0 | 8 = 0): FixtureEntry {
  return { name, data, method, versionMadeBy: (3 << 8) | 20, externalAttributes: (0o100644 << 16) >>> 0 };
}

function skill(name: string, description: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}${extra && !extra.endsWith("\n") ? "\n" : ""}---\n\n# Instructions\n`;
}

function makeTemp(): string {
  const directory = mkdtempSync(join(tmpdir(), "berry-skill-package-"));
  tempDirs.push(directory);
  return directory;
}

function fixture(entries: FixtureEntry[]): string {
  const directory = makeTemp();
  const path = join(directory, "fixture.skill");
  writeFileSync(path, zip(entries));
  return path;
}

function zip(entries: FixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, "utf8");
    const localName = Buffer.from(item.localName ?? item.name, "utf8");
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? "", "utf8");
    const method = item.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE((item.flags ?? 0) | 0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(localName.byteLength, 26);
    const localPart = Buffer.concat([local, localName, compressed]);
    localParts.push(localPart);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(item.versionMadeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE((item.flags ?? 0) | 0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(item.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(Buffer.concat([central, name]));
    localOffset += localPart.byteLength;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.byteLength, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

function expectError(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SkillPackageError);
    expect((error as SkillPackageError).code).toBe(code);
  }
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
