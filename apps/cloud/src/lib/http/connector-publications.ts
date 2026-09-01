import {
  assetUploadCommitSchema,
  assetUploadCreatedSchema,
  assetUploadRequestSchema,
  assetUploadResultSchema,
  protocolVersion,
  publicationMutationSchema,
} from "@imai/knot-cloud-contract";
import { ZodError, type ZodType } from "zod";

import { NeonConnectorRepository } from "@/lib/adapters/neon-connectors";
import { NeonPublicationRepository } from "@/lib/adapters/neon-publications";
import { UpstashReplayNonceStore } from "@/lib/adapters/upstash-replay";
import { createObjectStore } from "@/lib/adapters/factory";
import { getSigningAuthorities } from "@/lib/env";
import type { ReplayNonceStore } from "@/lib/ports";
import { PublicationService } from "@/lib/publications";
import {
  authenticateConnectorRequest,
  ConnectorAuthenticationError,
  type ConnectorRepository,
} from "@/lib/security/connector-auth";

import { HttpProblem, jsonResponse, problemResponse } from "./problem";

const maximumControlBodyBytes = 1024 * 1024;

export interface ConnectorPublicationDependencies {
  service: Pick<
    PublicationService,
    "requestAssetUpload" | "commitAssetUpload" | "publish"
  >;
  connectors: ConnectorRepository;
  nonces: ReplayNonceStore;
  allowedAuthorities: readonly string[];
  authenticate?: typeof authenticateConnectorRequest;
}

export function createConnectorPublicationHandlers(
  dependencies: ConnectorPublicationDependencies,
) {
  const authenticate =
    dependencies.authenticate ?? authenticateConnectorRequest;

  async function execute(
    request: Request,
    pathConnectorId: string,
    operation: (body: Uint8Array, tenantId: string) => Promise<Response>,
  ): Promise<Response> {
    try {
      if (
        request.headers
          .get("Content-Type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      ) {
        throw new HttpProblem(
          400,
          "invalid-request",
          "Content-Type must be application/json",
        );
      }
      const body = await readBoundedBody(request, maximumControlBodyBytes);
      const connector = await authenticate({
        request,
        body,
        connectors: dependencies.connectors,
        nonces: dependencies.nonces,
        allowedAuthorities: dependencies.allowedAuthorities,
      });
      if (connector.connectorId !== pathConnectorId) {
        throw new HttpProblem(
          403,
          "forbidden",
          "The signed connector does not match the request path",
        );
      }
      if (!connector.scopes.includes("publications.write")) {
        throw new HttpProblem(
          403,
          "forbidden",
          "The connector cannot write publications",
        );
      }
      return await operation(body, connector.tenantId);
    } catch (error) {
      if (error instanceof ConnectorAuthenticationError) {
        return problemResponse({
          request,
          status: error.status,
          code:
            error.code === "invalid-signature" ||
            error.code === "connector-not-found"
              ? "authentication-required"
              : error.code,
          title: "Connector authentication failed",
        });
      }
      if (error instanceof HttpProblem) {
        return problemResponse({
          request,
          status: error.status,
          code: error.code,
          title: error.message,
        });
      }
      if (error instanceof ZodError) {
        return problemResponse({
          request,
          status: 400,
          code: "invalid-request",
          title: "Request body does not match the protocol",
        });
      }
      const code =
        error instanceof Error && error.message === "asset-upload-missing"
          ? "not-found"
          : "conflict";
      return problemResponse({
        request,
        status: code === "not-found" ? 404 : 409,
        code,
        title: "The publication operation could not be completed",
        retryable: false,
      });
    }
  }

  return {
    requestAsset(request: Request, connectorId: string) {
      return execute(request, connectorId, async (body, tenantId) => {
        const input = parseJson(body, assetUploadRequestSchema);
        requireMatchingConnector(input.connectorId, connectorId);
        const result = await dependencies.service.requestAssetUpload({
          tenantId,
          connectorId,
          siteId: input.siteId,
          sha256: input.sha256,
          byteSize: input.byteSize,
          contentType: input.contentType,
          fileName: input.fileName,
          idempotencyKey: input.idempotencyKey,
        });
        return jsonResponse(
          assetUploadCreatedSchema.parse({
            protocolVersion,
            assetId: result.assetId,
            uploadId: result.uploadId,
            method: "PUT",
            uploadUrl: result.uploadUrl,
            requiredHeaders: result.requiredHeaders,
            expiresAt: Math.floor(result.expiresAt.getTime() / 1_000),
          }),
          201,
        );
      });
    },

    commitAsset(request: Request, connectorId: string) {
      return execute(request, connectorId, async (body, tenantId) => {
        const input = parseJson(body, assetUploadCommitSchema);
        const result = await dependencies.service.commitAssetUpload({
          tenantId,
          connectorId,
          uploadId: input.uploadId,
          assetId: input.assetId,
          expectedSha256: input.expectedSha256,
          expectedByteSize: input.expectedByteSize,
        });
        return jsonResponse(
          assetUploadResultSchema.parse({
            status: "verified",
            assetId: result.assetId,
            sha256: result.sha256,
            byteSize: result.byteSize,
            verifiedAt: Math.floor(result.verifiedAt.getTime() / 1_000),
          }),
        );
      });
    },

    publish(request: Request, connectorId: string) {
      return execute(request, connectorId, async (body, tenantId) => {
        const mutation = parseJson(body, publicationMutationSchema);
        requireMatchingConnector(mutation.connectorId, connectorId);
        return jsonResponse(
          await dependencies.service.publish({
            tenantId,
            connectorId,
            mutation,
          }),
          201,
        );
      });
    },
  };
}

export function createProductionConnectorPublicationHandlers() {
  const repository = new NeonPublicationRepository();
  return createConnectorPublicationHandlers({
    service: new PublicationService(repository, createObjectStore()),
    connectors: new NeonConnectorRepository(),
    nonces: new UpstashReplayNonceStore(),
    allowedAuthorities: getSigningAuthorities(),
  });
}

function requireMatchingConnector(bodyId: string, pathId: string): void {
  if (bodyId !== pathId) {
    throw new HttpProblem(
      403,
      "forbidden",
      "The connector body does not match the request path",
    );
  }
}

function parseJson<T>(body: Uint8Array, schema: ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpProblem(400, "invalid-request", "Body is not valid JSON");
  }
  return schema.parse(value);
}

async function readBoundedBody(
  request: Request,
  maximumBodyBytes: number,
): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumBodyBytes
    ) {
      throw new HttpProblem(413, "payload-too-large", "Body is too large");
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBodyBytes) {
    throw new HttpProblem(413, "payload-too-large", "Body is too large");
  }
  return bytes;
}
