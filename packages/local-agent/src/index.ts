export { applyPatch, ApplyPatchError, parsePatch, type ApplyPatchResult, type PatchHunk, type PatchOperation } from "./apply-patch.ts";
export {
  approvalKindForRisk,
  canonicalGrantSubject,
  GrantStore,
  SlashCommandRegistry,
  ToolGuard,
  type ApprovalDecisionKind,
  type SlashCommandResult,
  type ToolGuardDecision,
  type ToolGuardRequest,
  type ToolRisk,
} from "./guard.ts";
export {
  McpToolSource,
  discoverRemoteMcpTools,
  mcpServerSpecsFromJson,
  validatedRemoteMcpUrl,
  type McpServerHealth,
  type McpServerSpec,
  type McpCachedTool,
  type McpToolSourceOptions,
} from "./mcp.ts";
export {
  createPublicRemoteFetch,
  isPublicRemoteAddress,
  resolvePublicRemoteUrl,
  validatedPublicRemoteUrl,
} from "./remote-fetch.ts";
export {
  completeRemoteMcpOAuth,
  refreshRemoteMcpOAuth,
  startRemoteMcpOAuth,
  type McpOAuthStartResult,
  type McpOAuthState,
} from "./mcp-oauth.ts";
export { HookRunner, loadHookConfiguration, parseHookConfig, type HookPayload, type LoadedHooks } from "./hooks.ts";
export { SandboxEnforcer, assertShellWritePolicy, resolveSandboxHelper, seatbeltProfile, type SandboxEnforcerOptions } from "./sandbox.ts";
export {
  AnthropicMessagesAdapter,
  BerryModelAdapter,
  BufferedChatCompletionClient,
  ContentFallbackChatCompletionClient,
  contextToAnthropicMessages,
  contextToAnthropicTools,
  contextToChatMessages,
  contextToChatTools,
  contextToResponsesInput,
  contextToResponsesTools,
  createBerryModel,
  createBerryModels,
  createProviderStreamFn,
  OpenAIResponsesAdapter,
  providerErrorFromAssistantMessage,
  routerRequestIdFromAssistantMessage,
  type BerryAssistantMessage,
  type BerryModelProviderInfo,
  type PromptCacheAdapterConfig,
  type BerryStreamFn,
} from "./model.ts";
export {
  buildPromptManifest,
  cacheKeyFor,
  canonicalJson,
  compareManifests,
  DYNAMIC_CONTEXT_BOUNDARY,
  joinStableAndDynamicPrompt,
  PromptCacheTracker,
  providerPromptText,
  resolvePromptCachingCapabilities,
  sha256,
  splitStablePrompt,
  type PromptCacheRequest,
} from "./prompt-cache.ts";
export {
  appendGroundingContext,
  appendPortableCheckpoint,
  BerryAgentRuntime,
  formatGroundingContext,
  type ApprovalRequestPayload,
  type AssistantMessagePayload,
  type BerryAgentRuntimeOptions,
  type RuntimeAttachment,
  type RuntimeContextStats,
  type RuntimeContextStatsOptions,
  type StartTurnOptions,
  type ToolCallPayload,
} from "./runtime.ts";
export { SqliteSessionRepo, SqliteSessionStorage, type SqliteSessionCreateOptions } from "./session-store.ts";
export {
  agentSkillRoots,
  discoverAgentSkills,
  existingAgentSkillRoots,
  loadAgentSkills,
  type AgentSkill,
  type AgentSkillDiagnostic,
  type AgentSkillRoot,
  type AgentSkillScope,
} from "./skills.ts";
export {
  builtInSubagents,
  createUserSubagent,
  deleteUserSubagent,
  findSubagent,
  loadSubagents,
  parseSubagentMarkdown,
  serializeSubagentMarkdown,
  setUserSubagentEnabled,
  userSubagentDir,
  workspaceSubagentDir,
} from "./subagents.ts";
export {
  createBerryTools,
  browserOrigin,
  frameUntrustedBrowserContent,
  riskForToolName,
  type BerryToolRisk,
  type BerryToolsOptions,
  type BrowserToolBridge,
  type BrowserToolMethod,
  type MemoryToolBridge,
  type PersonalSkillToolBridge,
  type WebToolBridge,
  type WebToolMethod,
} from "./tools.ts";
export {
  conversationProfilePrompt,
} from "./conversation-profiles.ts";
export { recordUsage, summarizeUsage, type UsageRecordInput, type UsageSummary } from "./usage.ts";
export { runReadOnlyReviewAgent, type ReadOnlyReviewAgentOptions } from "./review.ts";
export {
  CloudSandboxProvider,
  S3CompatibleArtifactStore,
  SandboxExecutionEnv,
  type ArtifactStore,
  type CloudSandboxProviderOptions,
  type ObjectPutClient,
  type SandboxExecutionEnvOptions,
} from "./cloud-sandbox.ts";
export { LocalProvider, type LocalProviderOptions, type SandboxProvider, type SandboxSession, type SandboxSessionOptions } from "./sandbox-provider.ts";
export { RuntimeSessionHost, type SessionHost } from "./session-host.ts";
export {
  assertWritableWorkspacePath,
  safeWorkspacePath,
  workspaceWritePolicyReason,
  WorkspacePathError,
  WorkspaceWritePolicyError,
} from "./workspace-path.ts";

// Re-exported for hosts/tests that script the model stream without a network.
export { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
