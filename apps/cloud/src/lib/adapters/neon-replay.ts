import type { ReplayNonceStore } from "@/lib/ports";

import { withTenant } from "./neon";

export class NeonReplayNonceStore implements ReplayNonceStore {
  async claim(input: {
    tenantId: string;
    connectorId: string;
    nonce: string;
    expiresAt: number;
  }): Promise<"claimed" | "replayed"> {
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
      throw new TypeError("expiresAt must be a positive Unix timestamp");
    }
    const [rows = []] = await withTenant(input.tenantId, (transaction) => [
      transaction`
        SELECT claim_connector_request_nonce(
          ${input.tenantId}::uuid,
          ${input.connectorId}::uuid,
          ${input.nonce},
          to_timestamp(${input.expiresAt})
        ) AS claimed
      `,
    ]);
    return Boolean((rows[0] as { claimed?: boolean } | undefined)?.claimed)
      ? "claimed"
      : "replayed";
  }
}
