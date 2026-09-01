import {
  assetUploadCommitSchema,
  assetUploadCreatedSchema,
  assetUploadRequestSchema,
  assetUploadResultSchema,
  canonicalJson,
  connectorPublicationControlRequestSchema,
  connectorPublicationStatusRequestSchema,
  connectorPublicationStatusSchema,
  protocolVersion,
  publicationControlResultSchema,
  publicationCreatedSchema,
  publicationMutationSchema,
  sha256Hex,
} from "@imai/knot-cloud-contract";
import { ZodError, type ZodType } from "zod";

import { NeonConnectorRepository } from "@/lib/adapters/neon-connectors";
import { NeonPublicationRepository } from "@/lib/adapters/neon-publications";
import { ObjectDigestMismatchError, ObjectSizeError } from "@/lib/adapters/r2";
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
    | "requestAssetUpload"
    | "commitAssetUpload"
    | "publish"
    | "statusForConnector"
    | "controlAsConnector"
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
    operation: (
      body: Uint8Array,
      connector: { tenantId: string; connectorId: string; scopes: string[] },
    ) => Promise<Response>,
    requiredScope?: "publications.read" | "publications.write",
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
      if (requiredScope && !connector.scopes.includes(requiredScope)) {
        throw new HttpProblem(
          403,
          "forbidden",
          "The connector does not have the required publication scope",
        );
      }
      return await operation(body, connector);
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
          serverUnixSeconds:
            error.code === "clock-skew"
              ? Math.floor(Date.now() / 1_000)
              : undefined,
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
      return publicationProblem(request, error);
    }
  }

  return {
    requestAsset(request: Request, connectorId: string) {
      return execute(
        request,
        connectorId,
        async (body, connector) => {
          const input = parseJson(body, assetUploadRequestSchema);
          requireMatchingConnector(input.connectorId, connectorId);
          const result = await dependencies.service.requestAssetUpload({
            tenantId: connector.tenantId,
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
        },
        "publications.write",
      );
    },

    commitAsset(request: Request, connectorId: string) {
      return execute(
        request,
        connectorId,
        async (body, connector) => {
          const input = parseJson(body, assetUploadCommitSchema);
          const result = await dependencies.service.commitAssetUpload({
            tenantId: connector.tenantId,
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
        },
        "publications.write",
      );
    },

    publish(request: Request, connectorId: string) {
      return execute(
        request,
        connectorId,
        async (body, connector) => {
          const mutation = parseJson(body, publicationMutationSchema);
          requireMatchingConnector(mutation.connectorId, connectorId);
          const result = await dependencies.service.publish({
            tenantId: connector.tenantId,
            connectorId,
            mutation,
          });
          return jsonResponse(
            publicationCreatedSchema.parse({ protocolVersion, ...result }),
            201,
          );
        },
        "publications.write",
      );
    },

    status(request: Request, connectorId: string, publicationId: string) {
      return execute(
        request,
        connectorId,
        async (body, connector) => {
          const input = parseJson(
            body,
            connectorPublicationStatusRequestSchema,
          );
          requireMatchingConnector(input.connectorId, connectorId);
          if (input.publicationId !== publicationId) {
            throw new HttpProblem(
              403,
              "forbidden",
              "The publication body does not match the request path",
            );
          }
          const status = await dependencies.service.statusForConnector({
            tenantId: connector.tenantId,
            connectorId,
            publicationId,
          });
          return jsonResponse(
            connectorPublicationStatusSchema.parse({
              protocolVersion,
              ...status,
              updatedAt: Math.floor(status.updatedAt.getTime() / 1_000),
            }),
          );
        },
        "publications.read",
      );
    },

    control(request: Request, connectorId: string, publicationId: string) {
      return execute(request, connectorId, async (body, connector) => {
        const input = parseJson(body, connectorPublicationControlRequestSchema);
        requireMatchingConnector(input.connectorId, connectorId);
        if (input.operation.publicationId !== publicationId) {
          throw new HttpProblem(
            403,
            "forbidden",
            "The publication body does not match the request path",
          );
        }
        const requiredScope =
          input.operation.type === "publication.unpublish"
            ? "publications.unpublish"
            : "publications.write";
        if (!connector.scopes.includes(requiredScope)) {
          throw new HttpProblem(
            403,
            "forbidden",
            "The connector does not have the required publication scope",
          );
        }
        const requestSha256 = await sha256Hex(canonicalJson(input));
        return jsonResponse(
          publicationControlResultSchema.parse(
            await dependencies.service.controlAsConnector({
              tenantId: connector.tenantId,
              connectorId,
              operation: input.operation,
              idempotencyKey: input.idempotencyKey,
              requestSha256,
            }),
          ),
        );
      });
    },
  };
}

function publicationProblem(request: Request, error: unknown): Response {
  if (error instanceof ObjectDigestMismatchError) {
    return problemResponse({
      request,
      status: 409,
      code: "digest-mismatch",
      title: "The uploaded object does not match its declared digest",
    });
  }
  if (error instanceof ObjectSizeError) {
    return problemResponse({
      request,
      status: 413,
      code: "payload-too-large",
      title: "The publication object exceeds the configured size limit",
    });
  }

  const databaseCode = errorCode(error);
  const message = error instanceof Error ? error.message : undefined;
  if (message === "asset-upload-missing" || databaseCode === "P0002") {
    return problemResponse({
      request,
      status: 404,
      code: "not-found",
      title: "The publication resource was not found",
    });
  }
  if (message === "connector-mismatch" || databaseCode === "42501") {
    return problemResponse({
      request,
      status: 403,
      code: "forbidden",
      title: "The connector is not authorized for this publication",
    });
  }
  if (databaseCode === "22023") {
    return problemResponse({
      request,
      status: 400,
      code: "invalid-request",
      title: "The publication request is invalid",
    });
  }
  if (
    message === "asset-size-mismatch" ||
    message === "publication-digest-mismatch" ||
    databaseCode === "22000" ||
    databaseCode === "23505" ||
    databaseCode === "55000"
  ) {
    return problemResponse({
      request,
      status: 409,
      code:
        message === "publication-digest-mismatch"
          ? "digest-mismatch"
          : "conflict",
      title: "The publication operation conflicts with the stored state",
    });
  }
  if (isDependencyFailure(error)) {
    return problemResponse({
      request,
      status: 503,
      code: "dependency-unavailable",
      title: "A publication dependency is temporarily unavailable",
      retryable: true,
      retryAfterSeconds: 5,
    });
  }
  return problemResponse({
    request,
    status: 500,
    code: "internal-error",
    title: "The publication operation could not be completed",
    retryable: true,
  });
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function isDependencyFailure(error: unknown): boolean {
  const code = errorCode(error);
  if (
    code?.startsWith("08") ||
    code?.startsWith("53") ||
    ["57P01", "57P02", "57P03"].includes(code ?? "")
  ) {
    return true;
  }
  if (!error || typeof error !== "object") return false;
  const name =
    "name" in error && typeof error.name === "string" ? error.name : "";
  if (["AbortError", "TimeoutError"].includes(name)) return true;
  if (
    !("$metadata" in error) ||
    !error.$metadata ||
    typeof error.$metadata !== "object"
  ) {
    return false;
  }
  const status =
    "httpStatusCode" in error.$metadata &&
    typeof error.$metadata.httpStatusCode === "number"
      ? error.$metadata.httpStatusCode
      : undefined;
  return status !== undefined && status >= 500;
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
