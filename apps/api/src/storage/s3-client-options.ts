import type { S3ClientConfig } from "@aws-sdk/client-s3";

export function s3ClientOptions(input: {
  endpoint?: string | undefined;
  region?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}): S3ClientConfig {
  if (Boolean(input.accessKeyId) !== Boolean(input.secretAccessKey)) {
    throw new Error("S3 access key ID and secret access key must be configured together");
  }
  return {
    region: input.region ?? "eu-west-1",
    ...(input.endpoint ? { endpoint: input.endpoint, forcePathStyle: true } : {}),
    ...(input.accessKeyId && input.secretAccessKey ? { credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey } } : {}),
  };
}

export function s3PresignClientOptions(input: Parameters<typeof s3ClientOptions>[0]): S3ClientConfig {
  return {
    ...s3ClientOptions(input),
    requestChecksumCalculation: "WHEN_REQUIRED",
  };
}
