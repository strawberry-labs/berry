import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ToolArgumentError } from "./tool-arguments.js";
import {
  fileUploadDefinition,
  fileUploadInput,
  storageErrorReason,
  uploadDestination,
  uploadFileBytes,
  uploadNetworkProblem,
  type FileUploadPolicy,
} from "./file-upload.js";

const signedUrl = "https://connect-rfp.s3.eu-west-1.amazonaws.com/work-winning/rfp/identification/id-1/email-attachments/RFP.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE%2F20261021%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Security-Token=secret-session-token&X-Amz-Signature=0123456789abcdef";
const open: FileUploadPolicy = { egress: "unrestricted", allowedDomains: [] };
const bytes = new Uint8Array(Buffer.from("%PDF-1.7 original attachment bytes"));
const sha256 = createHash("sha256").update(bytes).digest();
const md5 = createHash("md5").update(bytes).digest("base64");

function input(overrides: Record<string, unknown> = {}) {
  return fileUploadInput({ path: "/workspace/inputs/file-1/RFP.pdf", url: signedUrl, headers: { "Content-Type": "application/pdf" }, ...overrides });
}

function storage(response: Response) {
  return vi.fn<typeof fetch>(async () => response);
}

describe("upload_file arguments", () => {
  it("accepts a presigned HTTPS URL with string or numeric headers", () => {
    const parsed = input({ method: "PUT", headers: { "Content-Type": "application/pdf", "x-amz-meta-attempt": 2 } });
    expect(parsed.url.toString()).toBe(signedUrl);
    expect(parsed.headers).toEqual([["content-type", "application/pdf"], ["x-amz-meta-attempt", "2"]]);
  });

  it.each([
    [{ url: "http://bucket.example.com/key" }, "must use https"],
    [{ url: "https://user:pass@bucket.example.com/key" }, "must not contain credentials"],
    [{ url: "https://localhost/key" }, "localhost or private networks"],
    [{ url: "https://169.254.169.254/latest" }, "localhost or private networks"],
    [{ method: "POST" }, "method must be PUT"],
    [{ headers: { "Bad Header": "x" } }, "is not a valid HTTP header name"],
    [{ headers: { "x-amz-meta-note": "a\r\nx-injected: 1" } }, "must not contain line breaks"],
    [{ headers: { "Content-Type": "application/pdf", "content-type": "text/plain" } }, "given twice with different values"],
    [{ headers: { Host: "attacker.example.com" } }, "does not match the URL's host"],
    [{ path: "" }, "path is required"],
    [{ extra: true }, "Unrecognized key"],
  ])("refuses %j before reading or sending anything", (overrides, problem) => {
    expect(() => input(overrides)).toThrow(ToolArgumentError);
    expect(() => input(overrides)).toThrow(problem);
    expect(() => input(overrides)).toThrow("upload_file was not run");
  });

  it("shows only the origin and path of a signed URL", () => {
    expect(uploadDestination(new URL(signedUrl))).toBe("https://connect-rfp.s3.eu-west-1.amazonaws.com/work-winning/rfp/identification/id-1/email-attachments/RFP.pdf");
  });

  it("advertises a schema the model can follow", () => {
    expect(fileUploadDefinition.function.parameters).toMatchObject({
      required: ["path", "url"],
      properties: { method: { enum: ["PUT"] }, headers: { type: "object" } },
    });
  });
});

describe("upload_file network policy", () => {
  const url = new URL(signedUrl);

  it("follows the same egress rules as the sandbox", () => {
    expect(uploadNetworkProblem(url, open)).toBeNull();
    expect(uploadNetworkProblem(url, { egress: "on", allowedDomains: [] })).toBeNull();
    expect(uploadNetworkProblem(url, { egress: "on", allowedDomains: ["*.amazonaws.com"] })).toBeNull();
    expect(uploadNetworkProblem(url, { egress: "on", allowedDomains: ["pypi.org"] }))
      .toContain("Network access to connect-rfp.s3.eu-west-1.amazonaws.com is blocked by this task's network policy");
    expect(uploadNetworkProblem(url, { egress: "off", allowedDomains: [] })).toContain("blocks outbound network access");
  });

  it("sends nothing when the policy blocks the host", async () => {
    const send = storage(new Response(null, { status: 200 }));
    await expect(uploadFileBytes({ upload: input(), bytes, policy: { egress: "on", allowedDomains: ["pypi.org"] }, fetch: send }))
      .rejects.toThrow("Nothing was sent");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("upload_file transfer", () => {
  it("PUTs the exact bytes with the exact headers and returns a receipt without the signed query", async () => {
    const send = storage(new Response(null, {
      status: 200,
      headers: { etag: '"etag-1"', "x-amz-version-id": "version-1", "x-amz-checksum-sha256": sha256.toString("base64") },
    }));
    const upload = input({
      headers: {
        "Content-Type": "application/pdf",
        "x-amz-checksum-sha256": sha256.toString("base64"),
        "Content-Length": String(bytes.byteLength),
        Host: "connect-rfp.s3.eu-west-1.amazonaws.com",
        Expect: "100-continue",
      },
    });

    const result = await uploadFileBytes({ upload, bytes, policy: open, fetch: send });

    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe(signedUrl);
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(bytes);
    // Content-Length, Host and Expect are the HTTP client's to set.
    expect(init?.headers).toEqual([["content-type", "application/pdf"], ["x-amz-checksum-sha256", sha256.toString("base64")]]);
    expect(result.output).toEqual({
      content: expect.stringContaining(`Uploaded RFP.pdf (${bytes.byteLength} bytes) to https://connect-rfp.s3.eu-west-1.amazonaws.com/work-winning/rfp/identification/id-1/email-attachments/RFP.pdf with PUT: HTTP 200.`),
      path: "/workspace/inputs/file-1/RFP.pdf",
      destination: "https://connect-rfp.s3.eu-west-1.amazonaws.com/work-winning/rfp/identification/id-1/email-attachments/RFP.pdf",
      method: "PUT",
      status: 200,
      sizeBytes: bytes.byteLength,
      sha256: sha256.toString("hex"),
      sha256Base64: sha256.toString("base64"),
      contentType: "application/pdf",
      etag: '"etag-1"',
      versionId: "version-1",
      checksumConfirmed: true,
    });
    expect(String(result.output.content)).toContain("The storage service confirmed the SHA-256 checksum.");
    expect(JSON.stringify(result)).not.toMatch(/X-Amz-Signature|secret-session-token|ASIAEXAMPLE/);
  });

  it.each([
    [{ "x-amz-checksum-sha256": Buffer.alloc(32).toString("base64") }, "x-amz-checksum-sha256 expected SHA-256"],
    [{ "x-amz-content-sha256": "0".repeat(64) }, "x-amz-content-sha256 expected SHA-256"],
    [{ "Content-MD5": "AAAAAAAAAAAAAAAAAAAAAA==" }, "Content-MD5 expected"],
    [{ "x-goog-hash": "crc32c=AAAAAA==,md5=AAAAAAAAAAAAAAAAAAAAAA==" }, "x-goog-hash expected MD5"],
    [{ "Content-Length": "1" }, "Content-Length expected 1 bytes"],
  ])("refuses to send a file that does not match %j", async (headers, problem) => {
    const send = storage(new Response(null, { status: 200 }));
    await expect(uploadFileBytes({ upload: input({ headers }), bytes, policy: open, fetch: send }))
      .rejects.toThrow(problem);
    await expect(uploadFileBytes({ upload: input({ headers }), bytes, policy: open, fetch: send }))
      .rejects.toThrow("Nothing was sent");
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts matching MD5 and unsigned-payload headers", async () => {
    const send = storage(new Response(null, { status: 200 }));
    const upload = input({ headers: { "Content-MD5": md5, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-goog-hash": `crc32c=AAAAAA==,md5=${md5}` } });
    await expect(uploadFileBytes({ upload, bytes, policy: open, fetch: send })).resolves.toMatchObject({ output: { status: 200, checksumConfirmed: false } });
  });

  it("reports a refused upload with the storage reason and no signing material", async () => {
    const error = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message>",
      "<AWSAccessKeyId>ASIAEXAMPLE</AWSAccessKeyId><StringToSign>AWS4-HMAC-SHA256 20261021T000000Z secret-session-token</StringToSign>",
      `<CanonicalRequest>PUT /key ${signedUrl}</CanonicalRequest><SignatureProvided>0123456789abcdef</SignatureProvided></Error>`,
    ].join("");
    const send = storage(new Response(error, { status: 403, headers: { "content-type": "application/xml" } }));

    const failure = await uploadFileBytes({ upload: input(), bytes, policy: open, fetch: send }).catch((caught: Error) => caught);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("failed with HTTP 403 (SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.)");
    expect((failure as Error).message).toContain("Request a new upload URL and pass its headers exactly");
    expect((failure as Error).message).not.toMatch(/ASIAEXAMPLE|secret-session-token|0123456789abcdef|X-Amz/);
  });

  it("does not follow a redirect", async () => {
    const send = storage(new Response(null, { status: 307, headers: { location: "https://elsewhere.example.com/key" } }));
    await expect(uploadFileBytes({ upload: input(), bytes, policy: open, fetch: send })).rejects.toThrow("Berry does not follow redirects for uploads");
    expect(send).toHaveBeenCalledOnce();
  });

  it("treats a storage checksum that differs from the bytes sent as a failed upload", async () => {
    const send = storage(new Response(null, { status: 200, headers: { "x-amz-checksum-sha256": Buffer.alloc(32).toString("base64") } }));
    await expect(uploadFileBytes({ upload: input(), bytes, policy: open, fetch: send })).rejects.toThrow("Treat the upload as failed");
  });

  it("calls a storage server error temporary", async () => {
    const send = storage(new Response("<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>", { status: 503 }));
    await expect(uploadFileBytes({ upload: input(), bytes, policy: open, fetch: send })).rejects.toThrow("one retry of the same upload is reasonable");
  });
});

describe("storage error reasons", () => {
  it("keeps JSON error messages and removes URLs' signed queries and long tokens", () => {
    expect(storageErrorReason(JSON.stringify({ error: { code: "AuthenticationFailed", message: `Signature expired for ${signedUrl}` } })))
      .toBe("AuthenticationFailed: Signature expired for https://connect-rfp.s3.eu-west-1.amazonaws.com/work-winning/rfp/identification/id-1/email-attachments/RFP.pdf");
    expect(storageErrorReason("token sv=2024&sig=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd denied")).toBe("token sv=2024&sig=[redacted] denied");
    expect(storageErrorReason("<html><body>Forbidden</body></html>")).toBe("");
  });
});
