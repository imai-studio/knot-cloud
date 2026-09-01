import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const apiKeyPattern = /^knot_live_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/u;

export interface ApiKeyPepper {
  version: number;
  value: string;
}

function digestApiKey(secretPart: string, pepper: string): Buffer {
  return createHmac("sha256", pepper).update(secretPart, "utf8").digest();
}

export function createApiKey(pepper: ApiKeyPepper): {
  secret: string;
  keyId: string;
  digest: string;
  digestVersion: number;
} {
  if (
    !Number.isInteger(pepper.version) ||
    pepper.version < 1 ||
    pepper.value.length < 32
  )
    throw new TypeError(
      "API key pepper requires a positive version and at least 32 characters",
    );

  const keyId = randomBytes(12).toString("base64url");
  const secretPart = randomBytes(32).toString("base64url");
  const secret = `knot_live_${keyId}_${secretPart}`;
  return {
    secret,
    keyId,
    digest: digestApiKey(secretPart, pepper.value).toString("hex"),
    digestVersion: pepper.version,
  };
}

export function verifyApiKey(input: {
  secret: string;
  expectedKeyId: string;
  expectedDigest: string;
  digestVersion: number;
  peppers: readonly ApiKeyPepper[];
}):
  | { valid: false }
  | { valid: true; needsRehash: boolean; replacementDigest?: string } {
  const parsed = apiKeyPattern.exec(input.secret);
  const pepper = input.peppers.find(
    (candidate) => candidate.version === input.digestVersion,
  );
  if (
    !parsed?.[2] ||
    parsed[1] !== input.expectedKeyId ||
    !/^[a-f0-9]{64}$/u.test(input.expectedDigest) ||
    !pepper ||
    pepper.value.length < 32
  )
    return { valid: false };
  const actual = digestApiKey(parsed[2], pepper.value);
  const expected = Buffer.from(input.expectedDigest, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { valid: false };
  }

  const current = input.peppers.reduce((latest, candidate) =>
    candidate.version > latest.version ? candidate : latest,
  );
  const needsRehash = current.version !== input.digestVersion;
  return {
    valid: true,
    needsRehash,
    replacementDigest: needsRehash
      ? digestApiKey(parsed[2], current.value).toString("hex")
      : undefined,
  };
}

export function extractApiKeyId(secret: string): string | undefined {
  return apiKeyPattern.exec(secret)?.[1];
}
