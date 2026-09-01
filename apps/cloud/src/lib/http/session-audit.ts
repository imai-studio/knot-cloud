import { z } from "zod";

import { NeonAuditRepository } from "@/lib/adapters/neon-audit";
import { auditPrincipalKinds, type AuditRepository } from "@/lib/audit";
import { canManageConnectors } from "@/lib/pairing";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { jsonResponse, problemResponse } from "./problem";

const filtersSchema = z.object({
  action: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  outcome: z.string().trim().min(1).max(100).optional(),
  principalKind: z.enum(auditPrincipalKinds).optional(),
});

export function createSessionAuditHandler(
  repository: AuditRepository = new NeonAuditRepository(),
) {
  return async function list(request: Request): Promise<Response> {
    const authorized = await getAuthorizedWorkspace(request.headers);
    if (!authorized) {
      return problemResponse({
        request,
        status: 401,
        code: "authentication-required",
        title: "Sign in to review workspace activity",
      });
    }
    if (!canManageConnectors(authorized)) {
      return problemResponse({
        request,
        status: 403,
        code: "forbidden",
        title: "This workspace role cannot review the audit log",
      });
    }
    const url = new URL(request.url);
    const parsed = filtersSchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (!parsed.success) {
      return problemResponse({
        request,
        status: 400,
        code: "invalid-request",
        title: "The audit log filters are invalid",
      });
    }
    try {
      const page = await repository.list(
        authorized.workspace.tenantId,
        parsed.data,
      );
      return jsonResponse({
        events: page.events.map((event) => ({
          ...event,
          createdAt: event.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        return problemResponse({
          request,
          status: 400,
          code: "invalid-request",
          title: "The audit log cursor is invalid",
        });
      }
      return problemResponse({
        request,
        status: 500,
        code: "internal-error",
        title: "The audit log could not be loaded",
        retryable: true,
        retryAfterSeconds: 5,
      });
    }
  };
}
