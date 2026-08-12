import type { S3Client } from "@aws-sdk/client-s3";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  backfillS3ClientOptions,
  recoverSkill,
  type LegacySkill,
} from "./backfill-skill-packages.js";

const fileId = "8c96a708-3ca5-4665-a902-d7ab635fbe14";
const sourceBytes = Buffer.from("template-bytes");

describe("skill package backfill execution", () => {
  it("uses the configured S3-compatible endpoint and static credentials", () => {
    expect(backfillS3ClientOptions({
      AWS_REGION: "eu-central-1",
      BERRY_ARTIFACT_S3_ENDPOINT: "http://minio:9000",
      BERRY_ARTIFACT_S3_REGION: "us-east-1",
      BERRY_ARTIFACT_S3_ACCESS_KEY_ID: "berry",
      BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY: "secret",
    })).toEqual({
      endpoint: "http://minio:9000",
      forcePathStyle: true,
      region: "us-east-1",
      credentials: { accessKeyId: "berry", secretAccessKey: "secret" },
    });
  });

  it("falls back to the runtime AWS region without forcing path-style requests", () => {
    expect(backfillS3ClientOptions({ AWS_REGION: "ap-southeast-2" })).toEqual({
      region: "ap-southeast-2",
    });
  });

  it.each(["personal", "organization"] as const)(
    "rejects a stale %s snapshot before inserting recovered resources",
    async (kind) => {
      const skill: LegacySkill = {
        kind,
        id: `${kind}-memo-skill`,
        tenant_id: "20000000-0000-7000-8000-000000000001",
        user_id: kind === "personal" ? "user-1" : null,
        name: "memo",
        content: `Open /workspace/inputs/${fileId}/template.docx.`,
        snapshot_hash: "snapshot-hash",
      };
      const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
      const client = {
        query: async (sql: string, params: readonly unknown[] = []) => {
          calls.push({ sql, params });
          if (sql.startsWith("SELECT path,content,mode")) return { rows: [], rowCount: 0 };
          if (sql.includes("FROM files f")) {
            return {
              rows: [{
                id: fileId,
                owner_user_id: skill.user_id,
                display_name: "template.docx",
                bucket: "artifacts",
                object_key: "objects/template.docx",
                object_version_id: null,
                size_bytes: sourceBytes.byteLength,
                status: "available",
              }],
              rowCount: 1,
            };
          }
          if (sql.startsWith("UPDATE ")) return { rows: [], rowCount: 0 };
          if (sql.startsWith("INSERT INTO ")) return { rows: [], rowCount: 1 };
          throw new Error(`Unexpected query: ${sql}`);
        },
      } as unknown as PoolClient;
      const s3 = {
        send: async () => ({
          Body: { transformToByteArray: async () => sourceBytes },
        }),
      } as unknown as Pick<S3Client, "send">;

      await expect(recoverSkill(client, s3, skill, true)).rejects.toThrow(
        "changed during package recovery",
      );

      const update = calls.find((call) => call.sql.startsWith("UPDATE "));
      expect(update?.sql).toContain(kind === "personal" ? "AND content=$4" : "AND config->>'content'=$4");
      expect(update?.sql).toContain("IS NOT DISTINCT FROM $5::text");
      expect(update?.params.slice(3)).toEqual([skill.content, "snapshot-hash"]);
      expect(calls.some((call) => call.sql.startsWith("INSERT INTO "))).toBe(false);
    },
  );
});
