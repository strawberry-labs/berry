import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { ServerResponse } from "node:http";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { FilePlatformService } from "./file-platform.service.ts";

const InitiateSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mediaType: z.string().trim().min(1).max(255).default("application/octet-stream"),
  size: z.number().int().nonnegative(),
  taskId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  origin: z.enum(["user_upload", "image_generation", "browser_capture"]).default("user_upload"),
  associationRole: z.enum(["input", "output", "reference"]).default("input"),
}).strict();

const PartNumbersSchema = z.object({ partNumbers: z.array(z.number().int().positive()).min(1).max(100) }).strict();
const CompleteSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }).strict()).min(1).max(10_000),
}).strict();

@Controller("/v1/files")
export class FilePlatformController {
  constructor(@Inject(FilePlatformService) private readonly files: FilePlatformService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const parsed = z.object({
      taskId: z.string().uuid().optional(),
      category: z.enum(["images", "documents"]).optional(),
      search: z.string().max(200).optional(),
      cursor: z.string().max(1000).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).passthrough().parse(query);
    return this.files.list(tenant(), user(request), {
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      ...(parsed.category ? { category: parsed.category } : {}),
      ...(parsed.search ? { search: parsed.search } : {}),
      ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      ...(parsed.limit ? { limit: parsed.limit } : {}),
    });
  }

  @Get(":fileId")
  async get(@Req() request: AuthenticatedRequest, @Param("fileId") fileId: string) {
    const row = await this.files.get(tenant(), user(request), z.string().uuid().parse(fileId));
    return {
      id: row.id,
      name: row.display_name,
      originalName: row.original_name,
      mediaType: row.detected_media_type ?? row.media_type,
      detectedMediaType: row.detected_media_type,
      size: Number(row.size_bytes),
      sha256: row.sha256,
      origin: row.origin,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      taskIds: row.task_ids ?? [],
      roles: row.roles ?? [],
      downloadUrl: `/v1/files/${row.id}/content?download=1`,
      previewUrl: `/v1/files/${row.id}/content`,
    };
  }

  @Post("/uploads")
  initiate(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(InitiateSchema, body);
    return this.files.initiateUpload(tenant(), user(request), {
      name: input.name,
      mediaType: input.mediaType ?? "application/octet-stream",
      size: input.size,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
      origin: input.origin ?? "user_upload",
      associationRole: input.associationRole ?? "input",
    });
  }

  @Post(":fileId/uploads/:uploadId/parts")
  presign(@Req() request: AuthenticatedRequest, @Param("fileId") fileId: string, @Param("uploadId") uploadId: string, @Body() body: unknown) {
    const ids = parseIds(fileId, uploadId);
    return this.files.presignParts(tenant(), user(request), ids.fileId, ids.uploadId, parse(PartNumbersSchema, body).partNumbers);
  }

  @Post(":fileId/uploads/:uploadId/complete")
  complete(@Req() request: AuthenticatedRequest, @Param("fileId") fileId: string, @Param("uploadId") uploadId: string, @Body() body: unknown) {
    const ids = parseIds(fileId, uploadId);
    const input = parse(CompleteSchema, body);
    return this.files.completeUpload(tenant(), user(request), ids.fileId, ids.uploadId, input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })));
  }

  @Delete(":fileId/uploads/:uploadId")
  abort(@Req() request: AuthenticatedRequest, @Param("fileId") fileId: string, @Param("uploadId") uploadId: string) {
    const ids = parseIds(fileId, uploadId);
    return this.files.abortUpload(tenant(), user(request), ids.fileId, ids.uploadId);
  }

  @Get(":fileId/content")
  content(@Req() request: AuthenticatedRequest, @Param("fileId") fileId: string, @Query("download") download: string | undefined, @Res() response: ServerResponse) {
    return this.files.streamContent(tenant(), user(request), z.string().uuid().parse(fileId), typeof request.headers.range === "string" ? request.headers.range : undefined, response, download === "1");
  }
}

function tenant(): string {
  return process.env.BERRY_TENANT_ID?.trim() || SELF_HOST_TENANT_ID;
}

function user(request: AuthenticatedRequest): string {
  const id = request.auth?.user.id;
  if (!id) throw new BadRequestException("Authenticated user is required");
  return id;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues.map((issue) => issue.message).join("; "));
  return result.data;
}

function parseIds(fileId: string, uploadId: string) {
  return z.object({ fileId: z.string().uuid(), uploadId: z.string().uuid() }).parse({ fileId, uploadId });
}
