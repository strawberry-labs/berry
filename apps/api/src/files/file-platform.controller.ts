import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Post, Query, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { OrganizationBrandingAssetKindSchema } from "@berry/shared";
import { z } from "zod";
import { PublicAuth } from "../auth/auth.decorators.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { FilePlatformService } from "./file-platform.service.ts";
import { INVALID_FILE_CACHE_CONTROL, normalizeMediaType } from "./file-response-security.ts";

const UploadMediaTypeSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => normalizeMediaType(value) !== null, "A valid MIME media type is required")
  .transform((value) => normalizeMediaType(value)!)
  .default("application/octet-stream");

const InitiateSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mediaType: UploadMediaTypeSchema,
  size: z.number().int().nonnegative(),
  taskId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  workspaceVisibility: z.enum(["project", "task_only"]).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  origin: z.enum(["user_upload", "image_generation", "browser_capture"]).default("user_upload"),
  associationRole: z.enum(["input", "output", "reference"]).default("input"),
}).strict();

const PartNumbersSchema = z.object({ partNumbers: z.array(z.number().int().positive()).min(1).max(100) }).strict();
const CompleteSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }).strict()).min(1).max(10_000),
}).strict();
const ListSchema = z.object({
  taskId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  category: z.enum(["images", "documents"]).optional(),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const WorkspaceFileListSchema = z.object({
  visibility: z.enum(["project", "task_only"]).optional(),
  status: z.enum(["pending", "extracting", "chunking", "embedding", "indexed", "failed"]).optional(),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

@Controller("/v1/files")
export class FilePlatformController {
  constructor(@Inject(FilePlatformService) private readonly files: FilePlatformService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const parsed = parse(ListSchema, query);
    return this.files.list(tenant(), user(request), {
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
      ...(parsed.category ? { category: parsed.category } : {}),
      ...(parsed.search ? { search: parsed.search } : {}),
      ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      ...(parsed.limit ? { limit: parsed.limit } : {}),
    });
  }

  @Get(":fileId")
  async get(@Req() request: AuthenticatedRequest, @Param("fileId") fileId: string) {
    return this.files.describe(tenant(), user(request), z.string().uuid().parse(fileId));
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
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.workspaceVisibility ? { workspaceVisibility: input.workspaceVisibility } : {}),
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
    response.setHeader("Cache-Control", INVALID_FILE_CACHE_CONTROL);
    return this.files.streamContent(
      tenant(),
      user(request),
      parse(z.string().uuid(), fileId),
      typeof request.headers.range === "string" ? request.headers.range : undefined,
      response,
      download === "1",
      typeof request.headers["if-none-match"] === "string" ? request.headers["if-none-match"] : undefined,
    );
  }

  @Delete(":fileId")
  remove(@Req() request: AuthenticatedRequest, @Param("fileId") fileId: string) {
    return this.files.removeFromLibrary(tenant(), user(request), parse(z.string().uuid(), fileId));
  }
}

@Controller("/v1/branding")
@PublicAuth()
export class BrandingAssetController {
  constructor(@Inject(FilePlatformService) private readonly files: FilePlatformService) {}

  @Get(":kind")
  content(
    @Req() request: IncomingMessage,
    @Param("kind") kind: string,
    @Query("v") version: string | undefined,
    @Res() response: ServerResponse,
  ) {
    response.setHeader("Cache-Control", INVALID_FILE_CACHE_CONTROL);
    return this.files.streamBrandingAsset(
      tenant(),
      parse(OrganizationBrandingAssetKindSchema, kind),
      version,
      response,
      typeof request.headers["if-none-match"] === "string" ? request.headers["if-none-match"] : undefined,
    );
  }
}

@Controller("/v1/workspaces/:workspaceId/files")
export class WorkspaceFileController {
  constructor(@Inject(FilePlatformService) private readonly files: FilePlatformService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Param("workspaceId") workspaceId: string, @Query() query: Record<string, unknown>) {
    const parsed = parse(WorkspaceFileListSchema, query);
    return this.files.listWorkspaceFiles(tenant(), user(request), z.string().uuid().parse(workspaceId), {
      ...(parsed.visibility ? { visibility: parsed.visibility } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
      ...(parsed.search ? { search: parsed.search } : {}),
      ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      ...(parsed.limit ? { limit: parsed.limit } : {}),
    });
  }

  @Post(":fileId/retry")
  retry(@Req() request: AuthenticatedRequest, @Param("workspaceId") workspaceId: string, @Param("fileId") fileId: string) {
    return this.files.retryWorkspaceFile(
      tenant(),
      user(request),
      z.string().uuid().parse(workspaceId),
      z.string().uuid().parse(fileId),
    );
  }

  @Delete(":fileId")
  unlink(@Req() request: AuthenticatedRequest, @Param("workspaceId") workspaceId: string, @Param("fileId") fileId: string) {
    return this.files.unlinkWorkspaceFile(
      tenant(),
      user(request),
      z.string().uuid().parse(workspaceId),
      z.string().uuid().parse(fileId),
    );
  }
}

function tenant(): string {
  return process.env.BERRY_TENANT_ID?.trim() || SELF_HOST_TENANT_ID;
}

function user(request: AuthenticatedRequest): string {
  const id = request.auth?.user.id;
  if (!id) throw new UnauthorizedException("Authentication required");
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
