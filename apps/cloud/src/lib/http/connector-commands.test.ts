import {
  commandClaimResponseSchema,
  commandResultReceiptSchema,
  problemDetailsSchema,
} from "@imai/knot-cloud-contract";
import { describe, expect, it, vi } from "vitest";

import type { CommandLedger } from "@/lib/ports";

import { createConnectorCommandHandlers } from "./connector-commands";

const connectorId = "00000000-0000-4000-8000-000000000011";
const tenantId = "00000000-0000-4000-8000-000000000001";
const commandId = "00000000-0000-4000-8000-000000000051";

function request(path: string, body: unknown): Request {
  return new Request(`https://knot.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function commands(overrides: Partial<CommandLedger> = {}): CommandLedger {
  return {
    claim: () => Promise.resolve(undefined),
    extend: () => Promise.resolve(undefined),
    complete: () => Promise.resolve({ status: "accepted", state: "succeeded" }),
    ...overrides,
  };
}

function handlers(commandLedger: CommandLedger) {
  return createConnectorCommandHandlers({
    commands: commandLedger,
    connectors: { findActiveConnector: () => Promise.resolve(undefined) },
    nonces: { claim: () => Promise.resolve("claimed") },
    allowedAuthorities: ["knot.test"],
    authenticate: () =>
      Promise.resolve({
        connectorId,
        tenantId,
        scopes: ["anytype.objects.read"],
      }),
    now: () => new Date("2026-09-01T00:00:00Z"),
  });
}

describe("connector command HTTP service", () => {
  it("claims only work covered by the connector's scopes", async () => {
    const claim = vi
      .fn<CommandLedger["claim"]>()
      .mockResolvedValueOnce({
        commandId,
        requiredScope: "anytype.objects.read",
        payload: {
          domain: "anytype",
          operation: {
            type: "object.read",
            spaceId: "space-1",
            objectId: "object-1",
          },
        },
        createdByKind: "consumer-api-key",
        createdAt: new Date("2026-09-01T00:00:00Z"),
        notBefore: new Date("2026-09-01T00:00:00Z"),
        expiresAt: new Date("2026-09-01T00:10:00Z"),
        attempt: 1,
        leaseToken: "lease_token_1234567890abcdefghijklmnop",
        leaseExpiresAt: new Date("2026-09-01T00:01:00Z"),
      })
      .mockResolvedValueOnce(undefined);
    const response = await handlers(commands({ claim })).claim(
      request(`/api/v1/connectors/${connectorId}/commands/claim`, {
        protocolVersion: "1.0",
        maximumCommands: 2,
        leaseSeconds: 60,
      }),
      connectorId,
    );

    expect(response.status).toBe(200);
    const body = commandClaimResponseSchema.parse(await response.json());
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]?.commandId).toBe(commandId);
    expect(claim).toHaveBeenCalledWith({
      tenantId,
      connectorId,
      allowedScopes: ["anytype.objects.read"],
      leaseSeconds: 60,
    });
  });

  it("rejects a signed connector that does not match the route", async () => {
    const claim = vi.fn<CommandLedger["claim"]>();
    const response = await handlers(commands({ claim })).claim(
      request("/api/v1/connectors/another/commands/claim", {
        protocolVersion: "1.0",
        maximumCommands: 1,
        leaseSeconds: 60,
      }),
      "another",
    );

    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(await response.json()).code).toBe(
      "forbidden",
    );
    expect(claim).not.toHaveBeenCalled();
  });

  it("returns lease-lost when an extension is stale", async () => {
    const response = await handlers(commands()).extend(
      request(`/api/v1/connectors/${connectorId}/commands/extend`, {
        protocolVersion: "1.0",
        commandId,
        attempt: 2,
        leaseToken: "lease_token_1234567890abcdefghijklmnop",
        extendBySeconds: 60,
      }),
      connectorId,
    );

    expect(response.status).toBe(409);
    expect(problemDetailsSchema.parse(await response.json()).code).toBe(
      "lease-lost",
    );
  });

  it("acknowledges an idempotent duplicate result", async () => {
    const complete = vi.fn<CommandLedger["complete"]>().mockResolvedValue({
      status: "duplicate",
      state: "succeeded",
    });
    const response = await handlers(commands({ complete })).complete(
      request(`/api/v1/connectors/${connectorId}/commands/result`, {
        protocolVersion: "1.0",
        commandId,
        attempt: 2,
        leaseToken: "lease_token_1234567890abcdefghijklmnop",
        result: {
          outcome: "rejected-by-local-policy",
          reasonCode: "operator-approval-required",
        },
      }),
      connectorId,
    );

    expect(response.status).toBe(200);
    expect(commandResultReceiptSchema.parse(await response.json())).toEqual({
      protocolVersion: "1.0",
      commandId,
      attempt: 2,
      status: "duplicate",
      state: "succeeded",
    });
  });

  it("rejects an oversized body before authentication", async () => {
    let authenticated = false;
    const service = createConnectorCommandHandlers({
      commands: commands(),
      connectors: { findActiveConnector: () => Promise.resolve(undefined) },
      nonces: { claim: () => Promise.resolve("claimed") },
      allowedAuthorities: ["knot.test"],
      authenticate: () => {
        authenticated = true;
        return Promise.resolve({ connectorId, tenantId, scopes: [] });
      },
    });
    const response = await service.claim(
      new Request(
        `https://knot.test/api/v1/connectors/${connectorId}/commands/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(65 * 1024),
          },
          body: "{}",
        },
      ),
      connectorId,
    );

    expect(response.status).toBe(413);
    expect(problemDetailsSchema.parse(await response.json()).code).toBe(
      "payload-too-large",
    );
    expect(authenticated).toBe(false);
  });
});
