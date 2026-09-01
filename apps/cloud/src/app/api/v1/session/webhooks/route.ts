import { createSessionWebhookHandlers } from "@/lib/http/session-webhooks";

export async function GET(request: Request): Promise<Response> {
  return createSessionWebhookHandlers().list(request);
}

export async function POST(request: Request): Promise<Response> {
  return createSessionWebhookHandlers().create(request);
}
