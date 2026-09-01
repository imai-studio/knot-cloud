import { beforeEach, describe, expect, it, vi } from "vitest";

import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import {
  TransactionalEventError,
  type TransactionalEventRepository,
} from "@/lib/transactional-events";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { createSessionWebhookHandlers } from "./session-webhooks";

vi.mock("@/lib/auth", () => ({
  isTrustedHumanMutationOrigin: vi.fn(() => true),
}));
vi.mock("@/lib/workspace-auth", () => ({
  getAuthorizedWorkspace: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  getAppBaseUrl: () => "https://knot.test",
  getWebhookDestinations: () => new Map(),
  getWebhookMaxActiveSubscriptions: () => 50,
}));

const tenantId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const connectorId = "00000000-0000-4000-8000-000000000003";

function repository(
  createSubscription: TransactionalEventRepository["createSubscription"],
): TransactionalEventRepository {
  return {
    listSubscriptions: vi.fn(async () => []),
    createSubscription,
    disableSubscription: vi.fn(async () => true),
    enqueue: vi.fn(),
    listDeliveryTenants: vi.fn(async () => []),
    claim: vi.fn(),
    complete: vi.fn(),
  };
}

function createRequest() {
  return new Request("https://knot.test/api/v1/session/webhooks", {
    method: "POST",
    headers: {
      Origin: "https://knot.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Automation",
      destinationName: "automation",
      eventTypes: ["channel.message.available"],
      connectorIds: [connectorId],
    }),
  });
}

describe("human webhook controls", () => {
  beforeEach(() => {
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue({
      identity: {
        session: { id: "session" },
        user: { id: "auth-user", email: "raj@example.test", name: "Raj" },
      },
      workspace: {
        tenantId,
        userId,
        name: "Personal workspace",
        role: "owner",
        suspended: false,
      },
    });
    vi.mocked(isTrustedHumanMutationOrigin).mockReturnValue(true);
  });

  it("passes the deployment cap into transactional subscription creation", async () => {
    const createSubscription = vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000004",
      name: "Automation",
      destinationName: "automation",
      eventTypes: ["channel.message.available" as const],
      connectorIds: [connectorId],
      active: true,
      createdAt: 1_788_192_000,
    }));
    const response = await createSessionWebhookHandlers(
      repository(createSubscription),
      new Set(["automation"]),
      7,
    ).create(createRequest());
    expect(response.status).toBe(201);
    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ activeLimit: 7 }),
    );
  });

  it.each([
    ["duplicate-subscription", 409],
    ["subscription-name-conflict", 409],
    ["subscription-limit-exceeded", 403],
    ["connector-denied", 403],
  ] as const)(
    "maps %s without conflating it with another denial",
    async (code, status) => {
      const response = await createSessionWebhookHandlers(
        repository(
          vi.fn(async () => {
            throw new TransactionalEventError(code, `Rejected: ${code}`);
          }),
        ),
        new Set(["automation"]),
        7,
      ).create(createRequest());
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ code });
    },
  );
});
