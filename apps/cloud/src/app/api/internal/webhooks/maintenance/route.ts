import { timingSafeEqual } from "node:crypto";

import { protocolVersion } from "@imai/knot-cloud-contract";

import { NeonTransactionalEventRepository } from "@/lib/adapters/neon-transactional-events";
import { getCloudEnvironment, getWebhookDestinations } from "@/lib/env";
import { WebhookDeliveryWorker } from "@/lib/webhook-delivery";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

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
    const worker = new WebhookDeliveryWorker(
      repository,
      getWebhookDestinations(),
    );
    const tenantIds = await repository.listDeliveryTenants({
      now: new Date(),
      limit: 10,
    });
    const totals = {
      tenants: tenantIds.length,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      failedTenants: 0,
    };
    for (const tenantId of tenantIds) {
      try {
        const result = await worker.drainTenant(tenantId, 20);
        totals.delivered += result.delivered;
        totals.retried += result.retried;
        totals.deadLettered += result.deadLettered;
      } catch {
        totals.failedTenants += 1;
      }
    }
    return Response.json(
      { protocolVersion, ...totals },
      {
        status: totals.failedTenants || totals.deadLettered ? 500 : 200,
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
