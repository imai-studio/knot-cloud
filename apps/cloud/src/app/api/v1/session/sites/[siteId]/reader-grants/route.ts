import { createProductionPlatformHandlers } from "@/lib/http/platform";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ siteId: string }> },
) {
  return createProductionPlatformHandlers().listReaderGrants(
    request,
    (await context.params).siteId,
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ siteId: string }> },
) {
  return createProductionPlatformHandlers().createReaderGrant(
    request,
    (await context.params).siteId,
  );
}
