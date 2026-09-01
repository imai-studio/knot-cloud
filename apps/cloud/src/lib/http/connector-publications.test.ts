import {
  assetUploadCreatedSchema,
  problemDetailsSchema,
} from "@imai/knot-cloud-contract";
import { describe, expect, it, vi } from "vitest";

import { ObjectDigestMismatchError, ObjectSizeError } from "@/lib/adapters/r2";
import { ConnectorAuthenticationError } from "@/lib/security/connector-auth";

import { createConnectorPublicationHandlers } from "./connector-publications";

const connectorId = "00000000-0000-4000-8000-000000000011";
const tenantId = "00000000-0000-4000-8000-000000000001";
const siteId = "00000000-0000-4000-8000-000000000021";
const assetId = "00000000-0000-4000-8000-000000000031";
const uploadId = "00000000-0000-4000-8000-000000000041";

function handlers(input?: { scopes?: string[]; connectorId?: string }) {
  const requestAssetUpload = vi.fn().mockResolvedValue({
    assetId,
    uploadId,
    expiresAt: new Date("2026-09-01T00:10:00Z"),
    duplicate: false,
    uploadUrl: "https://r2.example.test/signed-upload",
    requiredHeaders: {
      "content-type": "image/png",
      "if-none-match": "*",
      "x-amz-meta-byte-size": "100",
      "x-amz-meta-kind": "asset",
      "x-amz-meta-sha256": "a".repeat(64),
      "x-amz-meta-tenant-id": tenantId,
    },
  });
  const service = {
    requestAssetUpload,
    commitAssetUpload: vi.fn(),
    publish: vi.fn(),
    statusForConnector: vi.fn(),
    controlAsConnector: vi.fn(),
  };
  return {
    requestAssetUpload,
    service,
    handlers: createConnectorPublicationHandlers({
      service,
      connectors: { findActiveConnector: () => Promise.resolve(undefined) },
      nonces: { claim: () => Promise.resolve("claimed") },
      allowedAuthorities: ["knot.test"],
      authenticate: () =>
        Promise.resolve({
          connectorId: input?.connectorId ?? connectorId,
          tenantId,
          scopes: input?.scopes ?? ["publications.write"],
        }),
    }),
  };
}

describe("connector publication HTTP service", () => {
  it("creates a private presigned upload for an authorized connector", async () => {
    const service = handlers();
    const response = await service.handlers.requestAsset(
      request(`/api/v1/connectors/${connectorId}/assets/request`, {
        protocolVersion: "1.0",
        connectorId,
        siteId,
        sha256: "a".repeat(64),
        byteSize: 100,
        contentType: "image/png",
        fileName: "cover.png",
        idempotencyKey: "asset-request-0001",
      }),
      connectorId,
    );

    expect(response.status).toBe(201);
    expect(assetUploadCreatedSchema.parse(await response.json())).toMatchObject(
      {
        protocolVersion: "1.0",
        assetId,
        uploadId,
        method: "PUT",
        requiredHeaders: {
          "content-type": "image/png",
          "if-none-match": "*",
          "x-amz-meta-byte-size": "100",
          "x-amz-meta-kind": "asset",
          "x-amz-meta-sha256": "a".repeat(64),
          "x-amz-meta-tenant-id": tenantId,
        },
      },
    );
    expect(service.requestAssetUpload).toHaveBeenCalledWith({
      tenantId,
      connectorId,
      siteId,
      sha256: "a".repeat(64),
      byteSize: 100,
      contentType: "image/png",
      fileName: "cover.png",
      idempotencyKey: "asset-request-0001",
    });
  });

  it("rejects a connector without publication scope", async () => {
    const service = handlers({ scopes: [] });
    const response = await service.handlers.requestAsset(
      request(`/api/v1/connectors/${connectorId}/assets/request`, {}),
      connectorId,
    );

    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(await response.json()).code).toBe(
      "forbidden",
    );
    expect(service.requestAssetUpload).not.toHaveBeenCalled();
  });

  it("rejects a signed connector that differs from the path", async () => {
    const service = handlers({ connectorId: assetId });
    const response = await service.handlers.requestAsset(
      request(`/api/v1/connectors/${connectorId}/assets/request`, {}),
      connectorId,
    );

    expect(response.status).toBe(403);
    expect(service.requestAssetUpload).not.toHaveBeenCalled();
  });

  it("rejects an oversized control body before authentication", async () => {
    let authenticated = false;
    const service = createConnectorPublicationHandlers({
      service: {
        requestAssetUpload: vi.fn(),
        commitAssetUpload: vi.fn(),
        publish: vi.fn(),
        statusForConnector: vi.fn(),
        controlAsConnector: vi.fn(),
      },
      connectors: { findActiveConnector: () => Promise.resolve(undefined) },
      nonces: { claim: () => Promise.resolve("claimed") },
      allowedAuthorities: ["knot.test"],
      authenticate: () => {
        authenticated = true;
        return Promise.resolve({ connectorId, tenantId, scopes: [] });
      },
    });
    const response = await service.publish(
      new Request(
        `https://knot.test/api/v1/connectors/${connectorId}/publications`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(1024 * 1024 + 1),
          },
          body: "{}",
        },
      ),
      connectorId,
    );

    expect(response.status).toBe(413);
    expect(authenticated).toBe(false);
  });

  it("includes server time in a clock-skew problem", async () => {
    const service = createConnectorPublicationHandlers({
      service: {
        requestAssetUpload: vi.fn(),
        commitAssetUpload: vi.fn(),
        publish: vi.fn(),
        statusForConnector: vi.fn(),
        controlAsConnector: vi.fn(),
      },
      connectors: { findActiveConnector: () => Promise.resolve(undefined) },
      nonces: { claim: () => Promise.resolve("claimed") },
      allowedAuthorities: ["knot.test"],
      authenticate: () =>
        Promise.reject(new ConnectorAuthenticationError("clock-skew", 401)),
    });

    const before = Math.floor(Date.now() / 1_000);
    const response = await service.requestAsset(
      request(`/api/v1/connectors/${connectorId}/assets/request`, {}),
      connectorId,
    );
    const after = Math.floor(Date.now() / 1_000);
    const body = problemDetailsSchema.parse(await response.json());

    expect(response.status).toBe(401);
    expect(body.code).toBe("clock-skew");
    expect(body.serverUnixSeconds).toBeGreaterThanOrEqual(before);
    expect(body.serverUnixSeconds).toBeLessThanOrEqual(after);
  });

  it("maps object size failures to payload-too-large", async () => {
    const service = handlers();
    service.service.requestAssetUpload.mockRejectedValue(
      new ObjectSizeError("too large"),
    );

    const response = await service.handlers.requestAsset(
      request(
        `/api/v1/connectors/${connectorId}/assets/request`,
        validAssetRequest(),
      ),
      connectorId,
    );
    const body = problemDetailsSchema.parse(await response.json());

    expect(response.status).toBe(413);
    expect(body.code).toBe("payload-too-large");
    expect(body.retryable).toBe(false);
  });

  it("maps object digest failures to a terminal conflict", async () => {
    const service = handlers();
    service.service.commitAssetUpload.mockRejectedValue(
      new ObjectDigestMismatchError(),
    );

    const response = await service.handlers.commitAsset(
      request(`/api/v1/connectors/${connectorId}/assets/commit`, {
        protocolVersion: "1.0",
        uploadId,
        assetId,
        expectedSha256: "a".repeat(64),
        expectedByteSize: 100,
        idempotencyKey: "asset-commit-0001",
      }),
      connectorId,
    );
    const body = problemDetailsSchema.parse(await response.json());

    expect(response.status).toBe(409);
    expect(body.code).toBe("digest-mismatch");
    expect(body.retryable).toBe(false);
  });

  it("keeps known state conflicts distinct from server failures", async () => {
    const conflict = handlers();
    conflict.service.requestAssetUpload.mockRejectedValue(
      Object.assign(new Error("duplicate"), { code: "23505" }),
    );
    const conflictResponse = await conflict.handlers.requestAsset(
      request(
        `/api/v1/connectors/${connectorId}/assets/request`,
        validAssetRequest(),
      ),
      connectorId,
    );
    expect(conflictResponse.status).toBe(409);
    expect(problemDetailsSchema.parse(await conflictResponse.json()).code).toBe(
      "conflict",
    );

    const unknown = handlers();
    unknown.service.requestAssetUpload.mockRejectedValue(
      new Error("unexpected invariant"),
    );
    const unknownResponse = await unknown.handlers.requestAsset(
      request(
        `/api/v1/connectors/${connectorId}/assets/request`,
        validAssetRequest(),
      ),
      connectorId,
    );
    const unknownBody = problemDetailsSchema.parse(
      await unknownResponse.json(),
    );
    expect(unknownResponse.status).toBe(500);
    expect(unknownBody.code).toBe("internal-error");
    expect(unknownBody.retryable).toBe(true);
  });

  it("marks dependency outages as retryable service failures", async () => {
    const service = handlers();
    service.service.requestAssetUpload.mockRejectedValue(
      Object.assign(new Error("database unavailable"), { code: "08006" }),
    );
    const response = await service.handlers.requestAsset(
      request(
        `/api/v1/connectors/${connectorId}/assets/request`,
        validAssetRequest(),
      ),
      connectorId,
    );
    const body = problemDetailsSchema.parse(await response.json());

    expect(response.status).toBe(503);
    expect(body.code).toBe("dependency-unavailable");
    expect(body.retryable).toBe(true);
    expect(body.retryAfterSeconds).toBe(5);
  });

  it("returns status only with a read scope and an explicit service grant", async () => {
    const service = handlers({ scopes: ["publications.read"] });
    service.service.statusForConnector.mockResolvedValue({
      publicationId: assetId,
      siteId,
      slug: "guide",
      state: "ready",
      currentVersionId: uploadId,
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const response = await service.handlers.status(
      request(
        `/api/v1/connectors/${connectorId}/publications/${assetId}/status`,
        {
          protocolVersion: "1.0",
          connectorId,
          publicationId: assetId,
        },
      ),
      connectorId,
      assetId,
    );

    expect(response.status).toBe(200);
    expect(service.service.statusForConnector).toHaveBeenCalledWith({
      tenantId,
      connectorId,
      publicationId: assetId,
    });

    const denied = handlers({ scopes: ["publications.write"] });
    const deniedResponse = await denied.handlers.status(
      request(
        `/api/v1/connectors/${connectorId}/publications/${assetId}/status`,
        {
          protocolVersion: "1.0",
          connectorId,
          publicationId: assetId,
        },
      ),
      connectorId,
      assetId,
    );
    expect(deniedResponse.status).toBe(403);
    expect(denied.service.statusForConnector).not.toHaveBeenCalled();
  });

  it("requires the unpublish scope and binds control idempotency to the request", async () => {
    const service = handlers({ scopes: ["publications.unpublish"] });
    service.service.controlAsConnector.mockResolvedValue({
      type: "publication.unpublish",
      publicationId: assetId,
      unpublishedAt: 1_788_220_800,
    });
    const body = {
      protocolVersion: "1.0",
      connectorId,
      idempotencyKey: "unpublish-request-0001",
      operation: {
        type: "publication.unpublish",
        publicationId: assetId,
      },
    };
    const response = await service.handlers.control(
      request(
        `/api/v1/connectors/${connectorId}/publications/${assetId}/control`,
        body,
      ),
      connectorId,
      assetId,
    );

    expect(response.status).toBe(200);
    expect(service.service.controlAsConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        connectorId,
        idempotencyKey: "unpublish-request-0001",
        requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );

    const denied = handlers({ scopes: ["publications.write"] });
    const deniedResponse = await denied.handlers.control(
      request(
        `/api/v1/connectors/${connectorId}/publications/${assetId}/control`,
        body,
      ),
      connectorId,
      assetId,
    );
    expect(deniedResponse.status).toBe(403);
    expect(denied.service.controlAsConnector).not.toHaveBeenCalled();
  });
});

function validAssetRequest() {
  return {
    protocolVersion: "1.0",
    connectorId,
    siteId,
    sha256: "a".repeat(64),
    byteSize: 100,
    contentType: "image/png",
    fileName: "cover.png",
    idempotencyKey: "asset-request-0001",
  };
}

function request(path: string, body: unknown): Request {
  return new Request(`https://knot.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
