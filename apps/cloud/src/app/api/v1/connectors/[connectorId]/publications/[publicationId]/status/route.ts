import { createProductionConnectorPublicationHandlers } from "@/lib/http/connector-publications";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ connectorId: string; publicationId: string }>;
  },
) {
  const { connectorId, publicationId } = await context.params;
  return createProductionConnectorPublicationHandlers().status(
    request,
    connectorId,
    publicationId,
  );
}
