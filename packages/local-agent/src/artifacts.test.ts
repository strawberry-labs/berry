import { describe, expect, it } from "vitest";
import {
  artifactDisplayName,
  detectArtifactMediaType,
  resolveArtifactMediaType,
} from "./artifacts.ts";

describe("artifact metadata", () => {
  it("uses the PDF bytes even when the path, name, and supplied MIME are wrong", () => {
    const bytes = Buffer.from("%PDF-1.7");

    expect(detectArtifactMediaType(bytes)).toBe("application/pdf");
    expect(resolveArtifactMediaType({
      bytes,
      sourcePath: "/workspace/outputs/result.bin",
      requestedName: "Submission",
      explicitMediaType: "application/octet-stream",
    })).toBe("application/pdf");
    expect(artifactDisplayName("/workspace/outputs/result.bin", "Submission", "application/pdf")).toBe("Submission.pdf");
  });

  it("detects an OOXML document from its ZIP entries and supplies the extension", () => {
    const bytes = zipFixture("[Content_Types].xml", "word/document.xml", "word/styles.xml");
    const mediaType = resolveArtifactMediaType({
      bytes,
      sourcePath: "/workspace/outputs/generated",
      requestedName: "Final submission",
    });

    expect(detectArtifactMediaType(bytes)).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mediaType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(artifactDisplayName("/workspace/outputs/generated", "Final submission", mediaType)).toBe("Final submission.docx");
  });

  it("uses a known source extension when a ZIP is not a recognized Office container", () => {
    const bytes = zipFixture("data/entry.bin");

    expect(resolveArtifactMediaType({
      bytes,
      sourcePath: "/workspace/outputs/archive.zip",
      requestedName: "Archive",
    })).toBe("application/zip");
    expect(artifactDisplayName("/workspace/outputs/archive.zip", "Archive", "application/zip")).toBe("Archive.zip");
  });
});

function zipFixture(...names: string[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(Buffer.concat([localHeader, nameBytes]));

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(Buffer.concat([centralHeader, nameBytes]));
    localOffset += localParts.at(-1)!.byteLength;
  }

  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(local.byteLength, 16);
  return Buffer.concat([local, central, end]);
}
