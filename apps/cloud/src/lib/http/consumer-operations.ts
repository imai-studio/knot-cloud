import {
  anytypeOperationRequestSchema,
  anytypeOperationResultSchema,
  canonicalJson,
  operationAcceptedSchema,
  operationResourceSchema,
  problemDetailsSchema,
  protocolVersion,
  requiredScopeForAnytypeOperation,
  sha256Hex,
  type JsonValue,
} from "@imai/knot-cloud-contract";
import { z, ZodError } from "zod";

import { NeonConsumerDataRepository } from "@/lib/adapters/neon-consumer-data";
import {
  ConsumerDataError,
  type ConsumerDataRepository,
  type ResolvedConsumerApiKey,
} from "@/lib/consumer-data";
import {
  authenticateConsumerApiKey,
  digestConsumerActor,
} from "@/lib/security/consumer-api-key";

import { jsonResponse, problemResponse } from "./problem";

const maximumBodyBytes = 256 * 1024;

export interface ConsumerOperationDependencies {
  repository: ConsumerDataRepository;
  authenticate?: (
    authorization: string | null,
  ) => Promise<ResolvedConsumerApiKey>;
  actorDigest?: (keyId: string) => { digest: string; version: number };
  now?: () => Date;
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0];
  if (contentType?.trim().toLowerCase() !== "application/json") {
    throw new ConsumerDataError(
      "invalid-request",
      "Content-Type must be application/json",
    );
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength > maximumBodyBytes
  ) {
    throw new ConsumerDataError("invalid-request", "Request body is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBodyBytes) {
    throw new ConsumerDataError("invalid-request", "Request body is too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ConsumerDataError(
      "invalid-request",
      "Request body is not valid JSON",
    );
  }
}

function seconds(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}

export function createConsumerOperationHandlers(
  dependencies: ConsumerOperationDependencies,
) {
  const now = dependencies.now ?? (() => new Date());
  const authenticate =
    dependencies.authenticate ??
    ((authorization) =>
      authenticateConsumerApiKey({
        authorization,
        repository: dependencies.repository,
      }));
  const actorDigest = dependencies.actorDigest ?? digestConsumerActor;

  async function execute(
    request: Request,
    operation: (credential: ResolvedConsumerApiKey) => Promise<Response>,
  ): Promise<Response> {
    try {
      const credential = await authenticate(
        request.headers.get("Authorization"),
      );
      return await operation(credential);
    } catch (error) {
      if (error instanceof ConsumerDataError) {
        const status =
          error.code === "authentication-required"
            ? 401
            : error.code === "quota-exceeded"
              ? 429
              : error.code === "idempotency-conflict"
                ? 409
                : error.code === "invalid-request"
                  ? 400
                  : 403;
        const protocolCode =
          error.code === "connector-denied"
            ? "forbidden"
            : error.code === "idempotency-conflict"
              ? "conflict"
              : error.code;
        const response = problemResponse({
          request,
          status,
          code: protocolCode,
          title: error.message,
          retryable: status === 429,
          retryAfterSeconds: status === 429 ? 60 : undefined,
        });
        if (status === 401) {
          response.headers.set(
            "WWW-Authenticate",
            'Bearer realm="Knot Anytype data API"',
          );
        }
        return response;
      }
      if (error instanceof ZodError) {
        return problemResponse({
          request,
          status: 400,
          code: "invalid-request",
          title: "Request body does not match the Anytype operation protocol",
        });
      }
      return problemResponse({
        request,
        status: 500,
        code: "internal-error",
        title: "The Anytype operation service could not complete the request",
        retryable: true,
        retryAfterSeconds: 5,
      });
    }
  }

  return {
    submit(request: Request): Promise<Response> {
      return execute(request, async (credential) => {
        const body = anytypeOperationRequestSchema.parse(
          await readJson(request),
        );
        z.uuid().parse(body.connectorId);
        const currentSeconds = seconds(now());
        if (Math.abs(body.createdAt - currentSeconds) > 5 * 60) {
          throw new ConsumerDataError(
            "invalid-request",
            "Operation creation time is outside the accepted window",
          );
        }
        const requiredScope = requiredScopeForAnytypeOperation(body.operation);
        if (!credential.scopes.includes(requiredScope)) {
          throw new ConsumerDataError("scope-denied", "API key scope denied");
        }
        if (!credential.connectorIds.includes(body.connectorId)) {
          throw new ConsumerDataError(
            "connector-denied",
            "Connector binding denied",
          );
        }
        const requestSha256 = await sha256Hex(
          canonicalJson(body as unknown as JsonValue),
        );
        const actor = actorDigest(credential.keyId);
        const result = await dependencies.repository.enqueueOperation({
          tenantId: credential.tenantId,
          apiKeyId: credential.id,
          connectorId: body.connectorId,
          requiredScope,
          operation: body.operation,
          idempotencyKey: body.idempotencyKey,
          requestSha256,
          createdAt: new Date(body.createdAt * 1_000),
          expiresAt: new Date(body.expiresAt * 1_000),
          actorDigest: actor.digest,
          actorDigestVersion: actor.version,
        });
        return jsonResponse(
          operationAcceptedSchema.parse({
            protocolVersion,
            operationId: result.commandId,
            status: "pending",
            statusUrl: `/api/v1/operations/${result.commandId}`,
            createdAt: body.createdAt,
            expiresAt: body.expiresAt,
          }),
          202,
        );
      });
    },

    status(request: Request, commandId: string): Promise<Response> {
      return execute(request, async (credential) => {
        z.uuid().parse(commandId);
        const record = await dependencies.repository.getOperation({
          tenantId: credential.tenantId,
          apiKeyId: credential.id,
          commandId,
        });
        if (!record) {
          return problemResponse({
            request,
            status: 404,
            code: "not-found",
            title: "Operation not found",
          });
        }
        const base = {
          protocolVersion,
          operationId: record.id,
          connectorId: record.connectorId,
          operation: record.operation,
          createdAt: seconds(record.createdAt),
          expiresAt: seconds(record.expiresAt),
        };
        if (record.state === "pending") {
          return jsonResponse(
            operationResourceSchema.parse({ ...base, status: "pending" }),
          );
        }
        if (record.state === "leased") {
          return jsonResponse(
            operationResourceSchema.parse({
              ...base,
              status: "processing",
              attempt: record.attemptCount,
            }),
          );
        }
        if (record.state === "succeeded") {
          return jsonResponse(
            operationResourceSchema.parse({
              ...base,
              status: "succeeded",
              result: anytypeOperationResultSchema.parse(record.result),
              completedAt: seconds(record.updatedAt),
            }),
          );
        }
        if (record.state === "rejected-by-local-policy") {
          return jsonResponse(
            operationResourceSchema.parse({
              ...base,
              status: record.state,
              reasonCode: record.errorCode ?? "local-policy-rejected",
              completedAt: seconds(record.updatedAt),
            }),
          );
        }
        if (record.state === "failed") {
          const failureCode = record.errorCode ?? "connector-offline";
          return jsonResponse(
            operationResourceSchema.parse({
              ...base,
              status: "failed",
              problem: problemDetailsSchema.parse({
                type: new URL(
                  `/problems/${encodeURIComponent(failureCode)}`,
                  request.url,
                ).toString(),
                title: "The local connector could not complete the operation",
                status: 502,
                code: failureCode,
                requestId: crypto.randomUUID().replaceAll("-", ""),
                retryable: false,
              }),
              willRetry: false,
              attempt: Math.max(record.attemptCount, 1),
            }),
          );
        }
        return jsonResponse(
          operationResourceSchema.parse({
            ...base,
            status: record.state,
            completedAt: seconds(record.updatedAt),
          }),
        );
      });
    },
  };
}

let productionHandlers:
  ReturnType<typeof createConsumerOperationHandlers> | undefined;

export function createProductionConsumerOperationHandlers() {
  productionHandlers ??= createConsumerOperationHandlers({
    repository: new NeonConsumerDataRepository(),
  });
  return productionHandlers;
}
