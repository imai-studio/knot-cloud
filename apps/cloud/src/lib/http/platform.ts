import { resolveTxt } from "node:dns/promises";

import { z, ZodError } from "zod";

import { NeonPlatformRepository } from "@/lib/adapters/neon-platform";
import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import { getDomainChallengeSecret } from "@/lib/env";
import {
  PlatformService,
  PlatformUnavailableError,
  type PlatformRepository,
} from "@/lib/platform";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { HttpProblem, jsonResponse, problemResponse } from "./problem";

const bodyLimit = 16 * 1024;
const uuidSchema = z.uuid();
const customDomainSchema = z
  .object({ hostname: z.string().trim().min(4).max(253) })
  .strict();
const readerAccessSchema = z
  .object({ readerAccess: z.enum(["public", "authenticated"]) })
  .strict();
const readerGrantSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    expiresAt: z.iso.datetime({ offset: true }),
    maxRedemptions: z.number().int().min(1).max(100).default(1),
  })
  .strict();

export function createPlatformHandlers(input: {
  repository: PlatformRepository;
  service: PlatformService;
}) {
  async function authorize(request: Request, mutation = false) {
    if (mutation && !isTrustedHumanMutationOrigin(request)) {
      return problemResponse({
        request,
        status: 403,
        code: "forbidden",
        title: "The request origin is not trusted",
      });
    }
    const authorized = await getAuthorizedWorkspace(request.headers);
    if (!authorized) {
      return problemResponse({
        request,
        status: 401,
        code: "authentication-required",
        title: "Sign in to manage this workspace",
      });
    }
    if (mutation && !["owner", "admin"].includes(authorized.workspace.role)) {
      return problemResponse({
        request,
        status: 403,
        code: "forbidden",
        title: "This workspace role cannot change platform settings",
      });
    }
    return authorized;
  }

  async function siteForRequest(
    request: Request,
    siteId: string,
    mutation = false,
  ) {
    const authorized = await authorize(request, mutation);
    if (authorized instanceof Response) return authorized;
    if (!uuidSchema.safeParse(siteId).success) return invalid(request);
    const site = await input.repository.getSite({
      tenantId: authorized.workspace.tenantId,
      siteId,
    });
    if (!site) return missing(request);
    return { authorized, site };
  }

  return {
    async getPlatform(request: Request) {
      try {
        const authorized = await authorize(request);
        if (authorized instanceof Response) return authorized;
        return jsonResponse({
          capabilities: input.service.capabilities(),
          usage: await input.repository.getUsage(authorized.workspace.tenantId),
        });
      } catch (error) {
        return platformProblem(request, error);
      }
    },

    async getSiteAccess(request: Request, siteId: string) {
      try {
        const context = await siteForRequest(request, siteId);
        if (context instanceof Response) return context;
        return jsonResponse({ readerAccess: context.site.readerAccess });
      } catch (error) {
        return platformProblem(request, error);
      }
    },

    async updateSiteAccess(request: Request, siteId: string) {
      try {
        const context = await siteForRequest(request, siteId, true);
        if (context instanceof Response) return context;
        const body = await readJson(request, readerAccessSchema);
        await input.repository.setSiteReaderAccess({
          tenantId: context.authorized.workspace.tenantId,
          userId: context.authorized.workspace.userId,
          siteId,
          readerAccess: body.readerAccess,
        });
        return jsonResponse({ readerAccess: body.readerAccess });
      } catch (error) {
        return platformProblem(request, error);
      }
    },

    async listDomains(request: Request, siteId: string) {
      try {
        const context = await siteForRequest(request, siteId);
        if (context instanceof Response) return context;
        const domains = await input.repository.listCustomDomains({
          tenantId: context.authorized.workspace.tenantId,
          siteId,
        });
        const canShowChallenge =
          input.service.capabilities().customDomains.available;
        return jsonResponse(
          await Promise.all(
            domains.map(async (domain) => ({
              ...serializeDomain(domain),
              ...(canShowChallenge &&
              (domain.status === "pending" || domain.status === "failed")
                ? await input.service.verificationInstructions(domain)
                : {}),
            })),
          ),
        );
      } catch (error) {
        return platformProblem(request, error);
      }
    },

    async createDomain(request: Request, siteId: string) {
      try {
        const context = await siteForRequest(request, siteId, true);
        if (context instanceof Response) return context;
        const body = await readJson(request, customDomainSchema);
        const domain = await input.service.createCustomDomain({
          tenantId: context.authorized.workspace.tenantId,
          userId: context.authorized.workspace.userId,
          siteId,
          hostname: body.hostname,
        });
        return jsonResponse(
          {
            ...serializeDomain(domain),
            dnsName: domain.dnsName,
            dnsValue: domain.dnsValue,
          },
          201,
        );
      } catch (error) {
        return platformProblem(request, error);
      }
    },

    async verifyDomain(request: Request, siteId: string, domainId: string) {
      try {
        const context = await siteForRequest(request, siteId, true);
        if (context instanceof Response) return context;
        if (!uuidSchema.safeParse(domainId).success) return invalid(request);
        const domains = await input.repository.listCustomDomains({
          tenantId: context.authorized.workspace.tenantId,
          siteId,
        });
        const domain = domains.find((candidate) => candidate.id === domainId);
        if (!domain) return missing(request);
        const checked = await input.service.verifyCustomDomain({
          tenantId: context.authorized.workspace.tenantId,
          userId: context.authorized.workspace.userId,
          domain,
        });
        return jsonResponse(serializeDomain(checked));
      } catch (error) {
        return platformProblem(request, error);
      }
    },

    async disableDomain(request: Request, siteId: string, domainId: string) {
      try {
        const context = await siteForRequest(request, siteId, true);
        if (context instanceof Response) return context;
        if (!uuidSchema.safeParse(domainId).success) return invalid(request);
        const disabled = await input.repository.disableCustomDomain({
          tenantId: context.authorized.workspace.tenantId,
          userId: context.authorized.workspace.userId,
          domainId,
        });
        return disabled
          ? new Response(null, { status: 204 })
          : missing(request);
      } catch (error) {
        return platformProblem(request, error);
      }
    },

    async listReaderGrants(request: Request, siteId: string) {
      try {
        const context = await siteForRequest(request, siteId);
        if (context instanceof Response) return context;
        const grants = await input.repository.listReaderGrants({
          tenantId: context.authorized.workspace.tenantId,
          siteId,
        });
        return jsonResponse(grants.map(serializeReaderGrant));
      } catch (error) {
        return platformProblem(request, error);
      }
    },

    async createReaderGrant(request: Request, siteId: string) {
      try {
        const context = await siteForRequest(request, siteId, true);
        if (context instanceof Response) return context;
        const body = await readJson(request, readerGrantSchema);
        const created = await input.service.createReaderGrant({
          tenantId: context.authorized.workspace.tenantId,
          userId: context.authorized.workspace.userId,
          siteId,
          label: body.label,
          expiresAt: new Date(body.expiresAt),
          maxRedemptions: body.maxRedemptions,
        });
        return jsonResponse(
          { ...serializeReaderGrant(created.grant), token: created.token },
          201,
        );
      } catch (error) {
        return platformProblem(request, error);
      }
    },

    async revokeReaderGrant(request: Request, siteId: string, grantId: string) {
      try {
        const context = await siteForRequest(request, siteId, true);
        if (context instanceof Response) return context;
        if (!uuidSchema.safeParse(grantId).success) return invalid(request);
        const revoked = await input.repository.revokeReaderGrant({
          tenantId: context.authorized.workspace.tenantId,
          userId: context.authorized.workspace.userId,
          grantId,
        });
        return revoked ? new Response(null, { status: 204 }) : missing(request);
      } catch (error) {
        return platformProblem(request, error);
      }
    },
  };
}

export function createProductionPlatformHandlers() {
  const repository = new NeonPlatformRepository();
  let secret: string | undefined;
  try {
    secret = getDomainChallengeSecret();
  } catch {
    secret = undefined;
  }
  return createPlatformHandlers({
    repository,
    service: new PlatformService(repository, secret, { resolve: resolveTxt }),
  });
}

async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (
    request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    throw new HttpProblem(
      400,
      "invalid-request",
      "Content-Type must be application/json",
    );
  }
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) > bodyLimit) {
    throw new HttpProblem(413, "payload-too-large", "Body is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > bodyLimit) {
    throw new HttpProblem(413, "payload-too-large", "Body is too large");
  }
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof ZodError) throw error;
    throw new HttpProblem(400, "invalid-request", "Body is not valid JSON");
  }
}

function serializeDomain(domain: {
  id: string;
  siteId: string;
  hostname: string;
  status: string;
  lastErrorCode?: string;
  verifiedAt?: Date;
  lastCheckedAt?: Date;
  challengeExpiresAt: Date;
  createdAt: Date;
}) {
  return {
    ...domain,
    verifiedAt: domain.verifiedAt?.toISOString(),
    lastCheckedAt: domain.lastCheckedAt?.toISOString(),
    challengeExpiresAt: domain.challengeExpiresAt.toISOString(),
    createdAt: domain.createdAt.toISOString(),
  };
}

function serializeReaderGrant(grant: {
  id: string;
  siteId: string;
  label: string;
  expiresAt: Date;
  maxRedemptions: number;
  redemptionCount: number;
  revokedAt?: Date;
  createdAt: Date;
}) {
  return {
    ...grant,
    expiresAt: grant.expiresAt.toISOString(),
    revokedAt: grant.revokedAt?.toISOString(),
    createdAt: grant.createdAt.toISOString(),
  };
}

function invalid(request: Request) {
  return problemResponse({
    request,
    status: 400,
    code: "invalid-request",
    title: "The identifier is invalid",
  });
}

function missing(request: Request) {
  return problemResponse({
    request,
    status: 404,
    code: "not-found",
    title: "The platform resource was not found",
  });
}

function platformProblem(request: Request, error: unknown): Response {
  if (error instanceof HttpProblem) {
    return problemResponse({
      request,
      status: error.status,
      code: error.code,
      title: error.message,
    });
  }
  if (error instanceof PlatformUnavailableError) {
    return problemResponse({
      request,
      status: 503,
      code: "dependency-unavailable",
      title: "This platform capability is not configured",
    });
  }
  if (error instanceof ZodError || error instanceof TypeError) {
    return problemResponse({
      request,
      status: 400,
      code: "invalid-request",
      title: "The platform request is invalid",
    });
  }
  const code = databaseCode(error);
  if (code === "P0002") return missing(request);
  if (code === "P0001") {
    return problemResponse({
      request,
      status: 429,
      code: "quota-exceeded",
      title: "This workspace has reached its configured limit",
    });
  }
  if (code === "23505") {
    return problemResponse({
      request,
      status: 409,
      code: "conflict",
      title: "That platform resource already exists",
    });
  }
  if (code === "42501") {
    return problemResponse({
      request,
      status: 403,
      code: "forbidden",
      title: "This workspace cannot change the platform resource",
    });
  }
  if (code === "22023") {
    return problemResponse({
      request,
      status: 400,
      code: "invalid-request",
      title: "The platform request is invalid",
    });
  }
  return problemResponse({
    request,
    status: 500,
    code: "internal-error",
    title: "The platform operation could not be completed",
    retryable: true,
  });
}

function databaseCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
