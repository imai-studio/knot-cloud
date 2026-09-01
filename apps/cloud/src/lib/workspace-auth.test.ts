import { describe, expect, it, vi } from "vitest";

import {
  digestEmail,
  resolveWorkspaceForIdentity,
  type HumanSessionIdentity,
  type WorkspaceRepository,
} from "./workspace-auth";

vi.mock("@/lib/auth", () => ({
  getAuthorizedSession: vi.fn(),
}));

const identity: HumanSessionIdentity = {
  session: { id: "session-1" },
  user: {
    email: "Raj@Example.Test ",
    id: "auth-user-1",
    name: "Raj",
  },
};

describe("workspace authorization", () => {
  it("normalizes an email before creating its keyed digest", () => {
    const pepper = "p".repeat(32);
    expect(digestEmail(" Raj@Example.Test ", pepper)).toBe(
      digestEmail("raj@example.test", pepper),
    );
    expect(() => digestEmail("raj@example.test", "short")).toThrow(
      "Identity digest pepper must contain 32 characters",
    );
  });

  it("resolves the Better Auth session through the workspace repository", async () => {
    const resolveOrBootstrap = vi.fn().mockResolvedValue({
      name: "Personal workspace",
      role: "owner",
      suspended: false,
      tenantId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
    });
    const repository: WorkspaceRepository = {
      resolveOrBootstrap,
      selectForSession: vi.fn(),
    };

    await expect(
      resolveWorkspaceForIdentity(identity, repository, {
        pepper: "p".repeat(32),
        version: 7,
      }),
    ).resolves.toMatchObject({
      identity,
      workspace: { name: "Personal workspace", role: "owner" },
    });
    expect(resolveOrBootstrap).toHaveBeenCalledWith({
      authSessionId: "session-1",
      authUserId: "auth-user-1",
      defaultWorkspaceName: "Personal workspace",
      emailDigest: digestEmail("raj@example.test", "p".repeat(32)),
      emailDigestVersion: 7,
    });
  });

  it("rejects a missing or suspended workspace", async () => {
    const repository = (result: unknown): WorkspaceRepository => ({
      resolveOrBootstrap: vi.fn().mockResolvedValue(result),
      selectForSession: vi.fn(),
    });
    const configuration = { pepper: "p".repeat(32), version: 1 };

    await expect(
      resolveWorkspaceForIdentity(
        identity,
        repository(undefined),
        configuration,
      ),
    ).resolves.toBeNull();
    await expect(
      resolveWorkspaceForIdentity(
        identity,
        repository({
          name: "Suspended",
          role: "owner",
          suspended: true,
          tenantId: "00000000-0000-4000-8000-000000000001",
          userId: "00000000-0000-4000-8000-000000000002",
        }),
        configuration,
      ),
    ).resolves.toBeNull();
  });
});
