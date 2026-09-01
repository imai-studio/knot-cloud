import {
  decodeBase64Url,
  normalizeAuthority,
  protocolVersion,
  sha256Hex,
  signedRequestSchema,
  verifyEd25519Signature,
} from "@imai/knot-cloud-contract";

import type { ConnectorRateLimitStore, ReplayNonceStore } from "@/lib/ports";

const maximumClockSkewSeconds = 300;

export interface ConnectorRecord {
  id: string;
  tenantId: string;
  publicKey: Uint8Array;
  protocolVersion: string;
  scopes: string[];
  revoked: boolean;
}

export interface ConnectorRepository {
  findActiveConnector(id: string): Promise<ConnectorRecord | undefined>;
}

export class ConnectorAuthenticationError extends Error {
  constructor(
    readonly code:
      | "clock-skew"
      | "connector-not-found"
      | "invalid-request"
      | "invalid-signature"
      | "protocol-unsupported"
      | "rate-limited"
      | "replay-detected",
    readonly status: 400 | 401 | 409 | 426 | 429,
  ) {
    super(code);
    this.name = "ConnectorAuthenticationError";
  }
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) {
    throw new ConnectorAuthenticationError("invalid-request", 400);
  }
  return value;
}

export async function authenticateConnectorRequest(input: {
  request: Request;
  body: Uint8Array;
  connectors: ConnectorRepository;
  nonces: ReplayNonceStore;
  rateLimits?: ConnectorRateLimitStore;
  allowedAuthorities: readonly string[];
  nowUnixSeconds?: number;
}): Promise<{ connectorId: string; tenantId: string; scopes: string[] }> {
  const url = new URL(input.request.url);
  const requestedProtocol = requiredHeader(
    input.request.headers,
    "Knot-Protocol-Version",
  );
  if (requestedProtocol !== protocolVersion) {
    throw new ConnectorAuthenticationError("protocol-unsupported", 426);
  }

  const connectorId = requiredHeader(
    input.request.headers,
    "Knot-Connector-Id",
  );
  const timestampText = requiredHeader(input.request.headers, "Knot-Timestamp");
  const nonce = requiredHeader(input.request.headers, "Knot-Nonce");
  const signatureText = requiredHeader(input.request.headers, "Knot-Signature");
  if (!/^\d+$/u.test(timestampText)) {
    throw new ConnectorAuthenticationError("invalid-request", 400);
  }

  const timestamp = Number(timestampText);
  const now = input.nowUnixSeconds ?? Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp) > maximumClockSkewSeconds
  ) {
    throw new ConnectorAuthenticationError("clock-skew", 401);
  }

  let authority: string;
  try {
    authority = normalizeAuthority(url.host);
  } catch {
    throw new ConnectorAuthenticationError("invalid-request", 400);
  }
  if (!input.allowedAuthorities.includes(authority)) {
    throw new ConnectorAuthenticationError("invalid-request", 400);
  }

  const connector = await input.connectors.findActiveConnector(connectorId);
  if (!connector || connector.revoked) {
    throw new ConnectorAuthenticationError("connector-not-found", 401);
  }
  if (connector.protocolVersion !== requestedProtocol) {
    throw new ConnectorAuthenticationError("protocol-unsupported", 426);
  }
  let request;
  try {
    request = signedRequestSchema.parse({
      protocolVersion: requestedProtocol,
      connectorId,
      authority,
      method: input.request.method.toUpperCase(),
      path: url.pathname,
      query: url.search,
      timestamp,
      nonce,
      bodySha256: await sha256Hex(input.body),
    });
  } catch {
    throw new ConnectorAuthenticationError("invalid-request", 400);
  }

  let signature: Uint8Array;
  try {
    signature = decodeBase64Url(signatureText);
  } catch {
    throw new ConnectorAuthenticationError("invalid-signature", 401);
  }
  if (signature.length !== 64) {
    throw new ConnectorAuthenticationError("invalid-signature", 401);
  }

  let verified = false;
  try {
    verified = await verifyEd25519Signature({
      publicKey: connector.publicKey,
      request,
      signature,
    });
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new ConnectorAuthenticationError("invalid-signature", 401);
  }

  if (
    input.rateLimits &&
    !(await input.rateLimits.consume({
      connectorId: connector.id,
      limit: 300,
      windowSeconds: 60,
      nowUnixSeconds: now,
    }))
  ) {
    throw new ConnectorAuthenticationError("rate-limited", 429);
  }

  const nonceResult = await input.nonces.claim({
    tenantId: connector.tenantId,
    connectorId,
    nonce,
    expiresAt: now + maximumClockSkewSeconds * 2,
  });
  if (nonceResult === "replayed") {
    throw new ConnectorAuthenticationError("replay-detected", 409);
  }

  return {
    connectorId: connector.id,
    tenantId: connector.tenantId,
    scopes: connector.scopes,
  };
}
