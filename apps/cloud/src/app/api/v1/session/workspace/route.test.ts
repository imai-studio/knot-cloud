import { problemDetailsSchema } from "@imai/knot-cloud-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import {
  getAuthorizedWorkspace,
  selectAuthorizedWorkspace,
} from "@/lib/workspace-auth";

import { GET, PUT } from "./route";

vi.mock("@/lib/auth", () => ({
  isTrustedHumanMutationOrigin: vi.fn(),
}));
vi.mock("@/lib/workspace-auth", () => ({
  getAuthorizedWorkspace: vi.fn(),
  selectAuthorizedWorkspace: vi.fn(),
}));

const authorized = {
  identity: {
    session: { id: "session-1" },
    user: { email: "raj@example.test", id: "user-1", name: "Raj" },
  },
  workspace: {
    name: "Personal workspace",
    role: "owner" as const,
    suspended: false,
    tenantId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
  },
};

describe("session workspace route", () => {
  beforeEach(() => {
    vi.mocked(getAuthorizedWorkspace).mockReset();
    vi.mocked(selectAuthorizedWorkspace).mockReset();
    vi.mocked(isTrustedHumanMutationOrigin).mockReset();
  });

  it("returns the workspace selected for the signed-in session", async () => {
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue(authorized);
    const response = await GET(
      new Request("https://knot.example/api/v1/session/workspace"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      id: authorized.workspace.tenantId,
      name: "Personal workspace",
      role: "owner",
    });
  });

  it("returns a contract problem when no authorized workspace resolves", async () => {
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue(null);
    const response = await GET(
      new Request("https://knot.example/api/v1/session/workspace"),
    );
    const body = problemDetailsSchema.parse(await response.json());

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
    expect(body.code).toBe("authentication-required");
    expect(getAuthorizedWorkspace).toHaveBeenCalledOnce();
    expect(getAuthorizedWorkspace).toHaveBeenCalledWith(expect.any(Headers));
  });

  it("rejects cross-origin and malformed workspace changes", async () => {
    vi.mocked(isTrustedHumanMutationOrigin).mockReturnValue(false);
    const crossOrigin = await PUT(
      workspaceRequest({ tenantId: authorized.workspace.tenantId }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(selectAuthorizedWorkspace).not.toHaveBeenCalled();

    vi.mocked(isTrustedHumanMutationOrigin).mockReturnValue(true);
    const malformed = await PUT(workspaceRequest({ tenantId: "not-a-uuid" }));
    expect(malformed.status).toBe(400);
    expect(selectAuthorizedWorkspace).not.toHaveBeenCalled();
  });

  it("selects only a workspace authorized for the current session", async () => {
    vi.mocked(isTrustedHumanMutationOrigin).mockReturnValue(true);
    vi.mocked(selectAuthorizedWorkspace).mockResolvedValueOnce(null);
    const denied = await PUT(
      workspaceRequest({ tenantId: authorized.workspace.tenantId }),
    );
    expect(denied.status).toBe(403);

    vi.mocked(selectAuthorizedWorkspace).mockResolvedValueOnce(authorized);
    const response = await PUT(
      workspaceRequest({ tenantId: authorized.workspace.tenantId }),
    );
    expect(response.status).toBe(200);
    expect(selectAuthorizedWorkspace).toHaveBeenLastCalledWith(
      expect.any(Headers),
      authorized.workspace.tenantId,
    );
  });
});

function workspaceRequest(body: unknown) {
  return new Request("https://knot.example/api/v1/session/workspace", {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://knot.example",
    },
    method: "PUT",
  });
}
