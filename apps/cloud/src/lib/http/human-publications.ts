import {
  publicationControlOperationSchema,
  publicationControlResultSchema,
} from "@imai/knot-cloud-contract";
import { z, ZodError, type ZodType } from "zod";

import { NeonPublicationRepository } from "@/lib/adapters/neon-publications";
import { createObjectStore } from "@/lib/adapters/factory";
import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import {
  PublicationService,
  type PublicationRepository,
} from "@/lib/publications";
import { canManageConnectors } from "@/lib/pairing";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { HttpProblem, jsonResponse, problemResponse } from "./problem";

const maximumHumanBodyBytes = 64 * 1024;

const siteSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/u)
      .refine(
        (value) =>
          !["api", "next", "www", "admin", "health", "assets"].includes(value),
        "Reserved site slug",
      ),
  })
  .strict();

export function createHumanPublicationHandlers(input: {
  repository: PublicationRepository;
  service: Pick<PublicationService, "control">;
}) {
  return {
    async listSites(request: Request) {
      try {
        const authorized = await getAuthorizedWorkspace(request.headers);
        if (!authorized) return authenticationProblem(request);
        return jsonResponse(
          await input.repository.listSites(authorized.workspace.tenantId),
        );
      } catch (error) {
        return humanPublicationProblem(request, error);
      }
    },

    async createSite(request: Request) {
      try {
        const authorized = await authorizeMutation(request);
        if (authorized instanceof Response) return authorized;
        const body = await readBoundedJson(request, siteSchema);
        return jsonResponse(
          await input.repository.createSite({
            tenantId: authorized.workspace.tenantId,
            ...body,
          }),
          201,
        );
      } catch (error) {
        return humanPublicationProblem(request, error);
      }
    },

    async listPublications(request: Request, siteId: string) {
      try {
        const authorized = await getAuthorizedWorkspace(request.headers);
        if (!authorized) return authenticationProblem(request);
        if (!z.uuid().safeParse(siteId).success) return invalidProblem(request);
        return jsonResponse(
          await input.repository.listPublications({
            tenantId: authorized.workspace.tenantId,
            siteId,
          }),
        );
      } catch (error) {
        return humanPublicationProblem(request, error);
      }
    },

    async listPublicationVersions(request: Request, publicationId: string) {
      try {
        const authorized = await getAuthorizedWorkspace(request.headers);
        if (!authorized) return authenticationProblem(request);
        if (!z.uuid().safeParse(publicationId).success)
          return invalidProblem(request);
        const versions = await input.repository.listPublicationVersions({
          tenantId: authorized.workspace.tenantId,
          publicationId,
        });
        return jsonResponse(
          versions.map((version) => ({
            ...version,
            createdAt: version.createdAt.toISOString(),
            committedAt: version.committedAt?.toISOString(),
          })),
        );
      } catch (error) {
        return humanPublicationProblem(request, error);
      }
    },

    async control(request: Request, publicationId: string) {
      try {
        const authorized = await authorizeMutation(request);
        if (authorized instanceof Response) return authorized;
        if (!z.uuid().safeParse(publicationId).success) {
          return invalidProblem(request);
        }
        const operation = await readBoundedJson(
          request,
          publicationControlOperationSchema,
          {
            publicationId,
          },
        );
        return jsonResponse(
          publicationControlResultSchema.parse(
            await input.service.control({
              tenantId: authorized.workspace.tenantId,
              operation,
            }),
          ),
        );
      } catch (error) {
        return humanPublicationProblem(request, error);
      }
    },
  };
}

export function createProductionHumanPublicationHandlers() {
  const repository = new NeonPublicationRepository();
  return createHumanPublicationHandlers({
    repository,
    service: new PublicationService(repository, createObjectStore()),
  });
}

async function authorizeMutation(request: Request) {
  if (!isTrustedHumanMutationOrigin(request)) {
    return problemResponse({
      request,
      status: 403,
      code: "forbidden",
      title: "The request origin is not trusted",
    });
  }
  const authorized = await getAuthorizedWorkspace(request.headers);
  if (!authorized) return authenticationProblem(request);
  if (!canManageConnectors(authorized)) {
    return problemResponse({
      request,
      status: 403,
      code: "forbidden",
      title: "This workspace role cannot change publications",
    });
  }
  return authorized;
}

function authenticationProblem(request: Request) {
  return problemResponse({
    request,
    status: 401,
    code: "authentication-required",
    title: "Sign in to manage this workspace",
  });
}

function invalidProblem(request: Request) {
  return problemResponse({
    request,
    status: 400,
    code: "invalid-request",
    title: "The identifier is invalid",
  });
}

async function readBoundedJson<T>(
  request: Request,
  schema: ZodType<T>,
  additions?: Record<string, unknown>,
): Promise<T> {
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
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumHumanBodyBytes
    ) {
      throw new HttpProblem(413, "payload-too-large", "Body is too large");
    }
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > maximumHumanBodyBytes) {
    throw new HttpProblem(413, "payload-too-large", "Body is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpProblem(400, "invalid-request", "Body is not valid JSON");
  }
  if (additions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpProblem(400, "invalid-request", "Body must be an object");
    }
    value = { ...value, ...additions };
  }
  return schema.parse(value);
}

function humanPublicationProblem(request: Request, error: unknown): Response {
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
      title: "The publication request is invalid",
    });
  }
  const code = databaseErrorCode(error);
  if (code === "P0002") {
    return problemResponse({
      request,
      status: 404,
      code: "not-found",
      title: "The publication resource was not found",
    });
  }
  if (["22000", "23505", "55000"].includes(code ?? "")) {
    return problemResponse({
      request,
      status: 409,
      code: "conflict",
      title: "The publication operation conflicts with the stored state",
    });
  }
  if (code === "22023") {
    return problemResponse({
      request,
      status: 400,
      code: "invalid-request",
      title: "The publication request is invalid",
    });
  }
  if (code === "42501") {
    return problemResponse({
      request,
      status: 403,
      code: "forbidden",
      title: "This workspace cannot change the publication",
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

function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
