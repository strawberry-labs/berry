import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeGoogleTool,
  GOOGLE_DRIVE_IMPORT_TIMEOUT_MS,
  googleConnectorScopes,
  googleToolCatalog,
  googleToolsRequiringApproval,
} from "./google-tools.ts";

const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";

describe("Google connector tool policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps selected-file and workspace-wide Drive authorization visibly distinct", () => {
    const selected = googleConnectorScopes("google-workspace", "read", "selected_files");
    const selectedFull = googleConnectorScopes("google-workspace", "full", "selected_files");
    const workspace = googleConnectorScopes("google-workspace", "read", "search_workspace");
    expect(selected).toEqual(["https://www.googleapis.com/auth/drive.file"]);
    expect(selectedFull).toEqual(["https://www.googleapis.com/auth/drive.file"]);
    expect(selected).not.toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(workspace).toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(googleToolCatalog("google-workspace", "full", selectedFull).some((tool) => tool.name === "docs_insert_text")).toBe(true);
  });

  it("does not expose write tools below the administrator and user access ceiling", () => {
    const read = googleToolCatalog("gmail", "read", ["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(read.length).toBeGreaterThan(0);
    expect(read.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(read.some((tool) => tool.name === "gmail_send_message")).toBe(false);
    const fullWithoutScope = googleToolCatalog("gmail", "full", ["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(fullWithoutScope.some((tool) => tool.name === "gmail_send_message")).toBe(false);
  });

  it("requires approval for native writes in every task mode except reviewable Gmail drafts", () => {
    const gmail = googleToolsRequiringApproval("gmail", "full", [GMAIL_MODIFY]);
    expect(gmail).toContain("gmail_send_message");
    expect(gmail).toContain("gmail_apply_labels");
    expect(gmail).not.toContain("gmail_create_draft");
    expect(gmail).not.toContain("gmail_update_draft");

    const calendar = googleToolsRequiringApproval("google-calendar", "full", [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
    ]);
    expect(calendar).toContain("google_calendar_create_event");
    expect(calendar).toContain("google_calendar_respond_to_event");
    expect(calendar).toContain("google_calendar_delete_event");
  });

  it("sends Gmail label removals in removeLabelIds, never addLabelIds", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "message-1" }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await executeGoogleTool("gmail", "full", "gmail_remove_labels", "access-token", { targetType: "message", id: "message-1", labelIds: ["STARRED"] }, "person@aesg.com", [GMAIL_MODIFY]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>)[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual({ addLabelIds: [], removeLabelIds: ["STARRED"] });
  });

  it("uses the narrow Gmail modify scope instead of mail.google.com", () => {
    const scopes = googleConnectorScopes("gmail", "full");
    expect(scopes).toEqual([GMAIL_MODIFY]);
    expect(scopes).not.toContain("https://mail.google.com/");
  });

  it("streams Drive bytes to the artifact importer without returning Base64", async () => {
    const metadata = new Response(JSON.stringify({
      id: "file-1",
      name: "large.txt",
      mimeType: "text/plain",
      trashed: false,
      capabilities: { canAccessViaGenAi: true, canDownload: true },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 11) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);

    let importedBytes = 0;
    const driveArtifactImporter = vi.fn(async (artifact: { body: ReadableStream<Uint8Array>; name: string }) => {
      const reader = artifact.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        importedBytes += value.byteLength;
      }
      return { artifact: { fileId: "berry-file-1", name: artifact.name, mediaType: "text/plain", size: importedBytes } };
    });
    await expect(executeGoogleTool(
      "google-workspace",
      "read",
      "drive_read_file",
      "access-token",
      { fileId: "file-1" },
      "person@aesg.com",
      ["https://www.googleapis.com/auth/drive.readonly"],
      { driveArtifactImporter },
    )).resolves.toEqual({ artifact: expect.objectContaining({ fileId: "berry-file-1", size: 11 * 1024 * 1024 }) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(emitted).toBe(11);
    expect(importedBytes).toBe(11 * 1024 * 1024);
    expect(driveArtifactImporter).toHaveBeenCalledWith(expect.objectContaining({
      sourceFileId: "file-1",
      sourceRevision: "file-1",
      body: expect.any(ReadableStream),
    }));
  });

  it("rejects a declared Drive object above 100 MB before ingestion", async () => {
    const metadata = new Response(JSON.stringify({
      id: "file-1",
      name: "oversized.pdf",
      mimeType: "application/pdf",
      version: "7",
      trashed: false,
      capabilities: { canAccessViaGenAi: true, canDownload: true },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": String(101 * 1024 * 1024) },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const driveArtifactImporter = vi.fn();
    await expect(executeGoogleTool(
      "google-workspace",
      "read",
      "drive_read_file",
      "access-token",
      { fileId: "file-1" },
      "person@aesg.com",
      ["https://www.googleapis.com/auth/drive.readonly"],
      { driveArtifactImporter },
    )).rejects.toThrow("100 MB import limit");
    expect(driveArtifactImporter).not.toHaveBeenCalled();
  });

  it("uses the long streaming timeout and appends the real Google export extension", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const metadata = new Response(JSON.stringify({
      id: "sheet-1",
      name: "Forecast.v2",
      mimeType: "application/vnd.google-apps.spreadsheet",
      version: "9",
      trashed: false,
      capabilities: { canAccessViaGenAi: true, canDownload: true },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const driveArtifactImporter = vi.fn(async (artifact: { name: string; body: ReadableStream<Uint8Array> }) => {
      await artifact.body.cancel();
      return { artifact: { fileId: "berry-sheet-1", name: artifact.name } };
    });

    await executeGoogleTool(
      "google-workspace",
      "read",
      "drive_read_file",
      "access-token",
      { fileId: "sheet-1" },
      "person@aesg.com",
      ["https://www.googleapis.com/auth/drive.readonly"],
      { driveArtifactImporter },
    );

    expect(timeout).toHaveBeenCalledWith(GOOGLE_DRIVE_IMPORT_TIMEOUT_MS);
    expect(driveArtifactImporter).toHaveBeenCalledWith(expect.objectContaining({
      name: "Forecast.v2.xlsx",
      exportMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
  });

  it("stops streaming an oversized Google JSON response before parsing it", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(chunk);
        if (emitted === 11) controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(executeGoogleTool(
      "gmail",
      "read",
      "gmail_search_messages",
      "access-token",
      {},
      "person@aesg.com",
      [GMAIL_READ],
    )).rejects.toThrow("Google API response exceeds Berry's 10 MB tool-output limit");
    expect(emitted).toBe(11);
  });
});
