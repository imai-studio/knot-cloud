import { createProductionHumanPublicationHandlers } from "@/lib/http/human-publications";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return createProductionHumanPublicationHandlers().listSites(request);
}

export function POST(request: Request) {
  return createProductionHumanPublicationHandlers().createSite(request);
}
