import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  listMaintenanceTenants: vi.fn(),
  sweepOrphans: vi.fn(),
  countDeadLetters: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  retry: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getCloudEnvironment: () => ({ CRON_SECRET: "c".repeat(32) }),
}));
vi.mock("@/lib/adapters/neon-publications", () => ({
  NeonDeletionOutboxRepository: class {
    listMaintenanceTenants = repository.listMaintenanceTenants;
    sweepOrphans = repository.sweepOrphans;
    countDeadLetters = repository.countDeadLetters;
    claim = repository.claim;
    complete = repository.complete;
    retry = repository.retry;
    finalize = repository.finalize;
  },
}));
vi.mock("@/lib/adapters/factory", () => ({
  createObjectStore: () => ({ deleteTombstoned: vi.fn() }),
}));

import { GET } from "./route";

describe("publication maintenance route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.listMaintenanceTenants.mockResolvedValue([]);
  });

  it("rejects requests without the dedicated cron bearer secret", async () => {
    const response = await GET(
      new Request("https://knot.test/api/internal/publications/maintenance"),
    );
    expect(response.status).toBe(401);
    expect(repository.listMaintenanceTenants).not.toHaveBeenCalled();
  });

  it("runs a bounded maintenance pass for an authenticated cron request", async () => {
    const response = await GET(
      new Request("https://knot.test/api/internal/publications/maintenance", {
        headers: { Authorization: `Bearer ${"c".repeat(32)}` },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      protocolVersion: "1.0",
      tenants: 0,
      failedTenants: 0,
      deadLettered: 0,
    });
    expect(repository.listMaintenanceTenants).toHaveBeenCalledWith(
      expect.objectContaining({ graceSeconds: 86_400, limit: 10 }),
    );
  });
});
