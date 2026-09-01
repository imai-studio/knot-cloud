import { createSessionApiKeyHandlers } from "@/lib/http/session-api-keys";

export async function GET(
  request: Request,
  context: { params: Promise<{ apiKeyId: string }> },
): Promise<Response> {
  const { apiKeyId } = await context.params;
  return createSessionApiKeyHandlers().inspect(request, apiKeyId);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ apiKeyId: string }> },
): Promise<Response> {
  const { apiKeyId } = await context.params;
  return createSessionApiKeyHandlers().revoke(request, apiKeyId);
}
