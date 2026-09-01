import { createProductionPublicReaderHandlers } from "@/lib/http/public-reader";

export async function GET(
  request: Request,
  context: {
    params: Promise<{
      siteSlug: string;
      publicationId: string;
      sha256: string;
    }>;
  },
) {
  const { siteSlug, publicationId, sha256 } = await context.params;
  return createProductionPublicReaderHandlers().media(
    request,
    siteSlug,
    publicationId,
    sha256,
  );
}
