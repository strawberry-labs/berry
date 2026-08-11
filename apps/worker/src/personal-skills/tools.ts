import { createHash } from "node:crypto";
import { parseAgentSkillMarkdown } from "@berry/shared";
import type { ChatContentPart } from "@berry/router-client";
import { z } from "zod";
import type { SqlExecutor } from "../sql-repositories.js";
import type {
  DurableToolPolicy,
  DurableTurnSnapshot,
  DurableTurnStep,
  DurableTurnToolExecutor,
  TurnToolResult,
} from "../turn-runner.js";

const SavePersonalSkillInputSchema = z.object({
  content: z.string().min(1).max(262_144),
}).strict();

export class DurablePersonalSkillToolExecutor implements DurableTurnToolExecutor {
  constructor(
    private readonly base: DurableTurnToolExecutor,
    private readonly executor: SqlExecutor,
  ) {}

  async modelContent(snapshot: DurableTurnSnapshot): Promise<readonly ChatContentPart[]> {
    return this.base.modelContent?.(snapshot) ?? [];
  }

  async stageAssociatedInputFiles(snapshot: DurableTurnSnapshot, fileIds: readonly string[]) {
    return this.base.stageAssociatedInputFiles?.(snapshot, fileIds) ?? [];
  }

  async finalize(snapshot: DurableTurnSnapshot): Promise<readonly TurnToolResult[]> {
    return this.base.finalize?.(snapshot) ?? [];
  }

  policy(
    snapshot: DurableTurnSnapshot,
    toolName: string,
    permissionMode: string,
  ): DurableToolPolicy | undefined {
    if (toolName === "save_personal_skill") {
      return {
        retryClass: "idempotent_with_key",
        requiresApproval: false,
        approvalKind: "file-edit",
      };
    }
    return this.base.policy?.(snapshot, toolName, permissionMode);
  }

  async execute(snapshot: DurableTurnSnapshot, step: DurableTurnStep): Promise<TurnToolResult> {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName !== "save_personal_skill") return this.base.execute(snapshot, step);

    const input = SavePersonalSkillInputSchema.parse(step.input.arguments ?? {});
    const metadata = parseAgentSkillMarkdown(input.content);
    const hash = createHash("sha256").update(input.content).digest("hex");
    const deterministicId = `skill_${createHash("sha256")
      .update(`${snapshot.tenantId}\0${snapshot.userId}\0${metadata.name}`)
      .digest("hex")
      .slice(0, 40)}`;
    const existing = await this.executor.query<{ id: string }>(
      "SELECT id FROM personal_skills WHERE tenant_id=$1::uuid AND user_id=$2 AND name=$3 ORDER BY updated_at DESC LIMIT 1",
      [snapshot.tenantId, snapshot.userId, metadata.name],
    );
    const id = existing[0]?.id ?? deterministicId;
    await this.executor.execute(
      `
INSERT INTO personal_skills (
  id,tenant_id,user_id,name,description,content,enabled,trusted,source,source_url,version,hash,diagnostics,created_at,updated_at
) VALUES ($1,$2::uuid,$3,$4,$5,$6,true,true,'text',NULL,$7,$8,'[]'::jsonb,now(),now())
ON CONFLICT (id) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  content=EXCLUDED.content,
  enabled=true,
  trusted=true,
  source='text',
  source_url=NULL,
  version=EXCLUDED.version,
  hash=EXCLUDED.hash,
  diagnostics='[]'::jsonb,
  updated_at=now()
WHERE personal_skills.tenant_id=EXCLUDED.tenant_id AND personal_skills.user_id=EXCLUDED.user_id
      `.trim(),
      [id, snapshot.tenantId, snapshot.userId, metadata.name, metadata.description, input.content, metadata.version, hash],
    );
    return {
      output: {
        skill: {
          id,
          name: metadata.name,
          description: metadata.description,
          enabled: true,
        },
      },
      summary: `Saved $${metadata.name} to the current user's Skills library`,
    };
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
