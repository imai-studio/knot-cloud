import { createProductionHumanPublicationHandlers } from "@/lib/http/human-publications";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ publicationId: string }> },
) {
  return createProductionHumanPublicationHandlers().listPublicationVersions(
    request,
    (await context.params).publicationId,
  );
}
