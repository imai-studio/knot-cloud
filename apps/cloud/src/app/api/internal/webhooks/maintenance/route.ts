import { timingSafeEqual } from "node:crypto";

import { protocolVersion } from "@imai/knot-cloud-contract";

import { NeonTransactionalEventRepository } from "@/lib/adapters/neon-transactional-events";
import { getCloudEnvironment, getWebhookDestinations } from "@/lib/env";
import { WebhookDeliveryWorker } from "@/lib/webhook-delivery";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const maximumTenantScan = 100;
const maximumConcurrentDeliveries = 10;

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request): Promise<Response> {
  if (!authorized(request))
    return Response.json(
      { protocolVersion, error: "authentication-required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  try {
    const repository = new NeonTransactionalEventRepository();
    const now = new Date();
    const dueTenantIds = await repository.listDeliveryTenants({
      now,
      limit: maximumTenantScan,
    });
    const destinations = getWebhookDestinations();
    if (dueTenantIds.length > 0 && destinations.size === 0)
      return Response.json(
        { protocolVersion, error: "webhook-destinations-unavailable" },
        {
          status: 503,
          headers: { "Cache-Control": "no-store", "Retry-After": "60" },
        },
      );
    const worker = new WebhookDeliveryWorker(repository, destinations);
    const tenantIds = selectTenantWindow(dueTenantIds, now);
    const allocations = allocateDeliverySlots(tenantIds);
    const totals = {
      tenants: tenantIds.length,
      dueTenants: dueTenantIds.length,
      tenantScanLimit: maximumTenantScan,
      scanTruncated: dueTenantIds.length === maximumTenantScan,
      deliverySlots: allocations.reduce(
        (total, allocation) => total + allocation.slots,
        0,
      ),
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      failedTenants: 0,
    };
    const results = await Promise.all(
      allocations.map(async ({ tenantId, slots }) =>
        Promise.all(
          Array.from({ length: slots }, async () => {
            try {
              // Each delivery has a ten-second fetch timeout. A bounded set of
              // single-delivery drains runs concurrently inside the 30-second
              // function budget.
              return await worker.drainTenant(tenantId, 1);
            } catch {
              return null;
            }
          }),
        ),
      ),
    );
    for (const tenantResults of results) {
      if (tenantResults.some((result) => result === null))
        totals.failedTenants += 1;
      for (const result of tenantResults) {
        if (result) {
          totals.delivered += result.delivered;
          totals.retried += result.retried;
          totals.deadLettered += result.deadLettered;
        }
      }
    }
    return Response.json(
      { protocolVersion, ...totals },
      {
        status: totals.failedTenants > 0 ? 500 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return Response.json(
      { protocolVersion, error: "maintenance-unavailable" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      },
    );
  }
}

function allocateDeliverySlots(
  tenantIds: readonly string[],
): Array<{ tenantId: string; slots: number }> {
  if (tenantIds.length === 0) return [];
  const base = Math.floor(maximumConcurrentDeliveries / tenantIds.length);
  const remainder = maximumConcurrentDeliveries % tenantIds.length;
  return tenantIds.map((tenantId, index) => ({
    tenantId,
    slots: base + (index < remainder ? 1 : 0),
  }));
}

function selectTenantWindow(tenantIds: readonly string[], now: Date): string[] {
  if (tenantIds.length <= 10) return [...tenantIds];
  const offset = (Math.floor(now.getTime() / 60_000) * 10) % tenantIds.length;
  return [...tenantIds.slice(offset), ...tenantIds.slice(0, offset)].slice(
    0,
    10,
  );
}

function authorized(request: Request): boolean {
  const expected = Buffer.from(getCloudEnvironment().CRON_SECRET, "utf8");
  const header = request.headers.get("Authorization") ?? "";
  const supplied = Buffer.from(
    header.startsWith("Bearer ") ? header.slice(7) : "",
    "utf8",
  );
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
