import {
  consumerApiKeyCreateSchema,
  consumerApiKeyCreatedSchema,
  consumerApiKeyListSchema,
  consumerApiKeyMetadataSchema,
} from "@imai/knot-cloud-contract";
import { z, ZodError } from "zod";

import { NeonConsumerDataRepository } from "@/lib/adapters/neon-consumer-data";
import type { ConsumerDataRepository } from "@/lib/consumer-data";
import { getApiKeyPeppers } from "@/lib/env";
import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import { createApiKey } from "@/lib/security/api-key";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { jsonResponse, problemResponse } from "./problem";

let repository: ConsumerDataRepository | undefined;

function getRepository(): ConsumerDataRepository {
  repository ??= new NeonConsumerDataRepository();
  return repository;
}

function currentPepper() {
  return getApiKeyPeppers().reduce((latest, candidate) =>
    candidate.version > latest.version ? candidate : latest,
  );
}

async function authorize(request: Request, mutation: boolean) {
  if (mutation && !isTrustedHumanMutationOrigin(request)) return null;
  const authorized = await getAuthorizedWorkspace(request.headers);
  if (!authorized || authorized.workspace.role === "member") return null;
  return authorized.workspace;
}

function failure(request: Request, error: unknown): Response {
  if (error instanceof ZodError) {
    return problemResponse({
      request,
      status: 400,
      code: "invalid-request",
      title: "API key configuration is invalid",
    });
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  if (code === "42501") {
    return problemResponse({
      request,
      status: 403,
      code: "scope-denied",
      title: "A selected connector does not grant every requested scope",
    });
  }
  if (code === "23505") {
    return problemResponse({
      request,
      status: 409,
      code: "conflict",
      title: "The API key could not be created",
    });
  }
  return problemResponse({
    request,
    status: 500,
    code: "internal-error",
    title: "The API key service could not complete the request",
    retryable: true,
    retryAfterSeconds: 5,
  });
}

export function createSessionApiKeyHandlers(
  data: ConsumerDataRepository = getRepository(),
) {
  return {
    async list(request: Request): Promise<Response> {
      const workspace = await authorize(request, false);
      if (!workspace) {
        return problemResponse({
          request,
          status: 403,
          code: "forbidden",
          title: "This session cannot manage API keys",
        });
      }
      try {
        return jsonResponse(
          consumerApiKeyListSchema.parse({
            apiKeys: await data.listApiKeys(workspace.tenantId),
          }),
        );
      } catch (error) {
        return failure(request, error);
      }
    },

    async create(request: Request): Promise<Response> {
      const workspace = await authorize(request, true);
      if (!workspace) {
        return problemResponse({
          request,
          status: 403,
          code: "forbidden",
          title: "This session cannot manage API keys",
        });
      }
      try {
        const values = consumerApiKeyCreateSchema.parse(await request.json());
        const generated = createApiKey(currentPepper());
        const apiKey = await data.createApiKey({
          tenantId: workspace.tenantId,
          userId: workspace.userId,
          values,
          keyId: generated.keyId,
          keyDigest: generated.digest,
          digestVersion: generated.digestVersion,
        });
        return jsonResponse(
          consumerApiKeyCreatedSchema.parse({
            apiKey,
            secret: generated.secret,
          }),
          201,
        );
      } catch (error) {
        return failure(request, error);
      }
    },

    async inspect(request: Request, apiKeyId: string): Promise<Response> {
      const workspace = await authorize(request, false);
      if (!workspace) {
        return problemResponse({
          request,
          status: 403,
          code: "forbidden",
          title: "This session cannot manage API keys",
        });
      }
      try {
        z.uuid().parse(apiKeyId);
        const apiKey = await data.getApiKey(workspace.tenantId, apiKeyId);
        if (!apiKey) {
          return problemResponse({
            request,
            status: 404,
            code: "not-found",
            title: "API key not found",
          });
        }
        return jsonResponse(consumerApiKeyMetadataSchema.parse(apiKey));
      } catch (error) {
        return failure(request, error);
      }
    },

    async rotate(request: Request, apiKeyId: string): Promise<Response> {
      const workspace = await authorize(request, true);
      if (!workspace) {
        return problemResponse({
          request,
          status: 403,
          code: "forbidden",
          title: "This session cannot manage API keys",
        });
      }
      try {
        z.uuid().parse(apiKeyId);
        const generated = createApiKey(currentPepper());
        const apiKey = await data.rotateApiKey({
          tenantId: workspace.tenantId,
          userId: workspace.userId,
          apiKeyId,
          keyId: generated.keyId,
          keyDigest: generated.digest,
          digestVersion: generated.digestVersion,
        });
        if (!apiKey) {
          return problemResponse({
            request,
            status: 404,
            code: "not-found",
            title: "Active API key not found",
          });
        }
        return jsonResponse(
          consumerApiKeyCreatedSchema.parse({
            apiKey,
            secret: generated.secret,
          }),
        );
      } catch (error) {
        return failure(request, error);
      }
    },

    async revoke(request: Request, apiKeyId: string): Promise<Response> {
      const workspace = await authorize(request, true);
      if (!workspace) {
        return problemResponse({
          request,
          status: 403,
          code: "forbidden",
          title: "This session cannot manage API keys",
        });
      }
      try {
        z.uuid().parse(apiKeyId);
        const found = await data.revokeApiKey({
          tenantId: workspace.tenantId,
          userId: workspace.userId,
          apiKeyId,
        });
        if (!found) {
          return problemResponse({
            request,
            status: 404,
            code: "not-found",
            title: "API key not found",
          });
        }
        return new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        return failure(request, error);
      }
    },
  };
}
