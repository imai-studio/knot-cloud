import { pairingSessionCreateSchema } from "@imai/knot-cloud-contract";

import { NeonPairingRepository } from "@/lib/adapters/neon-pairing";
import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import { noStoreJson, problemResponse } from "@/lib/http";
import { canManageConnectors, createPairingSession } from "@/lib/pairing";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorized = await getAuthorizedWorkspace(request.headers);
  if (!authorized) return authenticationRequired(request);
  const reviews = await new NeonPairingRepository().listReviews(
    authorized.workspace.tenantId,
  );
  return noStoreJson({
    pairings: reviews.map((review) => ({
      ...review,
      createdAt: review.createdAt.toISOString(),
      expiresAt: review.expiresAt.toISOString(),
    })),
  });
}

export async function POST(request: Request) {
  if (!isTrustedHumanMutationOrigin(request)) {
    return problemResponse(request, {
      status: 403,
      code: "forbidden",
      title: "This origin cannot create a pairing request.",
    });
  }
  const authorized = await getAuthorizedWorkspace(request.headers);
  if (!authorized) return authenticationRequired(request);
  if (!canManageConnectors(authorized)) {
    return problemResponse(request, {
      status: 403,
      code: "forbidden",
      title: "Only workspace owners and admins can pair connectors.",
    });
  }
  const parsed = pairingSessionCreateSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return problemResponse(request, {
      status: 400,
      code: "invalid-request",
      title: "Check the connector name, public key, protocol, and scopes.",
    });
  }
  const created = await createPairingSession(
    authorized,
    parsed.data,
    new NeonPairingRepository(),
  );
  if (!created) {
    return problemResponse(request, {
      status: 403,
      code: "forbidden",
      title: "Only workspace owners and admins can pair connectors.",
    });
  }
  return noStoreJson(created, 201);
}

async function readJson(request: Request) {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}

function authenticationRequired(request: Request) {
  return problemResponse(request, {
    status: 401,
    code: "authentication-required",
    title: "Sign in to view this workspace.",
  });
}
