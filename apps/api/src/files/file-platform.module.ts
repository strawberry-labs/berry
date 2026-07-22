import { Global, Module } from "@nestjs/common";
import { S3Client } from "@aws-sdk/client-s3";
import { FilePlatformController } from "./file-platform.controller.ts";
import { FILE_STORAGE_CONFIG, FilePlatformService, type FileStorageConfig } from "./file-platform.service.ts";

@Global()
@Module({
  controllers: [FilePlatformController],
  providers: [
    {
      provide: FILE_STORAGE_CONFIG,
      useFactory: (): FileStorageConfig | null => {
        const endpoint = process.env.BERRY_ARTIFACT_S3_ENDPOINT;
        const bucket = process.env.BERRY_ARTIFACT_S3_BUCKET;
        const accessKeyId = process.env.BERRY_ARTIFACT_S3_ACCESS_KEY_ID;
        const secretAccessKey = process.env.BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY;
        if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
        const clientOptions = {
          region: process.env.BERRY_ARTIFACT_S3_REGION ?? "us-east-1",
          forcePathStyle: true,
          credentials: { accessKeyId, secretAccessKey },
        };
        return {
          client: new S3Client({ ...clientOptions, endpoint }),
          presignClient: new S3Client({
            ...clientOptions,
            endpoint: process.env.BERRY_ARTIFACT_S3_PUBLIC_ENDPOINT ?? endpoint,
          }),
          bucket,
          prefix: (process.env.BERRY_ARTIFACT_S3_PREFIX ?? "artifacts").replace(/^\/+|\/+$/g, ""),
          maxUploadBytes: positiveInteger(process.env.BERRY_FILE_MAX_UPLOAD_BYTES, 1024 * 1024 * 1024),
          partSize: Math.max(5 * 1024 * 1024, positiveInteger(process.env.BERRY_FILE_MULTIPART_PART_SIZE, 16 * 1024 * 1024)),
          presignSeconds: Math.min(3600, positiveInteger(process.env.BERRY_FILE_PRESIGN_SECONDS, 900)),
        };
      },
    },
    FilePlatformService,
  ],
  exports: [FilePlatformService, FILE_STORAGE_CONFIG],
})
export class FilePlatformModule {}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
