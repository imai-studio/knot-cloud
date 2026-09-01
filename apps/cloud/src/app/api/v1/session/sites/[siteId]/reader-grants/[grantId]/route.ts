import { createProductionPlatformHandlers } from "@/lib/http/platform";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ siteId: string; grantId: string }> },
) {
  const { siteId, grantId } = await context.params;
  return createProductionPlatformHandlers().revokeReaderGrant(
    request,
    siteId,
    grantId,
  );
}
