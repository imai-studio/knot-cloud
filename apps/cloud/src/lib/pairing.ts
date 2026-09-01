import { createHash, randomBytes } from "node:crypto";

import {
  pairingSessionCreatedSchema,
  pairingSessionStatusSchema,
  protocolVersion,
  type PairingGrant,
  type PairingSessionCreate,
  type PairingSessionStatus,
} from "@imai/knot-cloud-contract";

import { getCloudEnvironment } from "@/lib/env";

import type { AuthorizedWorkspace } from "@/lib/workspace-auth";

export interface PairingReview {
  id: string;
  connectorName: string;
  publicKey: string;
  protocolVersion: string;
  requestedScopes: string[];
  requestedSlugGrants: string[];
  status: "pending" | "approved" | "denied" | "expired";
  expiresAt: Date;
  createdAt: Date;
}

export interface ManagedConnector {
  id: string;
  name: string;
  publicKey: string;
  protocolVersion: string;
  scopes: string[];
  siteIds: string[];
  slugGrants: string[];
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export type PairingDecisionOutcome =
  | "approved"
  | "denied"
  | "expired"
  | "conflict"
  | "forbidden"
  | "not-found"
  | "revoked-key"
  | "scope-escalation"
  | "unknown-site";

export interface PairingRepository {
  create(input: {
    tenantId: string;
    actorUserId: string;
    request: PairingSessionCreate;
    pollTokenDigest: string;
    expiresAt: Date;
  }): Promise<string>;
  listReviews(tenantId: string): Promise<PairingReview[]>;
  approve(input: {
    tenantId: string;
    actorUserId: string;
    pairingId: string;
    grant: PairingGrant;
    now: Date;
  }): Promise<{ outcome: PairingDecisionOutcome; connectorId?: string }>;
  deny(input: {
    tenantId: string;
    actorUserId: string;
    pairingId: string;
    now: Date;
  }): Promise<PairingDecisionOutcome>;
  poll(input: {
    pairingId: string;
    pollTokenDigest: string;
    now: Date;
  }): Promise<PairingSessionStatus | undefined>;
  listConnectors(tenantId: string): Promise<ManagedConnector[]>;
  rename(input: {
    tenantId: string;
    actorUserId: string;
    connectorId: string;
    name: string;
  }): Promise<boolean>;
  revoke(input: {
    tenantId: string;
    actorUserId: string;
    connectorId: string;
    now: Date;
  }): Promise<boolean>;
}

const pairingLifetimeSeconds = 10 * 60;
const pollAfterSeconds = 3;

export function canManageConnectors(authorized: AuthorizedWorkspace): boolean {
  return ["owner", "admin"].includes(authorized.workspace.role);
}

export async function createPairingSession(
  authorized: AuthorizedWorkspace,
  request: PairingSessionCreate,
  repository: PairingRepository,
  options?: { now?: Date; pollToken?: string; baseUrl?: string },
) {
  if (!canManageConnectors(authorized)) return null;
  const now = options?.now ?? new Date();
  const pollToken = options?.pollToken ?? randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + pairingLifetimeSeconds * 1_000);
  const pairingId = await repository.create({
    tenantId: authorized.workspace.tenantId,
    actorUserId: authorized.workspace.userId,
    request,
    pollTokenDigest: digestPollToken(pollToken),
    expiresAt,
  });
  const authorizationUrl = new URL(
    "/dashboard",
    options?.baseUrl ?? getCloudEnvironment().APP_BASE_URL,
  );
  authorizationUrl.searchParams.set("view", "connectors");
  authorizationUrl.searchParams.set("pairing", pairingId);
  return pairingSessionCreatedSchema.parse({
    protocolVersion,
    pairingId,
    pollToken,
    authorizationUrl: authorizationUrl.toString(),
    expiresAt: Math.floor(expiresAt.getTime() / 1_000),
    pollAfterSeconds,
  });
}

export async function pollPairingSession(
  input: { pairingId: string; pollToken: string },
  repository: PairingRepository,
  now = new Date(),
): Promise<PairingSessionStatus | undefined> {
  const result = await repository.poll({
    pairingId: input.pairingId,
    pollTokenDigest: digestPollToken(input.pollToken),
    now,
  });
  return result ? pairingSessionStatusSchema.parse(result) : undefined;
}

export function digestPollToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
