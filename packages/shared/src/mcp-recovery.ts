import { z } from "zod";

const Revision = z.string().regex(/^[a-f0-9]{64}$/);

// Encrypted with the existing API/worker capability key, then checked against
// the live run lease and its admitted connector before resolving any grant.
export const McpCredentialRequestSchema = z.object({
  purpose: z.literal("resolve-run-mcp-credential"),
  expiresAt: z.number().int(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  runId: z.string().uuid(),
  leaseOwner: z.string().min(1).max(512),
  ownershipGeneration: z.number().int().nonnegative(),
  connectorId: z.string().min(1).max(256),
  rejectedVersion: Revision.optional(),
}).strict();
export type McpCredentialRequest = z.infer<typeof McpCredentialRequestSchema>;

export const McpCredentialResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), accessToken: z.string().min(1), version: Revision }).strict(),
  z.object({ status: z.literal("static") }).strict(),
  z.object({ status: z.literal("reauth_required"), grantId: Revision }).strict(),
  z.object({ status: z.literal("configuration") }).strict(),
  z.object({ status: z.literal("temporary"), uncertain: z.boolean() }).strict(),
]);
export type McpCredentialResult = z.infer<typeof McpCredentialResultSchema>;

export const GoogleMcpReconnectSchema = z.object({
  code: z.literal("berry_google_reauth_required"),
  connectorId: z.enum(["connector_google_workspace", "connector_gmail", "connector_google_calendar"]),
  grantId: Revision,
}).strict();

export const TaskConnectorReconnectSchema = z.object({
  connectorId: z.string(),
  name: z.string(),
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  canReconnect: z.boolean(),
  connectorKey: z.string().optional(),
  accessLevel: z.enum(["read", "full"]).optional(),
}).strict();
export type TaskConnectorReconnect = z.infer<typeof TaskConnectorReconnectSchema>;

export function isStoredMcpCredentialRef(connectorId: string, reference: string | null | undefined): boolean {
  return reference?.startsWith(`connector-oauth:${connectorId}:`) === true
    || (connectorId.startsWith("connector_mcp_") && reference?.startsWith(`connector:${connectorId}:`) === true);
}
