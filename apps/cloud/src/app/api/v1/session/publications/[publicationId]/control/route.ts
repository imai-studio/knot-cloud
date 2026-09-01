import { createProductionHumanPublicationHandlers } from "@/lib/http/human-publications";

export async function POST(
  request: Request,
  context: { params: Promise<{ publicationId: string }> },
) {
  return createProductionHumanPublicationHandlers().control(
    request,
    (await context.params).publicationId,
  );
}
