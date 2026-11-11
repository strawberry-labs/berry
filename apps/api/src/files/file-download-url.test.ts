import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { FilePlatformService } from "./file-platform.service.ts";

function setup() {
  const client = new S3Client({ region: "eu-west-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  const service = new FilePlatformService({} as never, { client, presignClient: client } as never);
  const get = vi.spyOn(service, "get").mockResolvedValue({ status: "available", bucket: "private-test", object_key: "private/file.zip", object_version_id: "version-one", display_name: 'test\r\nfile.zip', blob_id: "blob", resolved_verification_status: "verified" } as never);
  return { service, get };
}
describe("direct attachment downloads", () => {
  it("authorizes before signing a version-pinned, non-cacheable attachment for 60 seconds", async () => {
    const { service, get } = setup();
    const result = await service.downloadUrl("tenant", "user", "file");
    const url = new URL(result.url);
    expect(get).toHaveBeenCalledWith("tenant", "user", "file");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("versionId")).toBe("version-one");
    expect(url.searchParams.get("response-content-type")).toBe("application/octet-stream");
    expect(url.searchParams.get("response-cache-control")).toBe("private, no-store");
    expect(url.searchParams.get("response-content-disposition")).toMatch(/^attachment;/);
    expect(url.searchParams.get("response-content-disposition")).not.toMatch(/[\r\n]/);
  });
  it("refuses an unauthorized file", async () => {
    const { service, get } = setup(); get.mockRejectedValue(new Error("denied"));
    await expect(service.downloadUrl("tenant", "other", "file")).rejects.toThrow("denied");
  });
  it("refuses unverified storage", async () => {
    const { service, get } = setup(); get.mockResolvedValue({ status: "available", blob_id: "blob", resolved_verification_status: "pending" } as never);
    await expect(service.downloadUrl("tenant", "user", "file")).rejects.toThrow("not available");
  });
});
