import { createProductionPlatformHandlers } from "@/lib/http/platform";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ siteId: string; domainId: string }> },
) {
  const { siteId, domainId } = await context.params;
  return createProductionPlatformHandlers().verifyDomain(
    request,
    siteId,
    domainId,
  );
}
