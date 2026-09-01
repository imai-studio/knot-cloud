import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  listDeliveryTenants: vi.fn(),
}));
const worker = vi.hoisted(() => ({ drainTenant: vi.fn() }));

vi.mock("@/lib/env", () => ({
  getCloudEnvironment: () => ({ CRON_SECRET: "c".repeat(32) }),
  getWebhookDestinations: () => new Map(),
}));
vi.mock("@/lib/adapters/neon-transactional-events", () => ({
  NeonTransactionalEventRepository: class {
    listDeliveryTenants = repository.listDeliveryTenants;
  },
}));
vi.mock("@/lib/webhook-delivery", () => ({
  WebhookDeliveryWorker: class {
    drainTenant = worker.drainTenant;
  },
}));

import { GET } from "./route";

const authorizedRequest = () =>
  new Request("https://knot.test/api/internal/webhooks/maintenance", {
    headers: { Authorization: `Bearer ${"c".repeat(32)}` },
  });

describe("webhook maintenance route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.listDeliveryTenants.mockResolvedValue([
      "00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("reports healthy dead-letter outcomes without failing the cron pass", async () => {
    worker.drainTenant.mockResolvedValue({
      delivered: 0,
      retried: 0,
      deadLettered: 1,
    });
    const response = await GET(authorizedRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deadLettered: 1,
      failedTenants: 0,
    });
  });

  it("fails only when tenant maintenance itself throws", async () => {
    worker.drainTenant.mockRejectedValue(new Error("database unavailable"));
    const response = await GET(authorizedRequest());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      deadLettered: 0,
      failedTenants: 1,
    });
  });
});
