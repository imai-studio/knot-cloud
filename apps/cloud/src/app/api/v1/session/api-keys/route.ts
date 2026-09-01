import { createSessionApiKeyHandlers } from "@/lib/http/session-api-keys";

export async function GET(request: Request): Promise<Response> {
  return createSessionApiKeyHandlers().list(request);
}

export async function POST(request: Request): Promise<Response> {
  return createSessionApiKeyHandlers().create(request);
}
