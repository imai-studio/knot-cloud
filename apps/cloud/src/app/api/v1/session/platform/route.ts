import { createProductionPlatformHandlers } from "@/lib/http/platform";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return createProductionPlatformHandlers().getPlatform(request);
}
