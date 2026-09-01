import { createHmac } from "node:crypto";

import { getApiKeyPeppers, getCloudEnvironment } from "@/lib/env";
import {
  ConsumerDataError,
  type ConsumerDataRepository,
  type ResolvedConsumerApiKey,
} from "@/lib/consumer-data";

import { extractApiKeyId, verifyApiKey } from "./api-key";
import type { ApiKeyPepper } from "./api-key";

export async function authenticateConsumerApiKey(input: {
  authorization: string | null;
  repository: ConsumerDataRepository;
  now?: Date;
  peppers?: readonly ApiKeyPepper[];
}): Promise<ResolvedConsumerApiKey> {
  const match = /^Bearer ([^\s]+)$/u.exec(input.authorization ?? "");
  const secret = match?.[1];
  const keyId = secret ? extractApiKeyId(secret) : undefined;
  if (!secret || !keyId) {
    throw new ConsumerDataError(
      "authentication-required",
      "A consumer API key is required",
    );
  }
  const record = await input.repository.resolveApiKey(keyId);
  if (!record) {
    throw new ConsumerDataError(
      "authentication-required",
      "The consumer API key is invalid",
    );
  }
  const peppers = input.peppers ?? getApiKeyPeppers();
  const verified = verifyApiKey({
    secret,
    expectedKeyId: record.keyId,
    expectedDigest: record.keyDigest,
    digestVersion: record.digestVersion,
    peppers,
  });
  const now = input.now ?? new Date();
  if (
    !verified.valid ||
    record.revokedAt !== null ||
    (record.expiresAt !== null && record.expiresAt <= now)
  ) {
    throw new ConsumerDataError(
      "authentication-required",
      "The consumer API key is invalid",
    );
  }
  if (verified.needsRehash && verified.replacementDigest) {
    const current = peppers.reduce((latest, candidate) =>
      candidate.version > latest.version ? candidate : latest,
    );
    await input.repository.rehashApiKey({
      tenantId: record.tenantId,
      apiKeyId: record.id,
      expectedDigestVersion: record.digestVersion,
      digest: verified.replacementDigest,
      digestVersion: current.version,
    });
  }
  return record;
}

export function digestConsumerActor(keyId: string): {
  digest: string;
  version: number;
} {
  const environment = getCloudEnvironment();
  return {
    digest: createHmac("sha256", environment.IDENTITY_DIGEST_PEPPER)
      .update(`consumer-api-key:${keyId}`, "utf8")
      .digest("hex"),
    version: environment.IDENTITY_DIGEST_VERSION,
  };
}
