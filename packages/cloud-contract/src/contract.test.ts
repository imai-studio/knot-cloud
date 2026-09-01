import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { anytypeOperationRequestSchema } from "./anytype-operation.js";
import { canonicalJson, sha256Hex } from "./canonical-json.js";
import { commandEnvelopeSchema } from "./command.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import { pairingGrantSchema, pairingSessionPollSchema } from "./pairing.js";
import { protocolVersion } from "./protocol.js";
import {
  canonicalSignedRequest,
  verifyEd25519Signature,
  type SignedRequest,
} from "./signing.js";

const zeroDigest = "0".repeat(64);

describe("canonical protocol primitives", () => {
  it("canonicalizes object keys and negative zero deterministically", () => {
    expect(canonicalJson({ z: -0, a: [true, null, "x"] })).toBe(
      '{"a":[true,null,"x"],"z":0}',
    );
  });

  it("sorts object keys by code unit and rejects non-integer numbers", () => {
    expect(canonicalJson({ B: 1, a: 2, _: 3 })).toBe('{"B":1,"_":3,"a":2}');
    expect(() => canonicalJson({ value: 1.5 })).toThrow(/safe integers/u);
  });

  it("matches the SHA-256 reference vector", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("derives the same idempotency key regardless of payload key order", async () => {
    const left = await deriveIdempotencyKey({
      credentialId: "connector-1",
      tenantId: "tenant-1",
      operation: "object.update",
      targetId: "object-1",
      payload: { b: 2, a: 1 },
    });
    const right = await deriveIdempotencyKey({
      credentialId: "connector-1",
      tenantId: "tenant-1",
      operation: "object.update",
      targetId: "object-1",
      payload: { a: 1, b: 2 },
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^kc1_[a-f0-9]{64}$/u);
  });
});

describe("signed connector requests", () => {
  it("uses an exact canonical signing string and verifies Ed25519", async () => {
    const request: SignedRequest = {
      protocolVersion,
      connectorId: "connector-1",
      authority: "cloud.knot.imai.tech",
      method: "POST",
      path: "/api/v1/connectors/connector-1/commands/claim",
      query: "",
      timestamp: 1_788_192_000,
      nonce: "nonce_1234567890abcdef",
      bodySha256: zeroDigest,
    };

    expect(canonicalSignedRequest(request)).toBe(
      [
        "knot-cloud-ed25519-v1",
        "1.0",
        "connector-1",
        "cloud.knot.imai.tech",
        "POST",
        "/api/v1/connectors/connector-1/commands/claim",
        "",
        "1788192000",
        "nonce_1234567890abcdef",
        zeroDigest,
      ].join("\n"),
    );

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = sign(
      null,
      Buffer.from(canonicalSignedRequest(request)),
      privateKey,
    );
    const publicKeyBytes = publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32);

    await expect(
      verifyEd25519Signature({
        request,
        publicKey: publicKeyBytes,
        signature,
      }),
    ).resolves.toBe(true);
  });

  it("accepts encoded query values but rejects encoded path separators", async () => {
    const { signedRequestSchema } = await import("./signing.js");
    const base = {
      protocolVersion,
      connectorId: "connector-1",
      authority: "[::1]:3000",
      method: "GET",
      timestamp: 1_788_192_000,
      nonce: "nonce_1234567890abcdef",
      bodySha256: zeroDigest,
    };
    expect(
      signedRequestSchema.parse({
        ...base,
        path: "/api/v1/objects",
        query: "?cursor=a%2Fb",
      }).query,
    ).toBe("?cursor=a%2Fb");
    expect(() =>
      signedRequestSchema.parse({
        ...base,
        path: "/api%2Fv1/objects",
        query: "",
      }),
    ).toThrow();
  });

  it("rejects unsafe publication links and ambiguous slugs", async () => {
    const { publicationDocumentSchema, publicationMutationSchema } =
      await import("./publication.js");
    expect(() =>
      publicationDocumentSchema.parse({
        schemaVersion: "1.0",
        title: "Unsafe",
        blocks: [
          {
            type: "paragraph",
            content: [{ text: "click", href: "javascript:alert(1)" }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      publicationMutationSchema.pick({ slug: true }).parse({ slug: "a//b" }),
    ).toThrow();

    const digest = "1".repeat(64);
    expect(() =>
      publicationMutationSchema.parse({
        connectorId: "00000000-0000-4000-8000-000000000011",
        siteId: "00000000-0000-4000-8000-000000000021",
        publicationId: "00000000-0000-4000-8000-000000000031",
        slug: "page",
        operation: "create",
        document: {
          schemaVersion: "1.0",
          title: "Page",
          blocks: [{ type: "image", assetDigest: digest }],
        },
        contentSha256: "2".repeat(64),
        assetDigests: [],
        idempotencyKey: "publication-key-0001",
      }),
    ).toThrow(/declared/u);
  });
});

describe("typed remote operations", () => {
  it("accepts bounded Anytype operations", () => {
    expect(
      anytypeOperationRequestSchema.parse({
        protocolVersion,
        connectorId: "connector-1",
        idempotencyKey: "operation-key-0001",
        createdAt: 1_788_192_000,
        expiresAt: 1_788_192_600,
        operation: {
          type: "object.read",
          spaceId: "space-1",
          objectId: "object-1",
        },
      }).operation.type,
    ).toBe("object.read");
  });

  it("rejects an arbitrary execution payload", () => {
    expect(() =>
      anytypeOperationRequestSchema.parse({
        protocolVersion,
        connectorId: "connector-1",
        idempotencyKey: "operation-key-0002",
        createdAt: 1_788_192_000,
        expiresAt: 1_788_192_600,
        operation: { type: "execute", prompt: "read the filesystem" },
      }),
    ).toThrow();
  });

  it("requires lease fencing on commands", () => {
    expect(() =>
      commandEnvelopeSchema.parse({
        protocolVersion,
        commandId: "00000000-0000-4000-8000-000000000051",
        connectorId: "connector-1",
        requiredScope: "anytype.objects.read",
        createdBy: "consumer-api-key",
        createdAt: 1_788_192_000,
        notBefore: 1_788_192_000,
        expiresAt: 1_788_192_600,
        attempt: 1,
        leaseExpiresAt: 1_788_192_060,
        payload: {
          domain: "anytype",
          operation: {
            type: "object.read",
            spaceId: "space-1",
            objectId: "object-1",
          },
        },
      }),
    ).toThrow();
  });
});

describe("pairing identifiers", () => {
  it("requires UUID pairing IDs and unique site grants", () => {
    expect(() =>
      pairingSessionPollSchema.parse({
        protocolVersion,
        pairingId: "not-a-uuid",
        pollToken: "a".repeat(43),
      }),
    ).toThrow();
    expect(() =>
      pairingGrantSchema.parse({
        scopes: ["anytype.objects.read"],
        siteIds: [
          "00000000-0000-4000-8000-000000000031",
          "00000000-0000-4000-8000-000000000031",
        ],
        slugGrants: [],
      }),
    ).toThrow(/unique/u);
  });
});
