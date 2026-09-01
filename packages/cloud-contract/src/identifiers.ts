import { z } from "zod";

export const opaqueIdSchema = z.string().trim().min(1).max(200);
export const idempotencyKeySchema = z.string().trim().min(16).max(200);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const unixSecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(32_503_680_000);
