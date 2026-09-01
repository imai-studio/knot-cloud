import { z } from "zod";

import { protocolVersion } from "./protocol.js";

export const protocolVersionIdentifierSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)\.[0-9]+$/u);

export const supportedProtocolVersions = [protocolVersion] as const;

export const protocolCompatibilityCaseSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    clientSupportedVersions: z
      .array(protocolVersionIdentifierSchema)
      .min(1)
      .max(20)
      .refine(
        (values) => new Set(values).size === values.length,
        "Client protocol versions must be unique",
      ),
    expectedNegotiatedVersion: protocolVersionIdentifierSchema.nullable(),
  })
  .strict();

export function negotiateProtocolVersion(
  clientSupportedVersions: readonly string[],
): string | undefined {
  const parsed = z
    .array(protocolVersionIdentifierSchema)
    .min(1)
    .max(20)
    .parse(clientSupportedVersions);
  return supportedProtocolVersions.find((version) => parsed.includes(version));
}

export type ProtocolCompatibilityCase = z.infer<
  typeof protocolCompatibilityCaseSchema
>;
