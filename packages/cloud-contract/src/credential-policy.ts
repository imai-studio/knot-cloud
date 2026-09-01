import { z } from "zod";

import { principalKindSchema, type PrincipalKind } from "./protocol.js";

export const endpointCredentialClassSchema = z.enum([
  "human-administration",
  "connector-protocol",
  "consumer-data-api",
  "first-party-internal",
]);

export type EndpointCredentialClass = z.infer<
  typeof endpointCredentialClassSchema
>;

export const endpointPrincipalPolicy = {
  "human-administration": "human-session",
  "connector-protocol": "connector-key",
  "consumer-data-api": "consumer-api-key",
  "first-party-internal": "first-party-service",
} as const satisfies Record<EndpointCredentialClass, PrincipalKind>;

export function isPrincipalAllowedForEndpoint(
  endpointClass: EndpointCredentialClass,
  principal: PrincipalKind,
): boolean {
  endpointCredentialClassSchema.parse(endpointClass);
  principalKindSchema.parse(principal);
  return endpointPrincipalPolicy[endpointClass] === principal;
}
