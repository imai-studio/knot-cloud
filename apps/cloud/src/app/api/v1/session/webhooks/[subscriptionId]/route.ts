import { createSessionWebhookHandlers } from "@/lib/http/session-webhooks";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ subscriptionId: string }> },
): Promise<Response> {
  const { subscriptionId } = await context.params;
  return createSessionWebhookHandlers().disable(request, subscriptionId);
}
