import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import {
  ManagedPolicyBundleSchema,
  ManagedPolicyPublishRequestSchema,
  ManagedPolicyVersionSchema,
  type JsonValue,
  type ManagedPolicyBundle,
  type ManagedPolicyPublishRequest,
  type ManagedPolicyUnsignedBundle,
  type ManagedPolicyVersion,
} from "@berry/shared";
import type { CloudDatabaseService, SqlExecutor } from "../db/cloud-database.service.ts";

export const POLICY_DISTRIBUTION_SERVICE = Symbol("POLICY_DISTRIBUTION_SERVICE");

export interface PolicySigner {
  readonly keyId: string;
  sign(bundle: ManagedPolicyUnsignedBundle): { algorithm: "ed25519"; keyId: string; value: string };
}

export interface PolicyDistributionRepository {
  listVersions(tenantId: string): Promise<ManagedPolicyVersion[]>;
  activeVersion(tenantId: string): Promise<ManagedPolicyVersion | null>;
  publish(input: PublishPolicyVersionInput): Promise<ManagedPolicyVersion>;
}

export type PublishPolicyVersionInput = {
  tenantId: string;
  actorUserId: string | null;
  bundle: ManagedPolicyBundle;
  status: "draft" | "active" | "revoked";
  note: string | null;
};

export class PolicyDistributionService {
  constructor(
    private readonly repository: PolicyDistributionRepository,
    private readonly signer: PolicySigner | null,
    private readonly capabilities?: { managedPolicy(tenantId: string): Promise<{ personalAdditions: { skills: boolean; mcp: boolean }; capabilityCatalog: NonNullable<ManagedPolicyBundle["policy"]["capabilityCatalog"]> }> },
  ) {}

  async listVersions(tenantId: string): Promise<ManagedPolicyVersion[]> {
    return (await this.repository.listVersions(tenantId)).sort((left, right) => right.version - left.version);
  }

  async activeVersion(tenantId: string): Promise<ManagedPolicyVersion | null> {
    return this.repository.activeVersion(tenantId);
  }

  async publish(input: {
    tenantId: string;
    actorUserId: string | null;
    body: ManagedPolicyPublishRequest;
  }): Promise<ManagedPolicyVersion> {
    if (!this.signer) throw new Error("Policy signing is not configured");
    const parsed = ManagedPolicyPublishRequestSchema.parse(input.body);
    const managedCapabilities = await this.capabilities?.managedPolicy(input.tenantId);
    const versions = await this.repository.listVersions(input.tenantId);
    const nextVersion = Math.max(0, ...versions.map((version) => version.version)) + 1;
    const unsigned = {
      version: nextVersion,
      organization: parsed.organization ?? { id: input.tenantId, name: input.tenantId },
      issuedAt: new Date().toISOString(),
      expiresAt: parsed.expiresAt ?? null,
      policy: { ...parsed.policy, ...(managedCapabilities ?? {}) },
    } satisfies ManagedPolicyUnsignedBundle;
    const bundle = ManagedPolicyBundleSchema.parse({
      ...unsigned,
      signature: this.signer.sign(unsigned),
    });
    return this.repository.publish({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      bundle,
      status: parsed.status ?? "active",
      note: parsed.note ?? null,
    });
  }
}

export class Ed25519PolicySigner implements PolicySigner {
  readonly #privateKey;

  constructor(privateKeyPem: string | Buffer, readonly keyId: string) {
    this.#privateKey = createPrivateKey(privateKeyPem);
    if (this.#privateKey.asymmetricKeyType !== "ed25519") throw new Error("Policy signing key must be Ed25519");
    if (!keyId.trim()) throw new Error("Policy signing key id is required");
  }

  sign(bundle: ManagedPolicyUnsignedBundle): { algorithm: "ed25519"; keyId: string; value: string } {
    return {
      algorithm: "ed25519",
      keyId: this.keyId,
      value: sign(null, Buffer.from(canonicalJson(bundle)), this.#privateKey).toString("base64"),
    };
  }

  publicKeyRawBase64(): string {
    const der = createPublicKey(this.#privateKey).export({ format: "der", type: "spki" });
    return der.subarray(-32).toString("base64");
  }
}

export class InMemoryPolicyDistributionRepository implements PolicyDistributionRepository {
  readonly #versions = new Map<string, ManagedPolicyVersion>();

  async listVersions(tenantId: string): Promise<ManagedPolicyVersion[]> {
    return [...this.#versions.values()].filter((version) => version.tenantId === tenantId);
  }

  async activeVersion(tenantId: string): Promise<ManagedPolicyVersion | null> {
    return [...this.#versions.values()].find((version) => version.tenantId === tenantId && version.status === "active") ?? null;
  }

  async publish(input: PublishPolicyVersionInput): Promise<ManagedPolicyVersion> {
    const now = new Date().toISOString();
    if (input.status === "active") {
      for (const [key, version] of this.#versions) {
        if (version.tenantId !== input.tenantId || version.status !== "active") continue;
        this.#versions.set(key, { ...version, status: "revoked", revokedAt: now });
      }
    }
    const id = randomUUID();
    const version = ManagedPolicyVersionSchema.parse({
      id,
      tenantId: input.tenantId,
      version: input.bundle.version,
      status: input.status,
      bundle: input.bundle,
      bundlePath: `/v1/orgs/${input.tenantId}/policy/berry-policy.json`,
      bundleHash: policyHash(input.bundle),
      keyId: input.bundle.signature.keyId,
      publishedBy: input.actorUserId,
      publishedAt: now,
      revokedAt: input.status === "revoked" ? now : null,
      auditEventId: `audit_${id}`,
      note: input.note,
    });
    this.#versions.set(`${input.tenantId}:${input.bundle.version}`, version);
    return version;
  }
}

export class PostgresPolicyDistributionRepository implements PolicyDistributionRepository {
  constructor(private readonly database: CloudDatabaseService) {}

  async listVersions(tenantId: string): Promise<ManagedPolicyVersion[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<PolicyVersionRow>("SELECT * FROM policy_versions WHERE tenant_id = $1::uuid ORDER BY version DESC", [tenantId]);
      return rows.map(policyVersionFromRow);
    });
  }

  async activeVersion(tenantId: string): Promise<ManagedPolicyVersion | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<PolicyVersionRow>("SELECT * FROM policy_versions WHERE tenant_id = $1::uuid AND status = 'active' ORDER BY version DESC LIMIT 1", [tenantId]);
      return rows[0] ? policyVersionFromRow(rows[0]) : null;
    });
  }

  async publish(input: PublishPolicyVersionInput): Promise<ManagedPolicyVersion> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      const now = new Date().toISOString();
      if (input.status === "active") {
        await executor.execute("UPDATE policy_versions SET status = 'revoked', revoked_at = $2 WHERE tenant_id = $1::uuid AND status = 'active'", [input.tenantId, now]);
      }
      const auditEventId = await insertPolicyAuditEvent(executor, input.tenantId, input.actorUserId, input.bundle, input.status);
      const rows = await executor.query<PolicyVersionRow>(
        `
INSERT INTO policy_versions (
  tenant_id, version, status, bundle, bundle_hash, key_id, published_by, published_at, revoked_at, audit_event_id, note
) VALUES (
  $1::uuid, $2, $3, $4::jsonb, $5, $6, $7::uuid, $8, $9, $10::uuid, $11
)
RETURNING *
        `.trim(),
        [
          input.tenantId,
          input.bundle.version,
          input.status,
          JSON.stringify(input.bundle),
          policyHash(input.bundle),
          input.bundle.signature.keyId,
          uuidOrNull(input.actorUserId),
          now,
          input.status === "revoked" ? now : null,
          auditEventId,
          input.note,
        ],
      );
      return policyVersionFromRow(rows[0]!);
    });
  }
}

export function createPolicySignerFromEnv(env: NodeJS.ProcessEnv): PolicySigner | null {
  const privateKey = env.BERRY_POLICY_SIGNING_PRIVATE_KEY_PEM?.trim();
  const keyId = env.BERRY_POLICY_SIGNING_KEY_ID?.trim();
  if (!privateKey || !keyId) return null;
  return new Ed25519PolicySigner(privateKey.replace(/\\n/g, "\n"), keyId);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function policyHash(bundle: ManagedPolicyBundle): string {
  return createHash("sha256").update(canonicalJson(bundle)).digest("hex");
}

async function insertPolicyAuditEvent(executor: SqlExecutor, tenantId: string, actorUserId: string | null, bundle: ManagedPolicyBundle, status: string): Promise<string> {
  const previousRows = await executor.query<{ sequence: number; event_hash: string }>(
    "SELECT sequence, event_hash FROM audit_events WHERE tenant_id = $1::uuid ORDER BY sequence DESC LIMIT 1",
    [tenantId],
  );
  const previous = previousRows[0];
  const sequence = (previous?.sequence ?? 0) + 1;
  const previousHash = previous?.event_hash ?? "0".repeat(64);
  const id = randomUUID();
  const metadata = {
    policyVersion: bundle.version,
    keyId: bundle.signature.keyId,
    bundleHash: policyHash(bundle),
    status,
  };
  const eventHash = createHash("sha256")
    .update(canonicalJson({ id, tenantId, sequence, actorUserId, category: "policy", action: "published", targetId: String(bundle.version), metadata, previousHash }))
    .digest("hex");
  await executor.execute(
    `INSERT INTO audit_events (
      id, tenant_id, sequence, actor_user_id, category, action, target_type, target_id, metadata, previous_hash, event_hash
    ) VALUES (
      $1::uuid, $2::uuid, $3, $4::uuid, 'policy', 'published', 'policy_version', $5, $6::jsonb, $7, $8
    )`,
    [id, tenantId, sequence, uuidOrNull(actorUserId), String(bundle.version), JSON.stringify(metadata), previousHash, eventHash],
  );
  return id;
}

function policyVersionFromRow(row: PolicyVersionRow): ManagedPolicyVersion {
  const bundle = ManagedPolicyBundleSchema.parse(row.bundle);
  return ManagedPolicyVersionSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    version: row.version,
    status: row.status,
    bundle,
    bundlePath: `/v1/orgs/${row.tenant_id}/policy/berry-policy.json`,
    bundleHash: row.bundle_hash,
    keyId: row.key_id,
    publishedBy: row.published_by,
    publishedAt: iso(row.published_at),
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    auditEventId: row.audit_event_id,
    note: row.note,
  });
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

type PolicyVersionRow = {
  id: string;
  tenant_id: string;
  version: number;
  status: "draft" | "active" | "revoked";
  bundle: JsonValue;
  bundle_hash: string;
  key_id: string;
  published_by: string | null;
  published_at: Date | string;
  revoked_at: Date | string | null;
  audit_event_id: string | null;
  note: string | null;
};
