import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  listDeliveryTenants: vi.fn(),
}));
const worker = vi.hoisted(() => ({ drainTenant: vi.fn() }));
const environment = vi.hoisted(() => ({
  destinations: new Map([
    ["automation", { url: "https://hooks.example.com/knot", secret: "s" }],
  ]),
}));

vi.mock("@/lib/env", () => ({
  getCloudEnvironment: () => ({ CRON_SECRET: "c".repeat(32) }),
  getWebhookDestinations: () => environment.destinations,
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
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.clearAllMocks();
    environment.destinations = new Map([
      ["automation", { url: "https://hooks.example.com/knot", secret: "s" }],
    ]);
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
      tenants: 1,
      dueTenants: 1,
      tenantScanLimit: 100,
      scanTruncated: false,
      deliverySlots: 10,
      deadLettered: 10,
      failedTenants: 0,
    });
    expect(worker.drainTenant).toHaveBeenCalledTimes(10);
    expect(worker.drainTenant).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      1,
    );
  });

  it("allocates ten bounded delivery slots across due tenants", async () => {
    repository.listDeliveryTenants.mockResolvedValue([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    worker.drainTenant.mockResolvedValue({
      delivered: 1,
      retried: 0,
      deadLettered: 0,
    });
    const response = await GET(authorizedRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tenants: 2,
      dueTenants: 2,
      deliverySlots: 10,
      delivered: 10,
      failedTenants: 0,
    });
    expect(worker.drainTenant).toHaveBeenCalledTimes(10);
    expect(worker.drainTenant).toHaveBeenNthCalledWith(
      1,
      "00000000-0000-4000-8000-000000000001",
      1,
    );
    expect(worker.drainTenant).toHaveBeenNthCalledWith(
      2,
      "00000000-0000-4000-8000-000000000001",
      1,
    );
    expect(worker.drainTenant).toHaveBeenNthCalledWith(
      6,
      "00000000-0000-4000-8000-000000000002",
      1,
    );
  });

  it("rotates the bounded tenant window on each scheduled minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    const tenantIds = Array.from(
      { length: 12 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    repository.listDeliveryTenants.mockResolvedValue(tenantIds);
    worker.drainTenant.mockResolvedValue({
      delivered: 1,
      retried: 0,
      deadLettered: 0,
    });

    await GET(authorizedRequest());
    const firstMinute = worker.drainTenant.mock.calls.map(([tenantId]) =>
      String(tenantId),
    );
    expect(repository.listDeliveryTenants).toHaveBeenCalledWith({
      now: new Date("2026-09-02T00:00:00Z"),
      limit: 100,
    });
    expect(firstMinute).toHaveLength(10);

    worker.drainTenant.mockClear();
    vi.setSystemTime(new Date("2026-09-02T00:01:00Z"));
    await GET(authorizedRequest());
    const secondMinute = worker.drainTenant.mock.calls.map(([tenantId]) =>
      String(tenantId),
    );
    expect(secondMinute).toHaveLength(10);
    expect(secondMinute).not.toEqual(firstMinute);
    expect(new Set([...firstMinute, ...secondMinute])).toEqual(
      new Set(tenantIds),
    );
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

  it("does not claim due work when webhook destinations are unavailable", async () => {
    environment.destinations = new Map();
    const response = await GET(authorizedRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      error: "webhook-destinations-unavailable",
    });
    expect(worker.drainTenant).not.toHaveBeenCalled();
  });

  it("allows an empty pass without webhook destination configuration", async () => {
    environment.destinations = new Map();
    repository.listDeliveryTenants.mockResolvedValue([]);
    const response = await GET(authorizedRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tenants: 0,
      dueTenants: 0,
      deliverySlots: 0,
    });
    expect(worker.drainTenant).not.toHaveBeenCalled();
  });
});
