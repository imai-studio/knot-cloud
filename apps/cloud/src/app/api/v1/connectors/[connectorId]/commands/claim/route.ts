import { createProductionConnectorCommandHandlers } from "@/lib/http/connector-commands";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectorId: string }> },
): Promise<Response> {
  const { connectorId } = await context.params;
  return createProductionConnectorCommandHandlers().claim(request, connectorId);
}
