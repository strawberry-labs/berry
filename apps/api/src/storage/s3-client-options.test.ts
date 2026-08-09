import { PutObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { describe, expect, it } from "vitest";
import { s3ClientOptions, s3PresignClientOptions } from "./s3-client-options.ts";

describe("s3ClientOptions", () => {
  it("uses the AWS credential chain and Ireland region by default", () => {
    expect(s3ClientOptions({})).toEqual({ region: "eu-west-1" });
  });

  it("uses path-style requests and static credentials only for explicit S3-compatible configuration", () => {
    expect(s3ClientOptions({
      endpoint: "http://minio:9000",
      region: "us-east-1",
      accessKeyId: "berry",
      secretAccessKey: "secret",
    })).toEqual({
      endpoint: "http://minio:9000",
      forcePathStyle: true,
      region: "us-east-1",
      credentials: { accessKeyId: "berry", secretAccessKey: "secret" },
    });
  });

  it("rejects a partial static credential pair", () => {
    expect(() => s3ClientOptions({ accessKeyId: "berry" })).toThrow("configured together");
  });

  it("does not bind direct or multipart browser uploads to the checksum of an empty command body", async () => {
    const client = new S3Client(s3PresignClientOptions({
      region: "eu-west-1",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    }));
    try {
      const signedUrls = await Promise.all([
        getSignedUrl(client, new PutObjectCommand({
          Bucket: "berry-test",
          Key: "uploads/report.pdf",
          ContentType: "application/pdf",
        }), { expiresIn: 60 }),
        getSignedUrl(client, new UploadPartCommand({
          Bucket: "berry-test",
          Key: "uploads/report.pdf",
          UploadId: "multipart-upload-id",
          PartNumber: 1,
        }), { expiresIn: 60 }),
      ]);

      for (const value of signedUrls) {
        const signed = new URL(value);
        expect(signed.searchParams.has("x-amz-checksum-crc32")).toBe(false);
        expect(signed.searchParams.has("x-amz-sdk-checksum-algorithm")).toBe(false);
      }
    } finally {
      client.destroy();
    }
  });
});
