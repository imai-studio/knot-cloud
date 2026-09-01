import { createProductionPublicReaderHandlers } from "@/lib/http/public-reader";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ publicationSlug: string[] }> },
) {
  return createProductionPublicReaderHandlers().customPage(
    request,
    (await context.params).publicationSlug.join("/"),
  );
}
