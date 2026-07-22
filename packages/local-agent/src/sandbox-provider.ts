import type { ExecutionEnv } from "@berry/harness";
import { LocalProcessExecutor, NodeExecutionEnv, type CommandWrapper } from "@berry/harness/node";
import type { SandboxPolicy, SandboxStatus } from "@berry/shared";

import { SandboxEnforcer } from "./sandbox.ts";

export interface SandboxSession {
  env: ExecutionEnv;
  escalatedEnv: ExecutionEnv;
  status: SandboxStatus;
  commandWrapper?: CommandWrapper;
  dispose(): Promise<void>;
}

export interface SandboxSessionOptions {
  sessionId: string;
  taskId: string;
  workspacePath: string;
  policy: SandboxPolicy;
  enforceEscalated: boolean;
}

export interface SandboxProvider {
  readonly kind: "local" | "cloud";
  createSession(options: SandboxSessionOptions): Promise<SandboxSession>;
  dispose(): Promise<void>;
}

export interface LocalProviderOptions {
  processExecutor?: LocalProcessExecutor;
}

export class LocalProvider implements SandboxProvider {
  readonly kind = "local" as const;
  readonly #processExecutor: LocalProcessExecutor;
  readonly #ownsProcessExecutor: boolean;

  constructor(options: LocalProviderOptions = {}) {
    this.#processExecutor = options.processExecutor ?? new LocalProcessExecutor();
    this.#ownsProcessExecutor = options.processExecutor === undefined;
  }

  async createSession(options: SandboxSessionOptions): Promise<SandboxSession> {
    const enforcer = new SandboxEnforcer();
    const commandWrapper = enforcer.commandWrapper(options.policy);
    return {
      env: new NodeExecutionEnv({ cwd: options.workspacePath, processExecutor: this.#processExecutor, commandWrapper }),
      escalatedEnv: new NodeExecutionEnv({
        cwd: options.workspacePath,
        processExecutor: this.#processExecutor,
        ...(options.enforceEscalated ? { commandWrapper } : {}),
      }),
      status: enforcer.status(options.policy),
      commandWrapper,
      dispose: async () => {},
    };
  }

  async dispose(): Promise<void> {
    if (this.#ownsProcessExecutor) await this.#processExecutor.dispose();
  }
}
