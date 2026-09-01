import { randomBytes } from "node:crypto";

import {
  problemDetailsSchema,
  type ProblemDetails,
} from "@imai/knot-cloud-contract";

export class HttpProblem extends Error {
  constructor(
    readonly status: ProblemDetails["status"],
    readonly code: ProblemDetails["code"],
    message: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HttpProblem";
  }
}

export function problemResponse(input: {
  problemBaseUrl?: string;
  request?: Request;
  status: ProblemDetails["status"];
  code: ProblemDetails["code"];
  title: string;
  detail?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  serverUnixSeconds?: number;
  logEvent?:
    "connector-command-internal-error" | "connector-provider-unavailable";
}): Response {
  const problemBaseUrl =
    input.problemBaseUrl ??
    (input.request ? new URL(input.request.url).origin : undefined);
  if (!problemBaseUrl) {
    throw new TypeError("problemResponse requires problemBaseUrl or request");
  }
  const requestId = randomBytes(16).toString("base64url");
  const body = problemDetailsSchema.parse({
    type: new URL(`/problems/${input.code}`, problemBaseUrl).toString(),
    title: input.title,
    status: input.status,
    code: input.code,
    // Internal loggable failures may carry provider diagnostics at the call
    // site. Keep those diagnostics out of both logs and model-facing bodies.
    detail: input.logEvent ? undefined : input.detail,
    requestId,
    retryable: input.retryable ?? false,
    retryAfterSeconds: input.retryAfterSeconds,
    serverUnixSeconds: input.serverUnixSeconds,
  });
  if (input.logEvent) {
    console.error(
      JSON.stringify({
        level: "error",
        event: input.logEvent,
        requestId,
        status: input.status,
        code: input.code,
      }),
    );
  }
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json",
  };
  if (
    input.retryAfterSeconds !== undefined &&
    (input.status === 429 || input.status === 503)
  ) {
    headers["Retry-After"] = String(input.retryAfterSeconds);
  }
  return Response.json(body, {
    status: input.status,
    headers,
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
