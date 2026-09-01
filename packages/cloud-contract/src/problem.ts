import { z } from "zod";

export const problemCodeSchema = z.enum([
  "invalid-request",
  "authentication-required",
  "forbidden",
  "not-found",
  "conflict",
  "rate-limited",
  "protocol-unsupported",
  "clock-skew",
  "replay-detected",
  "scope-denied",
  "quota-exceeded",
  "connector-denied",
  "duplicate-subscription",
  "subscription-name-conflict",
  "subscription-limit-exceeded",
  "local-policy-rejected",
  "connector-offline",
  "lease-lost",
  "digest-mismatch",
  "payload-too-large",
  "dependency-unavailable",
  "internal-error",
]);

export const problemDetailsSchema = z
  .object({
    type: z.url(),
    title: z.string().trim().min(1).max(200),
    status: z.number().int().min(400).max(599),
    code: problemCodeSchema,
    detail: z.string().max(2_000).optional(),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/u),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
    serverUnixSeconds: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.retryAfterSeconds !== undefined && !value.retryable) {
      context.addIssue({
        code: "custom",
        message: "retryAfterSeconds requires retryable to be true",
      });
    }
    if (value.code === "clock-skew" && value.serverUnixSeconds === undefined) {
      context.addIssue({
        code: "custom",
        message: "clock-skew responses must include server time",
      });
    }
  });

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
