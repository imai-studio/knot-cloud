import { createSessionAuditHandler } from "@/lib/http/session-audit";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return createSessionAuditHandler()(request);
}
