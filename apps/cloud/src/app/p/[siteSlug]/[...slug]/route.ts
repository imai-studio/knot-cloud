import { createProductionPublicReaderHandlers } from "@/lib/http/public-reader";

export async function GET(
  request: Request,
  context: { params: Promise<{ siteSlug: string; slug: string[] }> },
) {
  const { siteSlug, slug } = await context.params;
  return createProductionPublicReaderHandlers().page(
    request,
    siteSlug,
    slug.join("/"),
  );
}
