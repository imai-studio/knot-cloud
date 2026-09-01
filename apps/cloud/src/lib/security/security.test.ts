import { generateKeyPairSync, sign } from "node:crypto";

import {
  canonicalSignedRequest,
  encodeBase64Url,
  protocolVersion,
  sha256Hex,
  type SignedRequest,
} from "@imai/knot-cloud-contract";
import { describe, expect, it } from "vitest";

import type { ConnectorRateLimitStore, ReplayNonceStore } from "@/lib/ports";

import { createApiKey, extractApiKeyId, verifyApiKey } from "./api-key";
import {
  authenticateConnectorRequest,
  ConnectorAuthenticationError,
  type ConnectorRecord,
} from "./connector-auth";

const now = 1_788_192_000;
const path = "/api/v1/connectors/connector-1/commands/claim?limit=1";
const authority = "cloud.knot.test";
const body = new TextEncoder().encode('{"waitSeconds":20}');

async function signedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const request: SignedRequest = {
    protocolVersion,
    connectorId: "connector-1",
    authority,
    method: "POST",
    path: path.split("?")[0]!,
    query: `?${path.split("?")[1]!}`,
    timestamp: now,
    nonce: "nonce_1234567890abcdef",
    bodySha256: await sha256Hex(body),
  };
  const signature = sign(
    null,
    Buffer.from(canonicalSignedRequest(request)),
    privateKey,
  );
  const headers = new Headers({
    "Knot-Protocol-Version": protocolVersion,
    "Knot-Connector-Id": request.connectorId,
    "Knot-Timestamp": String(request.timestamp),
    "Knot-Nonce": request.nonce,
    "Knot-Signature": encodeBase64Url(signature),
  });
  const connector: ConnectorRecord = {
    id: "connector-1",
    tenantId: "tenant-1",
    publicKey: publicKeyBytes,
    protocolVersion,
    scopes: ["anytype.objects.read"],
    revoked: false,
  };
  return { connector, headers };
}

describe("connector authentication", () => {
  it("authenticates before atomically claiming a nonce", async () => {
    const { connector, headers } = await signedFixture();
    const claimed = new Set<string>();
    const expirations: number[] = [];
    const nonces: ReplayNonceStore = {
      claim: ({ nonce, expiresAt }) => (
        expirations.push(expiresAt),
        Promise.resolve(
          claimed.has(nonce) ? "replayed" : (claimed.add(nonce), "claimed"),
        )
      ),
    };
    const connectors = {
      findActiveConnector: () => Promise.resolve(connector),
    };

    await expect(
      authenticateConnectorRequest({
        request: new Request(`https://${authority}${path}`, {
          method: "POST",
          headers,
        }),
        body,
        connectors,
        nonces,
        allowedAuthorities: [authority],
        nowUnixSeconds: now,
      }),
    ).resolves.toEqual({
      connectorId: "connector-1",
      tenantId: "tenant-1",
      scopes: ["anytype.objects.read"],
    });
    await expect(
      authenticateConnectorRequest({
        request: new Request(`https://${authority}${path}`, {
          method: "POST",
          headers,
        }),
        body,
        connectors,
        nonces,
        allowedAuthorities: [authority],
        nowUnixSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "replay-detected", status: 409 });
    expect(expirations).toEqual([now + 600, now + 600]);
  });

  it("retains a nonce across the full accepted timestamp-skew window", async () => {
    const { connector, headers } = await signedFixture();
    let simulatedNow = now - 300;
    let retainedUntil: number | undefined;
    const nonces: ReplayNonceStore = {
      claim: ({ expiresAt }) => {
        if (retainedUntil === undefined || retainedUntil <= simulatedNow) {
          retainedUntil = expiresAt;
          return Promise.resolve("claimed");
        }
        return Promise.resolve("replayed");
      },
    };
    const connectors = {
      findActiveConnector: () => Promise.resolve(connector),
    };
    const authenticate = () =>
      authenticateConnectorRequest({
        request: new Request(`https://${authority}${path}`, {
          method: "POST",
          headers,
        }),
        body,
        connectors,
        nonces,
        allowedAuthorities: [authority],
        nowUnixSeconds: simulatedNow,
      });

    await expect(authenticate()).resolves.toBeDefined();
    expect(retainedUntil).toBe(now + 600);
    simulatedNow = now + 300;
    await expect(authenticate()).rejects.toMatchObject({
      code: "replay-detected",
      status: 409,
    });
  });

  it("rejects body tampering before consuming the nonce", async () => {
    const { connector, headers } = await signedFixture();
    let nonceClaims = 0;
    let rateLimitChecks = 0;

    await expect(
      authenticateConnectorRequest({
        request: new Request(`https://${authority}${path}`, {
          method: "POST",
          headers,
        }),
        body: new TextEncoder().encode('{"waitSeconds":99}'),
        connectors: { findActiveConnector: () => Promise.resolve(connector) },
        nonces: {
          claim: () => ((nonceClaims += 1), Promise.resolve("claimed")),
        },
        rateLimits: {
          consume: () => ((rateLimitChecks += 1), Promise.resolve(true)),
        },
        allowedAuthorities: [authority],
        nowUnixSeconds: now,
      }),
    ).rejects.toBeInstanceOf(ConnectorAuthenticationError);
    expect(nonceClaims).toBe(0);
    expect(rateLimitChecks).toBe(0);
  });

  it("rejects clock skew before connector lookup", async () => {
    const { headers } = await signedFixture();
    let lookups = 0;
    await expect(
      authenticateConnectorRequest({
        request: new Request(`https://${authority}${path}`, {
          method: "POST",
          headers,
        }),
        body,
        connectors: {
          findActiveConnector: () => (
            (lookups += 1),
            Promise.resolve(undefined)
          ),
        },
        nonces: { claim: () => Promise.resolve("claimed") },
        allowedAuthorities: [authority],
        nowUnixSeconds: now + 301,
      }),
    ).rejects.toMatchObject({ code: "clock-skew" });
    expect(lookups).toBe(0);
  });

  it("fails closed when the nonce store is unavailable", async () => {
    const { connector, headers } = await signedFixture();
    await expect(
      authenticateConnectorRequest({
        request: new Request(`https://${authority}${path}`, {
          method: "POST",
          headers,
        }),
        body,
        connectors: { findActiveConnector: () => Promise.resolve(connector) },
        nonces: {
          claim: () => Promise.reject(new Error("nonce store unavailable")),
        },
        allowedAuthorities: [authority],
        nowUnixSeconds: now,
      }),
    ).rejects.toThrow("nonce store unavailable");
  });

  it("rate limits a connector after signature verification and before nonce use", async () => {
    const { connector, headers } = await signedFixture();
    let nonceClaims = 0;
    const rateLimits: ConnectorRateLimitStore = {
      consume: () => Promise.resolve(false),
    };

    await expect(
      authenticateConnectorRequest({
        request: new Request(`https://${authority}${path}`, {
          method: "POST",
          headers,
        }),
        body,
        connectors: { findActiveConnector: () => Promise.resolve(connector) },
        nonces: {
          claim: () => ((nonceClaims += 1), Promise.resolve("claimed")),
        },
        rateLimits,
        allowedAuthorities: [authority],
        nowUnixSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "rate-limited", status: 429 });
    expect(nonceClaims).toBe(0);
  });

  it("rejects a request for another deployment authority", async () => {
    const { connector, headers } = await signedFixture();
    let nonceClaims = 0;
    await expect(
      authenticateConnectorRequest({
        request: new Request(
          `https://production.knot.test${path.replace("limit=1", "limit=2")}`,
          { method: "POST", headers },
        ),
        body,
        connectors: { findActiveConnector: () => Promise.resolve(connector) },
        nonces: {
          claim: () => ((nonceClaims += 1), Promise.resolve("claimed")),
        },
        allowedAuthorities: [authority],
        nowUnixSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(nonceClaims).toBe(0);
  });

  it("binds signatures to the exact query", async () => {
    const { connector, headers } = await signedFixture();
    await expect(
      authenticateConnectorRequest({
        request: new Request(
          `https://${authority}${path.replace("limit=1", "limit=2")}`,
          { method: "POST", headers },
        ),
        body,
        connectors: { findActiveConnector: () => Promise.resolve(connector) },
        nonces: { claim: () => Promise.resolve("claimed") },
        allowedAuthorities: [authority],
        nowUnixSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "invalid-signature" });
  });

  it("maps malformed stored public keys to an authentication failure", async () => {
    const { connector, headers } = await signedFixture();
    await expect(
      authenticateConnectorRequest({
        request: new Request(`https://${authority}${path}`, {
          method: "POST",
          headers,
        }),
        body,
        connectors: {
          findActiveConnector: () =>
            Promise.resolve({ ...connector, publicKey: new Uint8Array(31) }),
        },
        nonces: { claim: () => Promise.resolve("claimed") },
        allowedAuthorities: [authority],
        nowUnixSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "invalid-signature", status: 401 });
  });
});

describe("consumer API keys", () => {
  it("stores only a keyed digest and verifies in constant time", () => {
    const pepper = { version: 1, value: "p".repeat(32) };
    const key = createApiKey(pepper);

    expect(key.secret).toMatch(
      /^knot_live_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/u,
    );
    expect(key.keyId).toHaveLength(16);
    expect(extractApiKeyId(key.secret)).toBe(key.keyId);
    expect(key.digestVersion).toBe(pepper.version);
    expect(key.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(key.digest).not.toContain(key.secret);
    expect(
      verifyApiKey({
        secret: key.secret,
        expectedKeyId: key.keyId,
        expectedDigest: key.digest,
        digestVersion: key.digestVersion,
        peppers: [pepper],
      }),
    ).toEqual({ valid: true, needsRehash: false });
    expect(
      verifyApiKey({
        secret: `${key.secret}x`,
        expectedKeyId: key.keyId,
        expectedDigest: key.digest,
        digestVersion: key.digestVersion,
        peppers: [pepper],
      }),
    ).toEqual({ valid: false });
    expect(
      verifyApiKey({
        secret: key.secret,
        expectedKeyId: "wrong-key-id-000",
        expectedDigest: key.digest,
        digestVersion: key.digestVersion,
        peppers: [pepper],
      }),
    ).toEqual({ valid: false });
  });

  it("supports a dual-pepper rotation window", () => {
    const oldPepper = { version: 1, value: "o".repeat(32) };
    const currentPepper = { version: 2, value: "n".repeat(32) };
    const key = createApiKey(oldPepper);
    const result = verifyApiKey({
      secret: key.secret,
      expectedKeyId: key.keyId,
      expectedDigest: key.digest,
      digestVersion: key.digestVersion,
      peppers: [currentPepper, oldPepper],
    });
    expect(result).toMatchObject({ valid: true, needsRehash: true });
    expect(result.valid && result.replacementDigest).toMatch(/^[a-f0-9]{64}$/u);
    if (!result.valid || !result.replacementDigest)
      throw new Error("rotation failed");
    expect(
      verifyApiKey({
        secret: key.secret,
        expectedKeyId: key.keyId,
        expectedDigest: result.replacementDigest,
        digestVersion: currentPepper.version,
        peppers: [currentPepper],
      }),
    ).toEqual({ valid: true, needsRehash: false });
  });
});
