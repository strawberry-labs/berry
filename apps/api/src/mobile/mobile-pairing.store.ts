import { randomUUID } from "node:crypto";
import type { MobilePairingDevice, MobilePairingStatusValue } from "@berry/shared";
import type { CloudDatabaseService } from "../db/cloud-database.service.ts";

export const MOBILE_PAIRING_STORE = Symbol("MOBILE_PAIRING_STORE");

export type MobilePairingRecord = {
  id: string;
  tenantId: string;
  userId: string;
  creatorSessionId: string;
  secretHash: string;
  manualCodeHash: string;
  claimTokenHash: string | null;
  status: MobilePairingStatusValue;
  device: MobilePairingDevice | null;
  claimedIp: string | null;
  expiresAt: Date;
  claimedAt: Date | null;
  decidedAt: Date | null;
  completedAt: Date | null;
  mobileSessionId: string | null;
  mobileDeviceId: string | null;
  createdAt: Date;
};

export type CreateMobilePairingInput = {
  tenantId: string;
  userId: string;
  creatorSessionId: string;
  secretHash: string;
  manualCodeHash: string;
  expiresAt: Date;
};

/**
 * Persistence for QR pairings. Every transition is a single conditional
 * update so two phones (or two polls) racing on one pairing cannot both win.
 */
export interface MobilePairingStore {
  create(input: CreateMobilePairingInput): Promise<MobilePairingRecord>;
  /** Only one QR code is live per browser session at a time. */
  cancelOpenForCreator(tenantId: string, creatorSessionId: string, now: Date): Promise<void>;
  get(tenantId: string, id: string): Promise<MobilePairingRecord | null>;
  findPendingByManualCodeHash(tenantId: string, manualCodeHash: string, now: Date): Promise<MobilePairingRecord | null>;
  /** pending → claimed, while unexpired. */
  claim(tenantId: string, id: string, input: { claimTokenHash: string; device: MobilePairingDevice; claimedIp: string | null; expiresAt: Date; now: Date }): Promise<MobilePairingRecord | null>;
  /** claimed → approved, or pending/claimed → denied, by the creating session only. */
  decide(tenantId: string, id: string, creatorSessionId: string, decision: "approved" | "denied", now: Date): Promise<MobilePairingRecord | null>;
  /** pending/claimed/approved → cancelled, by the creating session only. */
  cancel(tenantId: string, id: string, creatorSessionId: string, now: Date): Promise<MobilePairingRecord | null>;
  /** approved → completed exactly once, for the phone holding the claim token. */
  complete(tenantId: string, id: string, claimTokenHash: string, now: Date): Promise<MobilePairingRecord | null>;
  attachResult(tenantId: string, id: string, result: { mobileSessionId: string; mobileDeviceId: string }): Promise<void>;
  /** Marks a completed pairing cancelled when issuing the session failed. */
  fail(tenantId: string, id: string, now: Date): Promise<void>;
  deleteStale(tenantId: string, before: Date): Promise<void>;
}

const OPEN_STATUSES: readonly MobilePairingStatusValue[] = ["pending", "claimed", "approved"];

export class InMemoryMobilePairingStore implements MobilePairingStore {
  readonly #records = new Map<string, MobilePairingRecord>();

  async create(input: CreateMobilePairingInput): Promise<MobilePairingRecord> {
    const record: MobilePairingRecord = {
      id: randomUUID(),
      ...input,
      claimTokenHash: null,
      status: "pending",
      device: null,
      claimedIp: null,
      claimedAt: null,
      decidedAt: null,
      completedAt: null,
      mobileSessionId: null,
      mobileDeviceId: null,
      createdAt: new Date(),
    };
    this.#records.set(record.id, record);
    return { ...record };
  }

  async cancelOpenForCreator(tenantId: string, creatorSessionId: string, now: Date): Promise<void> {
    for (const record of this.#records.values()) {
      if (record.tenantId === tenantId && record.creatorSessionId === creatorSessionId && OPEN_STATUSES.includes(record.status)) {
        record.status = "cancelled";
        record.decidedAt = now;
      }
    }
  }

  async get(tenantId: string, id: string): Promise<MobilePairingRecord | null> {
    const record = this.#records.get(id);
    return record && record.tenantId === tenantId ? { ...record } : null;
  }

  async findPendingByManualCodeHash(tenantId: string, manualCodeHash: string, now: Date): Promise<MobilePairingRecord | null> {
    for (const record of this.#records.values()) {
      if (record.tenantId === tenantId && record.status === "pending" && record.manualCodeHash === manualCodeHash && record.expiresAt > now) return { ...record };
    }
    return null;
  }

  async claim(tenantId: string, id: string, input: { claimTokenHash: string; device: MobilePairingDevice; claimedIp: string | null; expiresAt: Date; now: Date }): Promise<MobilePairingRecord | null> {
    return this.#transition(tenantId, id, (record) => record.status === "pending" && record.expiresAt > input.now, (record) => {
      record.status = "claimed";
      record.claimTokenHash = input.claimTokenHash;
      record.device = input.device;
      record.claimedIp = input.claimedIp;
      record.claimedAt = input.now;
      record.expiresAt = input.expiresAt;
    });
  }

  async decide(tenantId: string, id: string, creatorSessionId: string, decision: "approved" | "denied", now: Date): Promise<MobilePairingRecord | null> {
    const allowed: readonly MobilePairingStatusValue[] = decision === "approved" ? ["claimed"] : ["pending", "claimed"];
    return this.#transition(tenantId, id, (record) => record.creatorSessionId === creatorSessionId && allowed.includes(record.status) && record.expiresAt > now, (record) => {
      record.status = decision;
      record.decidedAt = now;
    });
  }

  async cancel(tenantId: string, id: string, creatorSessionId: string, now: Date): Promise<MobilePairingRecord | null> {
    return this.#transition(tenantId, id, (record) => record.creatorSessionId === creatorSessionId && OPEN_STATUSES.includes(record.status), (record) => {
      record.status = "cancelled";
      record.decidedAt = now;
    });
  }

  async complete(tenantId: string, id: string, claimTokenHash: string, now: Date): Promise<MobilePairingRecord | null> {
    return this.#transition(tenantId, id, (record) => record.status === "approved" && record.claimTokenHash === claimTokenHash && record.expiresAt > now, (record) => {
      record.status = "completed";
      record.completedAt = now;
    });
  }

  async attachResult(tenantId: string, id: string, result: { mobileSessionId: string; mobileDeviceId: string }): Promise<void> {
    const record = this.#records.get(id);
    if (record && record.tenantId === tenantId) Object.assign(record, result);
  }

  async fail(tenantId: string, id: string, now: Date): Promise<void> {
    const record = this.#records.get(id);
    if (record && record.tenantId === tenantId && record.status === "completed") {
      record.status = "cancelled";
      record.decidedAt = now;
    }
  }

  async deleteStale(tenantId: string, before: Date): Promise<void> {
    for (const [id, record] of this.#records) {
      if (record.tenantId === tenantId && record.expiresAt < before) this.#records.delete(id);
    }
  }

  #transition(tenantId: string, id: string, guard: (record: MobilePairingRecord) => boolean, apply: (record: MobilePairingRecord) => void): MobilePairingRecord | null {
    const record = this.#records.get(id);
    if (!record || record.tenantId !== tenantId || !guard(record)) return null;
    apply(record);
    return { ...record };
  }
}

type PairingRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  creator_session_id: string;
  secret_hash: string;
  manual_code_hash: string;
  claim_token_hash: string | null;
  status: MobilePairingStatusValue;
  device_model: string | null;
  device_platform: "ios" | "android" | null;
  device_os_version: string | null;
  device_app_version: string | null;
  claimed_ip: string | null;
  expires_at: Date | string;
  claimed_at: Date | string | null;
  decided_at: Date | string | null;
  completed_at: Date | string | null;
  mobile_session_id: string | null;
  mobile_device_id: string | null;
  created_at: Date | string;
};

export class PostgresMobilePairingStore implements MobilePairingStore {
  constructor(private readonly database: CloudDatabaseService) {}

  async create(input: CreateMobilePairingInput): Promise<MobilePairingRecord> {
    return this.database.withTenant(input.tenantId, async (db) => {
      const rows = await db.query<PairingRow>(
        `INSERT INTO mobile_pairings (tenant_id, user_id, creator_session_id, secret_hash, manual_code_hash, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)
         RETURNING *`,
        [input.tenantId, input.userId, input.creatorSessionId, input.secretHash, input.manualCodeHash, input.expiresAt],
      );
      return pairingFromRow(rows[0]!);
    });
  }

  async cancelOpenForCreator(tenantId: string, creatorSessionId: string, now: Date): Promise<void> {
    await this.database.withTenant(tenantId, (db) => db.execute(
      `UPDATE mobile_pairings SET status='cancelled', decided_at=$3, updated_at=now()
       WHERE tenant_id=$1::uuid AND creator_session_id=$2::uuid AND status IN ('pending','claimed','approved')`,
      [tenantId, creatorSessionId, now],
    ));
  }

  async get(tenantId: string, id: string): Promise<MobilePairingRecord | null> {
    return this.#one(tenantId, "SELECT * FROM mobile_pairings WHERE tenant_id=$1::uuid AND id=$2::uuid LIMIT 1", [tenantId, id]);
  }

  async findPendingByManualCodeHash(tenantId: string, manualCodeHash: string, now: Date): Promise<MobilePairingRecord | null> {
    return this.#one(
      tenantId,
      "SELECT * FROM mobile_pairings WHERE tenant_id=$1::uuid AND status='pending' AND manual_code_hash=$2 AND expires_at > $3 LIMIT 1",
      [tenantId, manualCodeHash, now],
    );
  }

  async claim(tenantId: string, id: string, input: { claimTokenHash: string; device: MobilePairingDevice; claimedIp: string | null; expiresAt: Date; now: Date }): Promise<MobilePairingRecord | null> {
    return this.#one(
      tenantId,
      `UPDATE mobile_pairings SET status='claimed', claim_token_hash=$3, device_model=$4, device_platform=$5, device_os_version=$6,
         device_app_version=$7, claimed_ip=$8, claimed_at=$9, expires_at=$10, updated_at=now()
       WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending' AND expires_at > $9
       RETURNING *`,
      [tenantId, id, input.claimTokenHash, input.device.model, input.device.platform, input.device.osVersion, input.device.appVersion, input.claimedIp, input.now, input.expiresAt],
    );
  }

  async decide(tenantId: string, id: string, creatorSessionId: string, decision: "approved" | "denied", now: Date): Promise<MobilePairingRecord | null> {
    const from = decision === "approved" ? ["claimed"] : ["pending", "claimed"];
    return this.#one(
      tenantId,
      `UPDATE mobile_pairings SET status=$4, decided_at=$5, updated_at=now()
       WHERE tenant_id=$1::uuid AND id=$2::uuid AND creator_session_id=$3::uuid AND status = ANY($6::text[]) AND expires_at > $5
       RETURNING *`,
      [tenantId, id, creatorSessionId, decision, now, from],
    );
  }

  async cancel(tenantId: string, id: string, creatorSessionId: string, now: Date): Promise<MobilePairingRecord | null> {
    return this.#one(
      tenantId,
      `UPDATE mobile_pairings SET status='cancelled', decided_at=$4, updated_at=now()
       WHERE tenant_id=$1::uuid AND id=$2::uuid AND creator_session_id=$3::uuid AND status IN ('pending','claimed','approved')
       RETURNING *`,
      [tenantId, id, creatorSessionId, now],
    );
  }

  async complete(tenantId: string, id: string, claimTokenHash: string, now: Date): Promise<MobilePairingRecord | null> {
    return this.#one(
      tenantId,
      `UPDATE mobile_pairings SET status='completed', completed_at=$4, updated_at=now()
       WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='approved' AND claim_token_hash=$3 AND expires_at > $4
       RETURNING *`,
      [tenantId, id, claimTokenHash, now],
    );
  }

  async attachResult(tenantId: string, id: string, result: { mobileSessionId: string; mobileDeviceId: string }): Promise<void> {
    await this.database.withTenant(tenantId, (db) => db.execute(
      "UPDATE mobile_pairings SET mobile_session_id=$3::uuid, mobile_device_id=$4::uuid, updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [tenantId, id, result.mobileSessionId, result.mobileDeviceId],
    ));
  }

  async fail(tenantId: string, id: string, now: Date): Promise<void> {
    await this.database.withTenant(tenantId, (db) => db.execute(
      "UPDATE mobile_pairings SET status='cancelled', decided_at=$3, updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='completed'",
      [tenantId, id, now],
    ));
  }

  async deleteStale(tenantId: string, before: Date): Promise<void> {
    await this.database.withTenant(tenantId, (db) => db.execute(
      "DELETE FROM mobile_pairings WHERE tenant_id=$1::uuid AND expires_at < $2",
      [tenantId, before],
    ));
  }

  async #one(tenantId: string, sql: string, params: readonly unknown[]): Promise<MobilePairingRecord | null> {
    return this.database.withTenant(tenantId, async (db) => {
      const row = (await db.query<PairingRow>(sql, params))[0];
      return row ? pairingFromRow(row) : null;
    });
  }
}

function pairingFromRow(row: PairingRow): MobilePairingRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    creatorSessionId: row.creator_session_id,
    secretHash: row.secret_hash,
    manualCodeHash: row.manual_code_hash,
    claimTokenHash: row.claim_token_hash,
    status: row.status,
    device: row.device_model && row.device_platform && row.device_os_version && row.device_app_version
      ? { model: row.device_model, platform: row.device_platform, osVersion: row.device_os_version, appVersion: row.device_app_version }
      : null,
    claimedIp: row.claimed_ip,
    expiresAt: new Date(row.expires_at),
    claimedAt: optionalDate(row.claimed_at),
    decidedAt: optionalDate(row.decided_at),
    completedAt: optionalDate(row.completed_at),
    mobileSessionId: row.mobile_session_id,
    mobileDeviceId: row.mobile_device_id,
    createdAt: new Date(row.created_at),
  };
}

function optionalDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}
