import { problemDetailsSchema } from "@imai/knot-cloud-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "@/lib/audit";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { createSessionAuditHandler } from "./session-audit";

vi.mock("@/lib/workspace-auth", () => ({ getAuthorizedWorkspace: vi.fn() }));

const tenantId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000011";

describe("session audit HTTP service", () => {
  beforeEach(() => {
    vi.mocked(getAuthorizedWorkspace).mockReset();
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue({
      identity: {
        session: { id: "session-1" },
        user: { email: "raj@example.test", id: "user-1", name: "Raj" },
      },
      workspace: {
        name: "Workspace",
        role: "owner",
        suspended: false,
        tenantId,
        userId: "00000000-0000-4000-8000-000000000002",
      },
    });
  });

  it("returns a tenant-scoped page with validated filters", async () => {
    const list = vi.fn().mockResolvedValue({
      events: [
        {
          id: eventId,
          principalKind: "human-session",
          principalId: null,
          action: "connector.rename",
          targetKind: "connector",
          targetId: null,
          outcome: "succeeded",
          metadata: {},
          createdAt: new Date("2026-09-02T12:00:00.000Z"),
        },
      ],
      nextCursor: "next",
    });
    const response = await createSessionAuditHandler({ list })(
      new Request(
        "https://knot.test/api/v1/session/audit-events?action=connector.rename&limit=10",
      ),
    );

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(tenantId, {
      action: "connector.rename",
      limit: 10,
    });
    await expect(response.json()).resolves.toMatchObject({
      events: [{ id: eventId, createdAt: "2026-09-02T12:00:00.000Z" }],
      nextCursor: "next",
    });
  });

  it("denies members and rejects invalid filters before querying", async () => {
    vi.mocked(getAuthorizedWorkspace).mockResolvedValueOnce({
      identity: {
        session: { id: "session-1" },
        user: { email: "member@example.test", id: "user-1", name: "Member" },
      },
      workspace: {
        name: "Workspace",
        role: "member",
        suspended: false,
        tenantId,
        userId: "00000000-0000-4000-8000-000000000003",
      },
    });
    const repository: AuditRepository = { list: vi.fn() };
    const denied = await createSessionAuditHandler(repository)(
      new Request("https://knot.test/api/v1/session/audit-events"),
    );
    expect(denied.status).toBe(403);

    const invalid = await createSessionAuditHandler(repository)(
      new Request("https://knot.test/api/v1/session/audit-events?limit=500"),
    );
    expect(invalid.status).toBe(400);
    expect(problemDetailsSchema.parse(await invalid.json()).code).toBe(
      "invalid-request",
    );
    expect(repository.list).not.toHaveBeenCalled();
  });
});
