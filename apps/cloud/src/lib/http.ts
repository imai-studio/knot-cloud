import {
  problemDetailsSchema,
  type ProblemDetails,
} from "@imai/knot-cloud-contract";

export function problemResponse(
  request: Request,
  input: {
    status: number;
    code: ProblemDetails["code"];
    title: string;
    retryable?: boolean;
    headers?: HeadersInit;
  },
) {
  const body = problemDetailsSchema.parse({
    type: new URL(`/problems/${input.code}`, request.url).toString(),
    title: input.title,
    status: input.status,
    code: input.code,
    requestId: crypto.randomUUID(),
    retryable: input.retryable ?? false,
  });
  return Response.json(body, {
    status: input.status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/problem+json",
      ...Object.fromEntries(new Headers(input.headers)),
    },
  });
}

export function noStoreJson(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function hasConflictingPairingPollCredential(request: Request) {
  for (const [name] of request.headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "authorization" ||
      normalized === "cookie" ||
      normalized === "x-api-key" ||
      normalized.startsWith("knot-")
    ) {
      return true;
    }
  }
  return false;
}
