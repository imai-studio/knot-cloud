import { createProductionConsumerOperationHandlers } from "@/lib/http/consumer-operations";

export async function GET(
  request: Request,
  context: { params: Promise<{ operationId: string }> },
): Promise<Response> {
  const { operationId } = await context.params;
  return createProductionConsumerOperationHandlers().status(
    request,
    operationId,
  );
}
