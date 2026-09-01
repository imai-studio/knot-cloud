import { dispatchProductionConnectorCommand } from "@/lib/http/connector-commands";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectorId: string }> },
): Promise<Response> {
  const { connectorId } = await context.params;
  return dispatchProductionConnectorCommand("claim", request, connectorId);
}
