import { createProductionConnectorPublicationHandlers } from "@/lib/http/connector-publications";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectorId: string }> },
) {
  return createProductionConnectorPublicationHandlers().commitAsset(
    request,
    (await context.params).connectorId,
  );
}
