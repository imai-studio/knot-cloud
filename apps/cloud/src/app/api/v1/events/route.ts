import { createTransactionalEventHandler } from "@/lib/http/transactional-events";

export async function POST(request: Request): Promise<Response> {
  return createTransactionalEventHandler()(request);
}
