import { AgentHarness, InMemorySessionRepo, type AgentTool, type StreamFn } from "@berry/harness";
import { LocalProcessExecutor, NodeExecutionEnv } from "@berry/harness/node";
import { sandboxPolicyForPermission } from "@berry/shared";
import { createBerryModel, createBerryModels, createProviderStreamFn, type BerryModelProviderInfo } from "./model.ts";
import { SandboxEnforcer } from "./sandbox.ts";
import { createBerryTools } from "./tools.ts";

const REVIEW_TOOLS = new Set(["read_file", "list_dir", "glob", "grep", "git_status", "git_diff", "git_log"]);

export interface ReadOnlyReviewAgentOptions {
  workspacePath: string;
  provider: BerryModelProviderInfo;
  apiKey?: string;
  model?: string;
  streamFn?: StreamFn;
  systemPrompt: string;
  prompt: string;
  signal?: AbortSignal;
}

export async function runReadOnlyReviewAgent(options: ReadOnlyReviewAgentOptions): Promise<string> {
  const policy = sandboxPolicyForPermission("plan", options.workspacePath);
  const processExecutor = new LocalProcessExecutor();
  const env = new NodeExecutionEnv({
    cwd: options.workspacePath,
    processExecutor,
    commandWrapper: new SandboxEnforcer().commandWrapper(policy),
  });
  const tools = createBerryTools({ workspacePath: options.workspacePath, env, escalatedEnv: env })
    .filter((tool): tool is AgentTool => REVIEW_TOOLS.has(tool.name));
  const session = await new InMemorySessionRepo().create({});
  const model = createBerryModel(options.provider, options.model, { reasoning: false });
  const streamFn = options.streamFn ?? createProviderStreamFn(options.provider, options.apiKey);
  const harness = new AgentHarness({
    env,
    session,
    models: createBerryModels(streamFn, [model]),
    tools,
    model,
    thinkingLevel: "off",
    systemPrompt: options.systemPrompt,
    resources: { skills: [] },
  });
  if (options.signal?.aborted) throw new Error("Review cancelled");
  const onAbort = () => void harness.abort().catch(() => {});
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const message = await harness.prompt(options.prompt);
    return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim();
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
