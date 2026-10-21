import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeBase64Url,
  executeGoogleTool,
  GOOGLE_DRIVE_IMPORT_TIMEOUT_MS,
  googleConnectorScopes,
  googleToolCatalog,
  googleToolsRequiringApproval,
  type ConnectorArtifactImport,
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

  it("makes Drive downloads temporary unless the model explicitly saves them", () => {
    const readFile = googleToolCatalog(
      "google-workspace",
      "read",
      ["https://www.googleapis.com/auth/drive.readonly"],
    ).find((tool) => tool.name === "drive_read_file");
    const properties = readFile?.inputSchema.properties as Record<string, Record<string, unknown>>;

    expect(readFile?.description).toContain("By default it is staged temporarily");
    expect(properties.saveToLibrary).toMatchObject({
      type: "boolean",
      description: expect.stringContaining("Defaults to false"),
    });
    expect(readFile?.inputSchema.required).toEqual(["fileId"]);
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
    const artifactImporter = vi.fn(async (artifact: { body: ReadableStream<Uint8Array>; name: string }) => {
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
      { artifactImporter },
    )).resolves.toEqual({ artifact: expect.objectContaining({ fileId: "berry-file-1", size: 11 * 1024 * 1024 }) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(emitted).toBe(11);
    expect(importedBytes).toBe(11 * 1024 * 1024);
    expect(artifactImporter).toHaveBeenCalledWith(expect.objectContaining({
      sourceFileId: "file-1",
      sourceRevision: "file-1",
      saveToLibrary: false,
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
    const artifactImporter = vi.fn();
    await expect(executeGoogleTool(
      "google-workspace",
      "read",
      "drive_read_file",
      "access-token",
      { fileId: "file-1" },
      "person@aesg.com",
      ["https://www.googleapis.com/auth/drive.readonly"],
      { artifactImporter },
    )).rejects.toThrow("100 MB import limit");
    expect(artifactImporter).not.toHaveBeenCalled();
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
    const artifactImporter = vi.fn(async (artifact: { name: string; body: ReadableStream<Uint8Array> }) => {
      await artifact.body.cancel();
      return { artifact: { fileId: "berry-sheet-1", name: artifact.name } };
    });

    await executeGoogleTool(
      "google-workspace",
      "read",
      "drive_read_file",
      "access-token",
      { fileId: "sheet-1", saveToLibrary: true },
      "person@aesg.com",
      ["https://www.googleapis.com/auth/drive.readonly"],
      { artifactImporter },
    );

    expect(timeout).toHaveBeenCalledWith(GOOGLE_DRIVE_IMPORT_TIMEOUT_MS);
    expect(artifactImporter).toHaveBeenCalledWith(expect.objectContaining({
      name: "Forecast.v2.xlsx",
      exportMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      saveToLibrary: true,
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

describe("Google Drive shared-drive scope", () => {
  const DRIVE_READ = "https://www.googleapis.com/auth/drive.readonly";
  const file = (id: string) => ({ id, name: `${id}.pdf`, mimeType: "application/pdf", trashed: false, capabilities: { canAccessViaGenAi: true } });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const requested = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url]) => new URL(String(url)));
  const run = (name: string, input: Record<string, unknown>) => executeGoogleTool("google-workspace", "read", name, "token", input, null, [DRIVE_READ]);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists a shared-drive folder within that drive when the drive ID is not supplied", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "folder-1", driveId: "0AShared" }))
      .mockResolvedValueOnce(json({ files: [file("spec")], nextPageToken: "page-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(run("drive_list_children", { folderId: "folder-1" })).resolves.toMatchObject({
      files: [{ id: "spec" }], searchScope: "drive", driveId: "0AShared", nextPageToken: "page-2",
    });
    const [metadata, listing] = requested(fetchMock);
    expect(metadata!.pathname).toContain("/files/folder-1");
    expect(listing!.searchParams.get("corpora")).toBe("drive");
    expect(listing!.searchParams.get("driveId")).toBe("0AShared");
    expect(listing!.searchParams.get("q")).toBe("'folder-1' in parents and trashed = false");
  });

  it("keeps the supplied drive ID through pagination without another lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ files: [file("page-two")] }));
    vi.stubGlobal("fetch", fetchMock);

    await run("drive_list_children", { folderId: "folder-1", driveId: "0AShared", pageToken: "page-2" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [listing] = requested(fetchMock);
    expect(listing!.searchParams.get("driveId")).toBe("0AShared");
    expect(listing!.searchParams.get("pageToken")).toBe("page-2");
  });

  it("retries an empty unscoped search once across the user's shared drives", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ files: [] }))
      .mockResolvedValueOnce(json({ files: [file("tender")], incompleteSearch: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(run("drive_search_files", { query: "name contains 'Tender'" })).resolves.toMatchObject({
      files: [{ id: "tender" }], searchScope: "allDrives", incompleteSearch: true,
    });
    expect(requested(fetchMock).map((url) => url.searchParams.get("corpora"))).toEqual(["user", "allDrives"]);
  });

  it.each([
    ["a search that already found files", { query: "name contains 'Spec'" }, [file("spec")]],
    ["a continuation page", { query: "name contains 'Spec'", pageToken: "next" }, []],
  ])("does not widen %s", async (_label, input, files) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ files }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(run("drive_search_files", input)).resolves.toMatchObject({ searchScope: "user" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("lists each file's identity without its full capability metadata (H-070)", async () => {
    const full = {
      ...file("spec"),
      size: "2048",
      modifiedTime: "2026-10-01T08:00:00.000Z",
      webViewLink: "https://drive.google.com/file/d/spec/view",
      parents: ["folder-1"],
      owners: [{ displayName: "Amal Haddad", emailAddress: "amal@example.com", photoLink: "https://example.com/p.png", kind: "drive#user" }],
      capabilities: { canAccessViaGenAi: true, canEdit: false, canDownload: true, canCopy: true, canComment: true, canShare: false, canTrash: false },
      contentRestrictions: [{ readOnly: false }],
      linkShareMetadata: { securityUpdateEligible: false },
      version: "42",
      md5Checksum: "abc",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ files: [full, { ...file("blocked"), capabilities: { canAccessViaGenAi: false } }], nextPageToken: "page-2" })));

    const result = await run("drive_search_files", { query: "name contains 'Spec'" }) as { files: unknown[]; nextPageToken: string; omittedIneligibleCount: number };
    expect(result.files).toEqual([{
      id: "spec",
      name: "spec.pdf",
      mimeType: "application/pdf",
      size: "2048",
      modifiedTime: "2026-10-01T08:00:00.000Z",
      webViewLink: "https://drive.google.com/file/d/spec/view",
      parents: ["folder-1"],
      owners: [{ displayName: "Amal Haddad", emailAddress: "amal@example.com" }],
      canEdit: false,
      canDownload: true,
      canCopy: true,
    }]);
    expect(result).toMatchObject({ nextPageToken: "page-2", omittedIneligibleCount: 1 });
  });

  describe("continuing a page found by the shared-drive retry", () => {
    const listing = (url: URL) => ({
      corpora: url.searchParams.get("corpora"),
      q: url.searchParams.get("q"),
      orderBy: url.searchParams.get("orderBy"),
      pageSize: url.searchParams.get("pageSize"),
      pageToken: url.searchParams.get("pageToken"),
    });

    it.each(["drive_search_files", "drive_list_recent_files", "drive_list_children"])("lets %s accept the returned searchScope", (name) => {
      const definition = googleToolCatalog("google-workspace", "read", [DRIVE_READ]).find((tool) => tool.name === name)!;
      expect(definition.inputSchema.additionalProperties).toBe(false);
      expect(definition.inputSchema.properties).toHaveProperty("searchScope");
    });

    it("keeps recent files in the same corpus, order and page size on the next page", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json({ files: [] }))
        .mockResolvedValueOnce(json({ files: [file("shared-1")], nextPageToken: "shared-page-2" }))
        .mockResolvedValueOnce(json({ files: [file("shared-2")] }));
      vi.stubGlobal("fetch", fetchMock);

      const first = await run("drive_list_recent_files", { pageSize: 1 }) as { searchScope: string; nextPageToken: string };
      expect(first).toMatchObject({ files: [{ id: "shared-1" }], searchScope: "allDrives", nextPageToken: "shared-page-2" });
      await expect(run("drive_list_recent_files", { pageSize: 1, pageToken: first.nextPageToken, searchScope: first.searchScope }))
        .resolves.toMatchObject({ files: [{ id: "shared-2" }], searchScope: "allDrives" });

      const [, retried, next] = requested(fetchMock).map(listing);
      expect(next).toEqual({ ...retried, pageToken: "shared-page-2" });
      expect(next).toMatchObject({ corpora: "allDrives", q: "trashed = false", orderBy: "modifiedTime desc", pageSize: "1" });
    });

    it("keeps a My Drive folder listing in the same corpus on the next page", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json({ id: "folder-1" }))
        .mockResolvedValueOnce(json({ files: [] }))
        .mockResolvedValueOnce(json({ files: [file("child-1")], nextPageToken: "children-2" }))
        .mockResolvedValueOnce(json({ id: "folder-1" }))
        .mockResolvedValueOnce(json({ files: [file("child-2")] }));
      vi.stubGlobal("fetch", fetchMock);

      const first = await run("drive_list_children", { folderId: "folder-1", pageSize: 2 }) as { searchScope: string; nextPageToken: string };
      expect(first).toMatchObject({ searchScope: "allDrives", nextPageToken: "children-2" });
      await run("drive_list_children", { folderId: "folder-1", pageSize: 2, pageToken: first.nextPageToken, searchScope: first.searchScope });

      const listings = requested(fetchMock).filter((url) => url.pathname.endsWith("/files")).map(listing);
      expect(listings.map((entry) => entry.corpora)).toEqual(["user", "allDrives", "allDrives"]);
      expect(listings[2]).toEqual({ ...listings[1], pageToken: "children-2" });
    });
  });

  it("searches only the named shared drive when a drive ID is given", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ files: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(run("drive_search_files", { query: "name contains 'Spec'", driveId: "0AShared" })).resolves.toMatchObject({ searchScope: "drive", files: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requested(fetchMock)[0]!.searchParams.get("corpora")).toBe("drive");
  });
});

describe("Gmail attachment import", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const pdf = Buffer.from("%PDF-1.7\nÿþ binary \u0000 bytes ~?>", "latin1");
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const message = (attachmentId = "attachment-fresh") => ({
    id: "message-1",
    threadId: "thread-1",
    internalDate: "1760000000000",
    payload: {
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      body: { size: 0 },
      parts: [
        { partId: "0", mimeType: "text/plain", filename: "", body: { size: 5, data: Buffer.from("hello").toString("base64url") } },
        { partId: "1", mimeType: "application/pdf", filename: "RFP 2026.pdf", body: { size: pdf.byteLength, attachmentId } },
        { partId: "2", mimeType: "image/png", filename: "logo.png", body: { size: 3, attachmentId: "logo-attachment" } },
      ],
    },
  });
  const collect = async (body: ReadableStream<Uint8Array>) => Buffer.from(await new Response(body).arrayBuffer());
  const run = (input: Record<string, unknown>, artifactImporter?: (artifact: ConnectorArtifactImport) => Promise<unknown>) => executeGoogleTool(
    "gmail", "read", "gmail_get_attachment", "access-token", input, "person@aesg.com", [GMAIL_READ],
    artifactImporter ? { artifactImporter } : {},
  );

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("imports the decoded attachment as a Gmail file and never returns its Base64", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(message()))
      .mockResolvedValueOnce(json({ size: pdf.byteLength, data: pdf.toString("base64url") }));
    vi.stubGlobal("fetch", fetchMock);
    let imported: Buffer | null = null;
    const artifactImporter = vi.fn(async (artifact: ConnectorArtifactImport) => {
      imported = await collect(artifact.body);
      return { artifact: { fileId: "berry-file-1", name: artifact.name, mediaType: artifact.contentType, size: imported.byteLength } };
    });

    const result = await run({ messageId: "message-1", partId: "1" }, artifactImporter);

    expect(result).toEqual({ artifact: { fileId: "berry-file-1", name: "RFP 2026.pdf", mediaType: "application/pdf", size: pdf.byteLength } });
    expect(JSON.stringify(result)).not.toContain(pdf.toString("base64url"));
    expect(imported!.equals(pdf)).toBe(true);
    expect(artifactImporter).toHaveBeenCalledWith(expect.objectContaining({
      source: "gmail",
      sourceFileId: "message-1/1",
      sourceRevision: sha256,
      sourceMimeType: "application/pdf",
      exportMimeType: null,
      saveToLibrary: false,
      contentType: "application/pdf",
      declaredSize: pdf.byteLength,
      metadata: { messageId: "message-1", threadId: "thread-1", partId: "1", filename: "RFP 2026.pdf", modifiedTime: new Date(1760000000000).toISOString() },
    }));
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[0]!.pathname).toBe("/gmail/v1/users/me/messages/message-1");
    expect(urls[0]!.searchParams.get("format")).toBe("full");
    expect(urls[1]!.pathname).toBe("/gmail/v1/users/me/messages/message-1/attachments/attachment-fresh");
  });

  it("finds the attachment by its decoded size when Gmail has issued a new attachment ID", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(message("attachment-reissued")))
      .mockResolvedValueOnce(json({ size: pdf.byteLength, data: pdf.toString("base64") }));
    vi.stubGlobal("fetch", fetchMock);
    const artifactImporter = vi.fn(async (artifact: ConnectorArtifactImport) => {
      await artifact.body.cancel();
      return { artifact: { fileId: "berry-file-1" } };
    });

    await run({ messageId: "message-1", attachmentId: "attachment-from-earlier-read" }, artifactImporter);

    expect(new URL(String(fetchMock.mock.calls[1]![0])).pathname).toBe("/gmail/v1/users/me/messages/message-1/attachments/attachment-from-earlier-read");
    expect(artifactImporter).toHaveBeenCalledWith(expect.objectContaining({ name: "RFP 2026.pdf", sourceFileId: "message-1/1", sourceRevision: sha256 }));
  });

  it("refuses data that decodes to fewer bytes than Gmail declared", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(message()))
      .mockResolvedValueOnce(json({ size: pdf.byteLength, data: pdf.subarray(0, 12).toString("base64url") })));
    const artifactImporter = vi.fn();

    await expect(run({ messageId: "message-1", partId: "1" }, artifactImporter))
      .rejects.toThrow(`Gmail attachment data is incomplete: expected ${pdf.byteLength} bytes, decoded 12`);
    expect(artifactImporter).not.toHaveBeenCalled();
  });

  it("refuses attachment data that is not base64url", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(message()))
      .mockResolvedValueOnce(json({ data: "SGVsbG8$IQ" })));
    const artifactImporter = vi.fn();

    await expect(run({ messageId: "message-1", partId: "1" }, artifactImporter)).rejects.toThrow("not valid base64url");
    expect(artifactImporter).not.toHaveBeenCalled();
  });

  it("decodes a small part Gmail returns inline and refuses a MIME container", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(message()))
      .mockResolvedValueOnce(json(message()));
    vi.stubGlobal("fetch", fetchMock);
    let imported: Buffer | null = null;
    const artifactImporter = vi.fn(async (artifact: ConnectorArtifactImport) => {
      imported = await collect(artifact.body);
      return { artifact: { fileId: "berry-file-2" } };
    });

    await run({ messageId: "message-1", partId: "0" }, artifactImporter);
    expect(imported!.toString()).toBe("hello");
    expect(artifactImporter).toHaveBeenCalledWith(expect.objectContaining({ name: "attachment-0.txt", contentType: "text/plain" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(run({ messageId: "message-1", partId: "" }, artifactImporter)).rejects.toThrow("partId or attachmentId is required");
    fetchMock.mockReset().mockResolvedValueOnce(json({ ...message(), payload: { ...message().payload, partId: "9" } }));
    await expect(run({ messageId: "message-1", partId: "9" }, artifactImporter)).rejects.toThrow("is a container, not an attachment");
  });

  it("keeps Gmail's own response when no task file storage is available", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ size: 5, data: "aGVsbG8" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(run({ messageId: "message-1", attachmentId: "attachment-1" })).resolves.toEqual({ size: 5, data: "aGVsbG8" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("advertises partId and saveToLibrary instead of Base64 output", () => {
    const tool = googleToolCatalog("gmail", "read", [GMAIL_READ]).find((candidate) => candidate.name === "gmail_get_attachment");
    expect(tool?.inputSchema.required).toEqual(["messageId"]);
    expect(Object.keys(tool?.inputSchema.properties as Record<string, unknown>)).toEqual(["messageId", "partId", "attachmentId", "saveToLibrary"]);
    expect(tool?.description).toContain("File bytes are never placed directly in model context");
    expect(tool?.description).not.toContain("base64url data");
  });

  it("decodes base64url strictly", () => {
    expect(decodeBase64Url("aGVsbG8_Pndvcmxkfg").toString()).toBe("hello?>world~");
    expect(decodeBase64Url("aGVsbG8/Pndvcmxkfg==").toString()).toBe("hello?>world~");
    expect(decodeBase64Url("").byteLength).toBe(0);
    expect(() => decodeBase64Url("aGVs bG8")).toThrow("not valid base64url");
    expect(() => decodeBase64Url("aGVsb")).toThrow("not valid base64url");
    expect(() => decodeBase64Url("aG=Vs")).toThrow("not valid base64url");
  });
});
