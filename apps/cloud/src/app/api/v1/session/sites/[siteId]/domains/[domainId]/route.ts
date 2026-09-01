import { createProductionPlatformHandlers } from "@/lib/http/platform";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ siteId: string; domainId: string }> },
) {
  const { siteId, domainId } = await context.params;
  return createProductionPlatformHandlers().disableDomain(
    request,
    siteId,
    domainId,
  );
}
