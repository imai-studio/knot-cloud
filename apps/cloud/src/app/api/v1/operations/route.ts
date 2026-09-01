import { createProductionConsumerOperationHandlers } from "@/lib/http/consumer-operations";

export async function POST(request: Request): Promise<Response> {
  return createProductionConsumerOperationHandlers().submit(request);
}
