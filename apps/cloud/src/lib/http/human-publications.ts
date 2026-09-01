import {
  publicationControlOperationSchema,
  publicationControlResultSchema,
} from "@imai/knot-cloud-contract";
import { z } from "zod";

import { NeonPublicationRepository } from "@/lib/adapters/neon-publications";
import { createObjectStore } from "@/lib/adapters/factory";
import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import {
  PublicationService,
  type PublicationRepository,
} from "@/lib/publications";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { jsonResponse, problemResponse } from "./problem";

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
      const authorized = await getAuthorizedWorkspace(request.headers);
      if (!authorized) return authenticationProblem(request);
      return jsonResponse(
        await input.repository.listSites(authorized.workspace.tenantId),
      );
    },

    async createSite(request: Request) {
      const authorized = await authorizeMutation(request);
      if (authorized instanceof Response) return authorized;
      let body: z.infer<typeof siteSchema>;
      try {
        body = siteSchema.parse(await request.json());
      } catch {
        return problemResponse({
          request,
          status: 400,
          code: "invalid-request",
          title: "The site request is invalid",
        });
      }
      try {
        return jsonResponse(
          await input.repository.createSite({
            tenantId: authorized.workspace.tenantId,
            ...body,
          }),
          201,
        );
      } catch {
        return problemResponse({
          request,
          status: 409,
          code: "conflict",
          title: "The site slug is already in use",
        });
      }
    },

    async listPublications(request: Request, siteId: string) {
      const authorized = await getAuthorizedWorkspace(request.headers);
      if (!authorized) return authenticationProblem(request);
      if (!z.uuid().safeParse(siteId).success) return invalidProblem(request);
      return jsonResponse(
        await input.repository.listPublications({
          tenantId: authorized.workspace.tenantId,
          siteId,
        }),
      );
    },

    async control(request: Request, publicationId: string) {
      const authorized = await authorizeMutation(request);
      if (authorized instanceof Response) return authorized;
      if (!z.uuid().safeParse(publicationId).success) {
        return invalidProblem(request);
      }
      try {
        const operation = publicationControlOperationSchema.parse({
          ...(await request.json()),
          publicationId,
        });
        return jsonResponse(
          publicationControlResultSchema.parse(
            await input.service.control({
              tenantId: authorized.workspace.tenantId,
              operation,
            }),
          ),
        );
      } catch {
        return problemResponse({
          request,
          status: 409,
          code: "conflict",
          title: "The publication state could not be changed",
        });
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
  if (!["owner", "admin"].includes(authorized.workspace.role)) {
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
