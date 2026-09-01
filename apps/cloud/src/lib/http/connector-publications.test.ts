import {
  assetUploadCreatedSchema,
  problemDetailsSchema,
} from "@imai/knot-cloud-contract";
import { describe, expect, it, vi } from "vitest";

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
    },
  });
  const service = {
    requestAssetUpload,
    commitAssetUpload: vi.fn(),
    publish: vi.fn(),
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
});

function request(path: string, body: unknown): Request {
  return new Request(`https://knot.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
