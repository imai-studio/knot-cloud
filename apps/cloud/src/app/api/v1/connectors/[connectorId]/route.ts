import { z } from "zod";

import { NeonPairingRepository } from "@/lib/adapters/neon-pairing";
import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import { noStoreJson, problemResponse } from "@/lib/http";
import { canManageConnectors } from "@/lib/pairing";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

export const dynamic = "force-dynamic";

const renameSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ connectorId: string }> },
) {
  const authorized = await authorizeMutation(request);
  if (authorized instanceof Response) return authorized;
  const input = renameSchema.safeParse(await readJson(request));
  if (!input.success)
    return invalidRequest(
      request,
      "Enter a connector name between 1 and 100 characters.",
    );
  const { connectorId } = await context.params;
  const changed = await new NeonPairingRepository().rename({
    tenantId: authorized.workspace.tenantId,
    actorUserId: authorized.workspace.userId,
    connectorId,
    name: input.data.name,
  });
  if (!changed) return notFound(request);
  return noStoreJson({ connectorId, name: input.data.name });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ connectorId: string }> },
) {
  const authorized = await authorizeMutation(request);
  if (authorized instanceof Response) return authorized;
  const { connectorId } = await context.params;
  const changed = await new NeonPairingRepository().revoke({
    tenantId: authorized.workspace.tenantId,
    actorUserId: authorized.workspace.userId,
    connectorId,
    now: new Date(),
  });
  if (!changed) return notFound(request);
  return noStoreJson({ connectorId, revoked: true });
}

async function authorizeMutation(request: Request) {
  if (!isTrustedHumanMutationOrigin(request)) {
    return problemResponse(request, {
      status: 403,
      code: "forbidden",
      title: "This origin cannot change connectors.",
    });
  }
  const authorized = await getAuthorizedWorkspace(request.headers);
  if (!authorized) {
    return problemResponse(request, {
      status: 401,
      code: "authentication-required",
      title: "Sign in to manage connectors.",
    });
  }
  if (!canManageConnectors(authorized)) {
    return problemResponse(request, {
      status: 403,
      code: "forbidden",
      title: "Only workspace owners and admins can change connectors.",
    });
  }
  return authorized;
}

function invalidRequest(request: Request, title: string) {
  return problemResponse(request, {
    status: 400,
    code: "invalid-request",
    title,
  });
}

function notFound(request: Request) {
  return problemResponse(request, {
    status: 404,
    code: "not-found",
    title: "This connector does not exist in the workspace.",
  });
}

async function readJson(request: Request) {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}
