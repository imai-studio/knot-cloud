import {
  pairingApprovalSchema,
  pairingDenialSchema,
  type ProblemDetails,
} from "@imai/knot-cloud-contract";
import { z } from "zod";

import { NeonPairingRepository } from "@/lib/adapters/neon-pairing";
import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import { noStoreJson, problemResponse } from "@/lib/http";
import { canManageConnectors } from "@/lib/pairing";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

export const dynamic = "force-dynamic";

const decisionSchema = z.union([pairingApprovalSchema, pairingDenialSchema]);

export async function PUT(
  request: Request,
  context: { params: Promise<{ pairingId: string }> },
) {
  if (!isTrustedHumanMutationOrigin(request)) {
    return failure(
      request,
      403,
      "forbidden",
      "This origin cannot review pairing requests.",
    );
  }
  const authorized = await getAuthorizedWorkspace(request.headers);
  if (!authorized) {
    return failure(
      request,
      401,
      "authentication-required",
      "Sign in to review this request.",
    );
  }
  if (!canManageConnectors(authorized)) {
    return failure(
      request,
      403,
      "forbidden",
      "Only workspace owners and admins can review pairing requests.",
    );
  }
  const { pairingId } = await context.params;
  const input = decisionSchema.safeParse(await readJson(request));
  if (!input.success || input.data.pairingId !== pairingId) {
    return failure(
      request,
      400,
      "invalid-request",
      "The pairing decision is invalid.",
    );
  }
  const repository = new NeonPairingRepository();
  if (input.data.decision === "deny") {
    const outcome = await repository.deny({
      tenantId: authorized.workspace.tenantId,
      actorUserId: authorized.workspace.userId,
      pairingId,
      now: new Date(),
    });
    return decisionResponse(request, outcome);
  }
  const result = await repository.approve({
    tenantId: authorized.workspace.tenantId,
    actorUserId: authorized.workspace.userId,
    pairingId,
    grant: input.data.grant,
    now: new Date(),
  });
  return decisionResponse(request, result.outcome, result.connectorId);
}

function decisionResponse(
  request: Request,
  outcome: string,
  connectorId?: string,
) {
  if (["approved", "denied"].includes(outcome)) {
    return noStoreJson({ outcome, ...(connectorId ? { connectorId } : {}) });
  }
  const status =
    outcome === "not-found" ? 404 : outcome === "expired" ? 410 : 409;
  const titles: Record<string, string> = {
    conflict: "This pairing request already has a different decision.",
    expired: "This pairing request has expired.",
    forbidden: "This session cannot review this pairing request.",
    "not-found": "This pairing request does not exist in the workspace.",
    "revoked-key": "This public key belongs to a revoked connector.",
    "scope-escalation":
      "The grant exceeds the scopes requested by the connector.",
    "unknown-site": "The grant includes a site outside this workspace.",
  };
  const code: ProblemDetails["code"] =
    outcome === "not-found"
      ? "not-found"
      : outcome === "forbidden"
        ? "forbidden"
        : ["scope-escalation", "unknown-site"].includes(outcome)
          ? "scope-denied"
          : "conflict";
  return failure(
    request,
    status,
    code,
    titles[outcome] ?? "The pairing request could not be updated.",
  );
}

function failure(
  request: Request,
  status: number,
  code: ProblemDetails["code"],
  title: string,
) {
  return problemResponse(request, { status, code, title });
}

async function readJson(request: Request) {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}
