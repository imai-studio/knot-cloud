import { describe, expect, it, vi } from "vitest";

import { digestConsumerActor } from "./consumer-api-key";

vi.mock("@/lib/env", () => ({
  getCloudEnvironment: () => ({
    IDENTITY_DIGEST_PEPPER: "p".repeat(32),
    IDENTITY_DIGEST_VERSION: 7,
  }),
}));

describe("consumer actor digest", () => {
  it("binds provenance to the immutable credential id", () => {
    const credentialId = "00000000-0000-4000-8000-000000000002";
    expect(digestConsumerActor(credentialId)).toEqual(
      digestConsumerActor(credentialId),
    );
    expect(digestConsumerActor(credentialId)).not.toEqual(
      digestConsumerActor("rotated-display-key-id"),
    );
    expect(digestConsumerActor(credentialId).version).toBe(7);
  });
});
