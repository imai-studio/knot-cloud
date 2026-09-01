import { timingSafeEqual } from "node:crypto";

import { protocolVersion } from "@imai/knot-cloud-contract";

import { NeonDeletionOutboxRepository } from "@/lib/adapters/neon-publications";
import { createObjectStore } from "@/lib/adapters/factory";
import { getCloudEnvironment } from "@/lib/env";
import { PublicationDeletionWorker } from "@/lib/publications";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const graceSeconds = 24 * 60 * 60;
const tenantLimit = 10;
const objectLimit = 50;

export async function GET(request: Request) {
  return runMaintenance(request);
}

export async function POST(request: Request) {
  return runMaintenance(request);
}

async function runMaintenance(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json(
      { protocolVersion, error: "authentication-required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const repository = new NeonDeletionOutboxRepository();
    const worker = new PublicationDeletionWorker(
      repository,
      createObjectStore(),
    );
    const now = new Date();
    const tenantIds = await repository.listMaintenanceTenants({
      now,
      graceSeconds,
      limit: tenantLimit,
    });
    const totals = {
      tenants: tenantIds.length,
      swept: 0,
      claimed: 0,
      deleted: 0,
      retried: 0,
      finalized: 0,
      deadLettered: 0,
      failedTenants: 0,
    };
    for (const tenantId of tenantIds) {
      try {
        totals.swept += await repository.sweepOrphans({
          tenantId,
          now,
          graceSeconds,
          limit: objectLimit,
        });
        const result = await worker.drainTenant({
          tenantId,
          limit: objectLimit,
        });
        totals.claimed += result.claimed;
        totals.deleted += result.deleted;
        totals.retried += result.retried;
        totals.finalized += result.finalized;
        totals.deadLettered += result.deadLettered;
      } catch {
        totals.failedTenants += 1;
      }
    }
    return Response.json(
      { protocolVersion, ...totals },
      {
        status: totals.failedTenants > 0 || totals.deadLettered > 0 ? 500 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return Response.json(
      { protocolVersion, error: "maintenance-unavailable" },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "60",
        },
      },
    );
  }
}

function authorized(request: Request): boolean {
  const expected = Buffer.from(getCloudEnvironment().CRON_SECRET, "utf8");
  const suppliedHeader = request.headers.get("Authorization") ?? "";
  const supplied = Buffer.from(
    suppliedHeader.startsWith("Bearer ") ? suppliedHeader.slice(7) : "",
    "utf8",
  );
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
