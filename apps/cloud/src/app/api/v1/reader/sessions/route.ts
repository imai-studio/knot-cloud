import { createProductionReaderSessionHandler } from "@/lib/http/reader-sessions";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return createProductionReaderSessionHandler()(request);
}
