import { problemDetailsSchema } from "@imai/knot-cloud-contract";
import { z } from "zod";

import { getAuthorizedSession, isTrustedHumanMutationOrigin } from "@/lib/auth";
import { getAppBaseUrl } from "@/lib/env";
import {
  getAuthorizedWorkspace,
  selectAuthorizedWorkspace,
} from "@/lib/workspace-auth";

export const dynamic = "force-dynamic";

const selectionSchema = z.object({ tenantId: z.uuid() }).strict();

export async function GET(request: Request) {
  // SECURITY: This authenticated, no-store read intentionally performs the one-time
  // workspace bootstrap. The database verifies the Better Auth session and serializes
  // creation; anonymous or unverified requests cannot mutate tenant state.
  const authorized = await getAuthorizedWorkspace(request.headers);
  if (!authorized) {
    const identity = await getAuthorizedSession(request.headers);
    return identity
      ? problem(request, 403, "forbidden")
      : problem(request, 401, "authentication-required");
  }
  return workspaceResponse(authorized.workspace);
}

export async function PUT(request: Request) {
  if (!isTrustedHumanMutationOrigin(request)) {
    return problem(request, 403, "forbidden");
  }
  let input: z.infer<typeof selectionSchema>;
  try {
    input = selectionSchema.parse(await request.json());
  } catch {
    return problem(request, 400, "invalid-request");
  }
  const authorized = await selectAuthorizedWorkspace(
    request.headers,
    input.tenantId,
  );
  if (!authorized) return problem(request, 403, "forbidden");
  return workspaceResponse(authorized.workspace);
}

function workspaceResponse(workspace: {
  tenantId: string;
  name: string;
  role: "owner" | "admin" | "member";
}) {
  return Response.json(
    {
      id: workspace.tenantId,
      name: workspace.name,
      role: workspace.role,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function problem(
  request: Request,
  status: 400 | 401 | 403,
  code: "invalid-request" | "authentication-required" | "forbidden",
) {
  void request;
  const titles = {
    "invalid-request": "The workspace request is invalid.",
    "authentication-required": "Sign in to access this workspace.",
    forbidden: "This session cannot access that workspace.",
  } as const;
  const body = problemDetailsSchema.parse({
    type: new URL(`/problems/${code}`, getAppBaseUrl()).toString(),
    title: titles[code],
    status,
    code,
    requestId: crypto.randomUUID(),
    retryable: false,
  });
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/problem+json",
    },
  });
}
