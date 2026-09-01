import { NeonPairingRepository } from "@/lib/adapters/neon-pairing";
import { noStoreJson, problemResponse } from "@/lib/http";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorized = await getAuthorizedWorkspace(request.headers);
  if (!authorized) {
    return problemResponse(request, {
      status: 401,
      code: "authentication-required",
      title: "Sign in to view connectors.",
    });
  }
  const connectors = await new NeonPairingRepository().listConnectors(
    authorized.workspace.tenantId,
  );
  return noStoreJson({
    connectors: connectors.map((connector) => ({
      ...connector,
      createdAt: connector.createdAt.toISOString(),
      lastSeenAt: connector.lastSeenAt?.toISOString() ?? null,
      revokedAt: connector.revokedAt?.toISOString() ?? null,
    })),
  });
}
