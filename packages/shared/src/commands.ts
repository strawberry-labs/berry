import type { CommandManifest } from "./index.ts";

export interface BuiltInCommandDefinition {
  name: string;
  description: string;
  surfaces: readonly ("desktop" | "web")[];
}

export const BUILT_IN_COMMANDS: readonly BuiltInCommandDefinition[] = [
  { name: "help", description: "Show available commands", surfaces: ["desktop", "web"] },
  { name: "new", description: "Start a new conversation", surfaces: ["desktop", "web"] },
  { name: "resume", description: "Resume a prior conversation or session", surfaces: ["desktop"] },
  { name: "compact", description: "Compact the active session", surfaces: ["desktop", "web"] },
  { name: "fork", description: "Fork from the current session point", surfaces: ["desktop", "web"] },
  { name: "rewind", description: "Rewind the active session", surfaces: ["desktop", "web"] },
  { name: "goal", description: "Set, pause, resume, or clear the session goal", surfaces: ["desktop", "web"] },
  { name: "pr", description: "Create or review the task pull request", surfaces: ["desktop", "web"] },
  { name: "image", description: "Generate an image from a prompt", surfaces: ["desktop", "web"] },
  { name: "model", description: "Change the active model", surfaces: ["desktop"] },
  { name: "mcp", description: "Inspect MCP servers", surfaces: ["desktop", "web"] },
  { name: "skill", description: "Inspect loaded skills", surfaces: ["desktop", "web"] },
  { name: "clear", description: "Clear the current composer", surfaces: ["desktop", "web"] },
  { name: "logs", description: "Open logs and diagnostics", surfaces: ["desktop"] },
] as const;

export function builtInCommandManifests(now: string, surface?: "desktop" | "web"): CommandManifest[] {
  return BUILT_IN_COMMANDS
    .filter((definition) => !surface || definition.surfaces.includes(surface))
    .map((definition) => ({
      id: `slash_${definition.name}`,
      workspaceId: null,
      name: definition.name,
      description: definition.description,
      command: `/${definition.name}`,
      args: [],
      sourcePath: null,
      trusted: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }));
}

export function parseSlashCommand(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawName = "", ...args] = trimmed.split(/\s+/);
  const name = rawName.slice(1).toLowerCase();
  return name ? { name, args } : null;
}
