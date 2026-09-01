import { createProductionPlatformHandlers } from "@/lib/http/platform";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ siteId: string }> },
) {
  return createProductionPlatformHandlers().getSiteAccess(
    request,
    (await context.params).siteId,
  );
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ siteId: string }> },
) {
  return createProductionPlatformHandlers().updateSiteAccess(
    request,
    (await context.params).siteId,
  );
}
