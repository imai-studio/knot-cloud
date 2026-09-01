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
  request: Request;
  status: ProblemDetails["status"];
  code: ProblemDetails["code"];
  title: string;
  detail?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  serverUnixSeconds?: number;
}): Response {
  const body = problemDetailsSchema.parse({
    type: new URL(`/problems/${input.code}`, input.request.url).toString(),
    title: input.title,
    status: input.status,
    code: input.code,
    detail: input.detail,
    requestId: randomBytes(16).toString("base64url"),
    retryable: input.retryable ?? false,
    retryAfterSeconds: input.retryAfterSeconds,
    serverUnixSeconds: input.serverUnixSeconds,
  });
  return Response.json(body, {
    status: input.status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/problem+json",
    },
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
