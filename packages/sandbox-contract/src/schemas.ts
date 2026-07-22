import { z } from "zod";
import { ISODateSchema, JsonValueSchema, NetworkPolicySchema } from "@berry/shared";

const IdSchema = z.string().trim().min(1);
const PathSchema = z.string().trim().min(1);
const EnvSchema = z.record(z.string());

export const SandboxProviderKindSchema = z.enum(["docker", "e2b", "router", "commercial", "fixture"]);
export type SandboxProviderKind = z.infer<typeof SandboxProviderKindSchema>;

export const SandboxResourceLimitsSchema = z.object({
  cpuCount: z.number().positive().max(128).default(1),
  memoryMiB: z.number().int().positive().max(1_048_576).default(2048),
  storageMiB: z.number().int().positive().max(10_485_760).default(10_240),
  gpuModel: z.string().trim().min(1).optional(),
  gpuCount: z.number().int().positive().optional(),
}).passthrough();
export type SandboxResourceLimits = z.infer<typeof SandboxResourceLimitsSchema>;

export const SandboxMountSchema = z.object({
  host_path: PathSchema,
  sandbox_path: PathSchema,
  readonly: z.boolean().default(false),
}).passthrough();
export type SandboxMount = z.infer<typeof SandboxMountSchema>;

export const SandboxCreateInputSchema = z.object({
  request_id: IdSchema,
  tenant_id: z.string().uuid(),
  task_id: IdSchema.nullable().optional(),
  session_id: IdSchema.nullable().optional(),
  image: z.string().trim().min(1),
  snapshot_id: IdSchema.nullable().optional(),
  cwd: PathSchema.default("/workspace"),
  env: EnvSchema.default({}),
  resources: SandboxResourceLimitsSchema.default({}),
  ttl_seconds: z.number().int().positive().max(86_400).default(3600),
  network_policy: NetworkPolicySchema.default({ egress: "off", allowedDomains: [] }),
  writable_roots: z.array(PathSchema).default(["/workspace"]),
  mounts: z.array(SandboxMountSchema).default([]),
  metadata: JsonValueSchema.default({}),
}).passthrough();
export type SandboxCreateInput = z.input<typeof SandboxCreateInputSchema>;

export const SandboxHandleSchema = z.object({
  sandbox_id: IdSchema,
  request_id: IdSchema,
  tenant_id: z.string().uuid(),
  provider: z.string().trim().min(1),
  provider_kind: SandboxProviderKindSchema,
  status: z.enum(["creating", "running", "stopped", "failed"]),
  image: z.string().trim().min(1),
  cwd: PathSchema,
  created_at: ISODateSchema,
  expires_at: ISODateSchema.nullable(),
  metadata: JsonValueSchema.default({}),
}).passthrough();
export type SandboxHandle = z.infer<typeof SandboxHandleSchema>;

export const SandboxExecInputSchema = z.object({
  sandbox_id: IdSchema,
  request_id: IdSchema,
  command: z.array(z.string()).min(1).optional(),
  code: z.string().optional(),
  language: z.string().trim().min(1).optional(),
  cwd: PathSchema.optional(),
  env: EnvSchema.default({}),
  stdin: z.string().optional(),
  timeout_ms: z.number().int().positive().max(3_600_000).default(120_000),
  metadata: JsonValueSchema.default({}),
}).passthrough().refine((input) => Boolean(input.command) !== Boolean(input.code), {
  message: "Provide exactly one of command or code",
  path: ["command"],
});
export type SandboxExecInput = z.input<typeof SandboxExecInputSchema>;

export const SandboxExecEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), sandbox_id: IdSchema, request_id: IdSchema, pid: z.number().int().nonnegative().nullable().default(null) }),
  z.object({ kind: z.literal("stdout"), data: z.string() }),
  z.object({ kind: z.literal("stderr"), data: z.string() }),
  z.object({ kind: z.literal("exit"), exit_code: z.number().int().nullable(), signal: z.string().nullable().default(null) }),
  z.object({ kind: z.literal("error"), message: z.string(), code: z.string().optional() }),
  z.object({ kind: z.literal("usage"), event: z.lazy(() => SandboxUsageEventSchema) }),
]);
export type SandboxExecEvent = z.infer<typeof SandboxExecEventSchema>;

export const SandboxFileReadInputSchema = z.object({
  sandbox_id: IdSchema,
  path: PathSchema,
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
}).passthrough();
export type SandboxFileReadInput = z.input<typeof SandboxFileReadInputSchema>;

export const SandboxFileReadResultSchema = z.object({
  path: PathSchema,
  encoding: z.enum(["utf8", "base64"]),
  content: z.string(),
  size_bytes: z.number().int().nonnegative(),
  mtime: ISODateSchema.nullable(),
}).passthrough();
export type SandboxFileReadResult = z.infer<typeof SandboxFileReadResultSchema>;

export const SandboxFileWriteInputSchema = z.object({
  sandbox_id: IdSchema,
  path: PathSchema,
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  content: z.string(),
  mode: z.number().int().min(0).max(0o777).optional(),
}).passthrough();
export type SandboxFileWriteInput = z.input<typeof SandboxFileWriteInputSchema>;

export const SandboxFileWriteResultSchema = z.object({
  path: PathSchema,
  size_bytes: z.number().int().nonnegative(),
  mtime: ISODateSchema,
}).passthrough();
export type SandboxFileWriteResult = z.infer<typeof SandboxFileWriteResultSchema>;

export const SandboxFileListInputSchema = z.object({
  sandbox_id: IdSchema,
  path: PathSchema.default("/workspace"),
  recursive: z.boolean().default(false),
}).passthrough();
export type SandboxFileListInput = z.input<typeof SandboxFileListInputSchema>;

export const SandboxFileEntrySchema = z.object({
  path: PathSchema,
  type: z.enum(["file", "directory", "symlink"]),
  size_bytes: z.number().int().nonnegative(),
  mtime: ISODateSchema.nullable(),
}).passthrough();
export type SandboxFileEntry = z.infer<typeof SandboxFileEntrySchema>;

export const SandboxFileListResultSchema = z.object({
  path: PathSchema,
  entries: z.array(SandboxFileEntrySchema),
}).passthrough();
export type SandboxFileListResult = z.infer<typeof SandboxFileListResultSchema>;

export const SandboxExposePortInputSchema = z.object({
  sandbox_id: IdSchema,
  port: z.number().int().min(1).max(65_535),
  protocol: z.enum(["http", "https", "tcp"]).default("http"),
  visibility: z.enum(["private", "tenant", "public"]).default("private"),
}).passthrough();
export type SandboxExposePortInput = z.input<typeof SandboxExposePortInputSchema>;

export const SandboxExposePortResultSchema = z.object({
  sandbox_id: IdSchema,
  port: z.number().int().min(1).max(65_535),
  protocol: z.enum(["http", "https", "tcp"]),
  url: z.string().url(),
  expires_at: ISODateSchema.nullable(),
}).passthrough();
export type SandboxExposePortResult = z.infer<typeof SandboxExposePortResultSchema>;

export const SandboxDestroyInputSchema = z.object({
  sandbox_id: IdSchema,
  reason: z.string().trim().min(1).optional(),
}).passthrough();
export type SandboxDestroyInput = z.input<typeof SandboxDestroyInputSchema>;

export const SandboxDestroyResultSchema = z.object({
  sandbox_id: IdSchema,
  destroyed: z.boolean(),
  status: z.enum(["stopped", "missing"]),
}).passthrough();
export type SandboxDestroyResult = z.infer<typeof SandboxDestroyResultSchema>;

export const SandboxUsageEventSchema = z.object({
  request_id: IdSchema,
  sandbox_id: IdSchema,
  tenant_id: z.string().uuid(),
  provider: z.string().trim().min(1),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  price_version: z.string().trim().min(1),
  runtime_ms: z.number().nonnegative(),
  vcpu_seconds: z.number().nonnegative(),
  memory_gib_seconds: z.number().nonnegative(),
  storage_gib_seconds: z.number().nonnegative(),
  gpu_seconds: z.number().nonnegative().optional(),
  windows_vcpu_seconds: z.number().nonnegative().optional(),
  cpu_count: z.number().nonnegative().optional(),
  cpu_used_pct: z.number().min(0).max(100).optional(),
  mem_used_bytes: z.number().nonnegative().optional(),
  mem_total_bytes: z.number().nonnegative().optional(),
  disk_used_bytes: z.number().nonnegative().optional(),
  disk_total_bytes: z.number().nonnegative().optional(),
  bytes_in: z.number().nonnegative().optional(),
  bytes_out: z.number().nonnegative().optional(),
  network_bytes: z.number().nonnegative().optional(),
  provider_minimum_charge: z.string().trim().min(1).optional(),
  ts: ISODateSchema,
  metadata: JsonValueSchema.default({}),
}).passthrough();
export type SandboxUsageEvent = z.infer<typeof SandboxUsageEventSchema>;

export const SandboxUsageSignatureSchema = z.object({
  algorithm: z.literal("hmac-sha256"),
  key_id: IdSchema,
  signed_at: ISODateSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/),
});
export type SandboxUsageSignature = z.infer<typeof SandboxUsageSignatureSchema>;

export const SignedSandboxUsageEventSchema = z.object({
  event: SandboxUsageEventSchema,
  signature: SandboxUsageSignatureSchema,
});
export type SignedSandboxUsageEvent = z.infer<typeof SignedSandboxUsageEventSchema>;
