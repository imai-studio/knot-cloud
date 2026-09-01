import { z } from "zod";

import { sha256Schema, unixSecondsSchema } from "./identifiers.js";

export const signatureScheme = "knot-cloud-ed25519-v1" as const;

export function normalizeAuthority(authority: string): string {
  const parsed = new URL(`https://${authority}`);
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("Invalid authority");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const port = parsed.port === "443" ? "" : parsed.port;
  return `${hostname}${port ? `:${port}` : ""}`;
}

export const signedRequestSchema = z.object({
  protocolVersion: z.string().min(1).max(20),
  connectorId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u),
  authority: z
    .string()
    .min(1)
    .max(259)
    .refine((value) => {
      try {
        return normalizeAuthority(value) === value;
      } catch {
        return false;
      }
    }, "Authority is not canonical"),
  method: z.string().regex(/^[A-Z]+$/u),
  path: z
    .string()
    .startsWith("/")
    .max(2_048)
    .refine(
      (value) =>
        !value.startsWith("//") &&
        !/(?:^|\/)\.{1,2}(?:\/|$)/u.test(value) &&
        !/%2f|%5c/iu.test(value),
      "Request target is not canonical",
    ),
  query: z
    .string()
    .max(2_048)
    .regex(/^(?:\?[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*)?$/u),
  timestamp: unixSecondsSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/u),
  bodySha256: sha256Schema,
});

export type SignedRequest = z.infer<typeof signedRequestSchema>;

export function canonicalSignedRequest(input: SignedRequest): string {
  const parsed = signedRequestSchema.parse(input);
  return [
    signatureScheme,
    parsed.protocolVersion,
    parsed.connectorId,
    parsed.authority,
    parsed.method,
    parsed.path,
    parsed.query,
    String(parsed.timestamp),
    parsed.nonce,
    parsed.bodySha256,
  ].join("\n");
}

export function encodeBase64Url(value: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...value));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("Invalid base64url value");
  }
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

export async function verifyEd25519Signature(input: {
  publicKey: Uint8Array;
  request: SignedRequest;
  signature: Uint8Array;
}): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(input.publicKey).buffer,
    { name: "Ed25519" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify(
    "Ed25519",
    publicKey,
    Uint8Array.from(input.signature).buffer,
    new TextEncoder().encode(canonicalSignedRequest(input.request)).buffer,
  );
}
