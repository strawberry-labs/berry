import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadSourcedSkills, type ExecutionEnv, type Skill, type SkillDiagnostic } from "@berry/harness";
import { NodeExecutionEnv } from "@berry/harness/node";

export type AgentSkillScope = "workspace" | "workspace-legacy" | "user" | "user-legacy" | "codex" | "registered" | "plugin";

export interface AgentSkillRoot {
  path: string;
  scope: AgentSkillScope;
}

export interface AgentSkill extends Skill {
  scope: AgentSkillScope;
}

export interface AgentSkillDiagnostic extends SkillDiagnostic {
  source: AgentSkillScope;
}

function envPath(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function pushUnique(roots: AgentSkillRoot[], seen: Set<string>, root: AgentSkillRoot): void {
  const path = resolve(root.path);
  if (seen.has(path)) return;
  seen.add(path);
  roots.push({ ...root, path });
}

/**
 * Agents-standard skill discovery paths, ordered by precedence.
 *
 * Project `.agents/skills` wins over legacy `.berry/skills`, then user/global
 * `.agents/skills`, Codex global skills, and finally Berry legacy user skills.
 */
export function agentSkillRoots(workspacePath?: string): AgentSkillRoot[] {
  const roots: AgentSkillRoot[] = [];
  const seen = new Set<string>();
  if (workspacePath) {
    pushUnique(roots, seen, { scope: "workspace", path: join(workspacePath, ".agents", "skills") });
    pushUnique(roots, seen, { scope: "workspace-legacy", path: join(workspacePath, ".berry", "skills") });
  }
  const agentsHome = envPath("AGENTS_HOME", join(homedir(), ".agents"));
  pushUnique(roots, seen, { scope: "user", path: join(agentsHome, "skills") });
  const codexHome = envPath("CODEX_HOME", join(homedir(), ".codex"));
  pushUnique(roots, seen, { scope: "codex", path: join(codexHome, "skills") });
  const berryHome = envPath("BERRY_HOME", join(homedir(), ".berry"));
  pushUnique(roots, seen, { scope: "user-legacy", path: join(berryHome, "skills") });
  return roots;
}

export function existingAgentSkillRoots(workspacePath?: string): AgentSkillRoot[] {
  return agentSkillRoots(workspacePath).filter((root) => existsSync(root.path));
}

export async function loadAgentSkills(
  env: ExecutionEnv,
  workspacePath?: string,
): Promise<{ skills: AgentSkill[]; diagnostics: AgentSkillDiagnostic[]; roots: AgentSkillRoot[] }> {
  const roots = existingAgentSkillRoots(workspacePath);
  const loaded = await loadSourcedSkills<AgentSkillScope, AgentSkill>(
    env,
    roots.map((root) => ({ path: root.path, source: root.scope })),
    (skill, scope) => ({ ...skill, scope }),
  );
  const rootByScope = new Map(roots.map((root) => [root.scope, root.path]));
  const directChildren = loaded.skills
    .map((entry) => entry.skill)
    .filter((skill) => {
      const root = rootByScope.get(skill.scope);
      if (!root) return false;
      const rel = resolve(skill.filePath).slice(resolve(root).length + 1).split(/[\\/]/);
      return rel.length === 2 && rel[1] === "SKILL.md";
    });
  return {
    skills: directChildren,
    diagnostics: loaded.diagnostics.map((diagnostic) => ({ ...diagnostic, source: diagnostic.source })),
    roots,
  };
}

export async function discoverAgentSkills(workspacePath?: string): Promise<{
  skills: AgentSkill[];
  diagnostics: AgentSkillDiagnostic[];
  roots: AgentSkillRoot[];
}> {
  const env = new NodeExecutionEnv({ cwd: workspacePath ?? process.cwd() });
  return loadAgentSkills(env, workspacePath);
}
