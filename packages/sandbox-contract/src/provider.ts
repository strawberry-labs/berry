import type {
  SandboxCreateInput,
  SandboxDestroyInput,
  SandboxDestroyResult,
  SandboxExecEvent,
  SandboxExecInput,
  SandboxExposePortInput,
  SandboxExposePortResult,
  SandboxFileListInput,
  SandboxFileListResult,
  SandboxFileReadInput,
  SandboxFileReadResult,
  SandboxFileWriteInput,
  SandboxFileWriteResult,
  SandboxHandle,
  SandboxProviderKind,
  SandboxResumeInput,
} from "./schemas.js";

export class SandboxPausedError extends Error {
  readonly code = "sandbox_paused";

  constructor(readonly sandboxId: string) {
    super(`Sandbox is paused and requires an explicit resume: ${sandboxId}`);
    this.name = "SandboxPausedError";
  }
}

export interface SandboxFileWriteBytesInput {
  sandbox_id: string;
  path: string;
  content: Uint8Array;
  mode?: number;
}

export interface SandboxFileWriteManyBytesInput {
  sandbox_id: string;
  files: readonly Omit<SandboxFileWriteBytesInput, "sandbox_id">[];
}

export interface SandboxFileApi {
  read(input: SandboxFileReadInput): Promise<SandboxFileReadResult>;
  write(input: SandboxFileWriteInput): Promise<SandboxFileWriteResult>;
  /**
   * Write binary content without first expanding it into a base64 string.
   * Providers that cannot transport bytes directly may omit this method; callers
   * must retain the base64 `write` fallback for contract compatibility.
   */
  writeBytes?(input: SandboxFileWriteBytesInput): Promise<SandboxFileWriteResult>;
  /** Write several binary files in one provider operation when supported. */
  writeManyBytes?(input: SandboxFileWriteManyBytesInput): Promise<SandboxFileWriteResult[]>;
  list(input: SandboxFileListInput): Promise<SandboxFileListResult>;
}

export interface SandboxProvider {
  readonly kind: SandboxProviderKind;
  readonly supportsPause?: boolean;
  readonly supportsResume?: boolean;
  create(input: SandboxCreateInput): Promise<SandboxHandle>;
  exec(input: SandboxExecInput, options?: { signal?: AbortSignal | undefined }): AsyncIterable<SandboxExecEvent>;
  readonly files: SandboxFileApi;
  exposePort(input: SandboxExposePortInput): Promise<SandboxExposePortResult>;
  /**
   * Stop billing compute while retaining the sandbox filesystem for a later
   * reconnect. Providers without durable pause support may omit this method.
   */
  suspend?(input: SandboxDestroyInput): Promise<SandboxDestroyResult>;
  /**
   * Explicitly resume a paused sandbox. Ordinary file, exec, and port calls
   * must not be used as implicit lifecycle transitions.
   */
  resume?(input: SandboxResumeInput): Promise<SandboxHandle>;
  destroy(input: SandboxDestroyInput): Promise<SandboxDestroyResult>;
  dispose?(): Promise<void>;
}

export async function collectSandboxExecEvents(events: AsyncIterable<SandboxExecEvent>): Promise<SandboxExecEvent[]> {
  const collected: SandboxExecEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export async function exerciseSandboxProviderContract(provider: SandboxProvider, options: {
  requestId: string;
  tenantId: string;
  image?: string | undefined;
}): Promise<{
  sandbox: SandboxHandle;
  execEvents: SandboxExecEvent[];
  file: SandboxFileReadResult;
  list: SandboxFileListResult;
  port: SandboxExposePortResult;
  destroy: SandboxDestroyResult;
}> {
  const sandbox = await provider.create({
    request_id: options.requestId,
    tenant_id: options.tenantId,
    image: options.image ?? "berry/contract-fixture:latest",
    cwd: "/workspace",
  });
  await provider.files.write({
    sandbox_id: sandbox.sandbox_id,
    path: "/workspace/result.txt",
    content: "contract-ok",
    encoding: "utf8",
  });
  const file = await provider.files.read({
    sandbox_id: sandbox.sandbox_id,
    path: "/workspace/result.txt",
    encoding: "utf8",
  });
  const list = await provider.files.list({
    sandbox_id: sandbox.sandbox_id,
    path: "/workspace",
    recursive: true,
  });
  const execEvents = await collectSandboxExecEvents(provider.exec({
    sandbox_id: sandbox.sandbox_id,
    request_id: `${options.requestId}:exec`,
    command: ["echo", "contract-ok"],
  }));
  const port = await provider.exposePort({
    sandbox_id: sandbox.sandbox_id,
    port: 3000,
    protocol: "http",
    visibility: "private",
  });
  const destroy = await provider.destroy({ sandbox_id: sandbox.sandbox_id, reason: "contract smoke complete" });
  return { sandbox, execEvents, file, list, port, destroy };
}
