import { createSessionApiKeyHandlers } from "@/lib/http/session-api-keys";

export async function POST(
  request: Request,
  context: { params: Promise<{ apiKeyId: string }> },
): Promise<Response> {
  const { apiKeyId } = await context.params;
  return createSessionApiKeyHandlers().rotate(request, apiKeyId);
}
