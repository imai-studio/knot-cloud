import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  anytypeOperationRequestSchema,
  requiredScopeForAnytypeOperation,
} from "./anytype-operation.js";
import { assetUploadRequestSchema } from "./asset-upload.js";
import { commandLeaseFenceSchema } from "./command.js";
import { commandEnvelopeSchema } from "./command.js";
import {
  negotiateProtocolVersion,
  protocolCompatibilityCaseSchema,
  supportedProtocolVersions,
} from "./compatibility.js";
import {
  endpointCredentialClassSchema,
  isPrincipalAllowedForEndpoint,
} from "./credential-policy.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import { operationResourceSchema } from "./operation-resource.js";
import { pairingSessionCreateSchema } from "./pairing.js";
import { attestedProvenanceSchema, principalKindSchema } from "./protocol.js";
import { canonicalSignedRequest, signedRequestSchema } from "./signing.js";

const compatibilityFixtureSchema = z
  .object({
    serverSupportedVersions: z.array(z.string()),
    cases: z.array(protocolCompatibilityCaseSchema),
  })
  .strict();

const goldenFixtureSchema = z
  .object({
    signedRequest: z
      .object({ input: signedRequestSchema, canonical: z.string() })
      .strict(),
    idempotency: z
      .object({
        input: z
          .object({
            credentialId: z.string(),
            tenantId: z.string(),
            operation: z.string(),
            targetId: z.string(),
            payload: z.json(),
          })
          .strict(),
        expected: z.string(),
      })
      .strict(),
    pairing: pairingSessionCreateSchema,
    assetUpload: assetUploadRequestSchema,
    operation: anytypeOperationRequestSchema,
  })
  .strict();

const adversarialFixtureSchema = z
  .object({
    credentialClassCases: z.array(
      z
        .object({
          endpointClass: endpointCredentialClassSchema,
          principal: principalKindSchema,
          allowed: z.boolean(),
        })
        .strict(),
    ),
    leaseFence: z
      .object({
        active: commandLeaseFenceSchema,
        cases: z.array(
          z
            .object({
              name: z.string(),
              candidate: commandLeaseFenceSchema,
              accepted: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
    untrustedNativeProvenance: z.json(),
  })
  .strict();

async function readFixture(relativePath: string): Promise<unknown> {
  const path = new URL(`../fixtures/${relativePath}`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("versioned protocol fixtures", () => {
  it("negotiates legacy, current, and newer client fixtures deterministically", async () => {
    const fixture = compatibilityFixtureSchema.parse(
      await readFixture("protocol/compatibility.json"),
    );
    expect(fixture.serverSupportedVersions).toEqual(supportedProtocolVersions);

    for (const compatibilityCase of fixture.cases) {
      expect(
        negotiateProtocolVersion(compatibilityCase.clientSupportedVersions) ??
          null,
        compatibilityCase.name,
      ).toBe(compatibilityCase.expectedNegotiatedVersion);
    }
  });

  it("keeps signing, idempotency, pairing, upload, and operation fixtures stable", async () => {
    const fixture = goldenFixtureSchema.parse(
      await readFixture("1.0/golden.json"),
    );

    expect(canonicalSignedRequest(fixture.signedRequest.input)).toBe(
      fixture.signedRequest.canonical,
    );
    await expect(deriveIdempotencyKey(fixture.idempotency.input)).resolves.toBe(
      fixture.idempotency.expected,
    );
    expect(fixture.pairing.requestedScopes).toEqual([
      "anytype.objects.read",
      "publications.write",
    ]);
    expect(fixture.assetUpload.byteSize).toBe(128);
    expect(fixture.operation.operation.type).toBe("collection.read");
  });
});

describe("adversarial boundary fixtures", () => {
  it("does not allow credential classes to substitute for one another", async () => {
    const fixture = adversarialFixtureSchema.parse(
      await readFixture("1.0/adversarial.json"),
    );

    for (const credentialCase of fixture.credentialClassCases) {
      expect(
        isPrincipalAllowedForEndpoint(
          credentialCase.endpointClass,
          credentialCase.principal,
        ),
      ).toBe(credentialCase.allowed);
    }
  });

  it("rejects stale attempts and stale lease tokens", async () => {
    const fixture = adversarialFixtureSchema.parse(
      await readFixture("1.0/adversarial.json"),
    );

    for (const leaseCase of fixture.leaseFence.cases) {
      expect(
        fixture.leaseFence.active.attempt === leaseCase.candidate.attempt &&
          fixture.leaseFence.active.leaseToken ===
            leaseCase.candidate.leaseToken,
        leaseCase.name,
      ).toBe(leaseCase.accepted);
    }
  });

  it("rejects raw native participant identity as connector provenance", async () => {
    const fixture = adversarialFixtureSchema.parse(
      await readFixture("1.0/adversarial.json"),
    );
    expect(() =>
      attestedProvenanceSchema.parse(fixture.untrustedNativeProvenance),
    ).toThrow();
  });
});

describe("closed operation vocabulary", () => {
  it("maps each newly frozen operation to one exact scope", () => {
    const operations = [
      {
        type: "collection.read",
        spaceId: "space-1",
        collectionId: "collection-1",
        limit: 50,
      },
      {
        type: "file.upload",
        spaceId: "space-1",
        assetDigest: "1".repeat(64),
        name: "asset.png",
      },
      { type: "file.download", spaceId: "space-1", fileId: "file-1" },
      {
        type: "chat.send",
        spaceId: "space-1",
        chatId: "chat-1",
        message: "hi",
      },
    ] as const;

    expect(
      operations.map((operation) =>
        requiredScopeForAnytypeOperation(operation),
      ),
    ).toEqual([
      "anytype.collections.read",
      "anytype.files.write",
      "anytype.files.read",
      "anytype.chats.send",
    ]);
  });

  it("rejects commands whose declared scope does not match their operation", () => {
    expect(() =>
      commandEnvelopeSchema.parse({
        protocolVersion: "1.0",
        commandId: "00000000-0000-4000-8000-000000000051",
        connectorId: "connector-1",
        requiredScope: "anytype.objects.write",
        createdBy: "consumer-api-key",
        actor: {
          principalDigest: "a".repeat(64),
          digestVersion: 1,
          provenance: "consumer-api-key",
        },
        createdAt: 1_788_192_000,
        notBefore: 1_788_192_000,
        expiresAt: 1_788_192_600,
        attempt: 1,
        leaseToken: "active-lease-token-0000000000000001",
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
    ).toThrow(/anytype.objects.read/u);
  });

  it("rejects a successful result for a different operation", () => {
    expect(() =>
      operationResourceSchema.parse({
        protocolVersion: "1.0",
        operationId: "operation-1",
        connectorId: "connector-1",
        operation: {
          type: "object.read",
          spaceId: "space-1",
          objectId: "object-1",
        },
        createdAt: 1_788_192_000,
        expiresAt: 1_788_192_600,
        status: "succeeded",
        completedAt: 1_788_192_100,
        result: {
          type: "chat.send",
          spaceId: "space-1",
          chatId: "chat-1",
          messageId: "message-1",
          sentAt: 1_788_192_100,
        },
      }),
    ).toThrow(/result type/u);
  });

  it("keeps model-facing operation results closed and minimal", () => {
    const base = {
      protocolVersion: "1.0",
      operationId: "operation-1",
      connectorId: "connector-1",
      operation: {
        type: "object.read",
        spaceId: "space-1",
        objectId: "object-1",
      },
      createdAt: 1_788_192_000,
      expiresAt: 1_788_192_600,
    } as const;
    expect(() =>
      operationResourceSchema.parse({
        ...base,
        status: "failed",
        attempt: 1,
        willRetry: false,
        problem: {
          type: "https://knot.example/problems/internal-error",
          title: "Operation failed",
          status: 500,
          code: "internal-error",
          requestId: "request_1234567890abcdef",
          retryable: false,
        },
        rawCloudBody: '{"document":"private"}',
        signature: "signed-secret",
        keyPath: "/private/connector-key.pem",
      }),
    ).toThrow();
    expect(() =>
      operationResourceSchema.parse({
        ...base,
        status: "succeeded",
        completedAt: 1_788_192_100,
        result: {
          type: "object.read",
          object: {
            spaceId: "space-1",
            objectId: "object-1",
            typeKey: "note",
            name: "Example",
            properties: {},
            provenance: {
              kind: "connector-attested-anytype",
              connectorId: "connector-1",
              senderDigest: "a".repeat(64),
              spaceId: "space-1",
              objectId: "object-1",
            },
          },
          rawCloudBody: "provider response",
        },
      }),
    ).toThrow();
  });
});
