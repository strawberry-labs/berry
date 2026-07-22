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
} from "./schemas.js";

export interface SandboxFileApi {
  read(input: SandboxFileReadInput): Promise<SandboxFileReadResult>;
  write(input: SandboxFileWriteInput): Promise<SandboxFileWriteResult>;
  list(input: SandboxFileListInput): Promise<SandboxFileListResult>;
}

export interface SandboxProvider {
  readonly kind: SandboxProviderKind;
  create(input: SandboxCreateInput): Promise<SandboxHandle>;
  exec(input: SandboxExecInput, options?: { signal?: AbortSignal | undefined }): AsyncIterable<SandboxExecEvent>;
  readonly files: SandboxFileApi;
  exposePort(input: SandboxExposePortInput): Promise<SandboxExposePortResult>;
  /**
   * Stop billing compute while retaining the sandbox filesystem for a later
   * reconnect. Providers without durable pause support may omit this method.
   */
  suspend?(input: SandboxDestroyInput): Promise<SandboxDestroyResult>;
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
