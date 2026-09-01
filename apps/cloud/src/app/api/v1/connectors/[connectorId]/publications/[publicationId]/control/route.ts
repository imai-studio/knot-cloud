import { createProductionConnectorPublicationHandlers } from "@/lib/http/connector-publications";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ connectorId: string; publicationId: string }>;
  },
) {
  const { connectorId, publicationId } = await context.params;
  return createProductionConnectorPublicationHandlers().control(
    request,
    connectorId,
    publicationId,
  );
}
