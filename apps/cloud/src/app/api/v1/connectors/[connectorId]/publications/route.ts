import { createProductionConnectorPublicationHandlers } from "@/lib/http/connector-publications";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectorId: string }> },
) {
  return createProductionConnectorPublicationHandlers().publish(
    request,
    (await context.params).connectorId,
  );
}
