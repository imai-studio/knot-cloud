import { createProductionHumanPublicationHandlers } from "@/lib/http/human-publications";

export async function GET(
  request: Request,
  context: { params: Promise<{ siteId: string }> },
) {
  return createProductionHumanPublicationHandlers().listPublications(
    request,
    (await context.params).siteId,
  );
}
