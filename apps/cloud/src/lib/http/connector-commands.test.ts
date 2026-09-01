import {
  commandClaimResponseSchema,
  commandResultReceiptSchema,
  problemDetailsSchema,
} from "@imai/knot-cloud-contract";
import { describe, expect, it, vi } from "vitest";

import type { CommandLedger } from "@/lib/ports";

import {
  createConnectorCommandHandlers,
  createProductionConnectorCommandDispatcher,
} from "./connector-commands";
import { ConnectorAuthenticationError } from "../security/connector-auth";

const connectorId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
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
    problemBaseUrl: "https://trusted.knot.test",
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
        actorDigest: "a".repeat(64),
        actorDigestVersion: 1,
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
        maximumCommands: 1,
        leaseSeconds: 60,
      }),
      connectorId,
    );

    expect(response.status).toBe(200);
    const body = commandClaimResponseSchema.parse(await response.json());
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]?.commandId).toBe(commandId);
    expect(body.commands[0]?.actor).toEqual({
      principalDigest: "a".repeat(64),
      digestVersion: 1,
      provenance: "consumer-api-key",
    });
    expect(claim).toHaveBeenCalledWith({
      tenantId,
      connectorId,
      allowedScopes: ["anytype.objects.read"],
      leaseSeconds: 60,
    });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("rejects claims that ask for more than one command", async () => {
    const claim = vi.fn<CommandLedger["claim"]>();
    const response = await handlers(commands({ claim })).claim(
      request(`/api/v1/connectors/${connectorId}/commands/claim`, {
        protocolVersion: "1.0",
        maximumCommands: 2,
        leaseSeconds: 60,
      }),
      connectorId,
    );

    expect(response.status).toBe(400);
    expect(problemDetailsSchema.parse(await response.json()).code).toBe(
      "invalid-request",
    );
    expect(claim).not.toHaveBeenCalled();
  });

  it("fails a malformed claimed command without stranding its lease", async () => {
    const complete = vi
      .fn<CommandLedger["complete"]>()
      .mockResolvedValue({ status: "accepted", state: "failed" });
    const claim = vi.fn<CommandLedger["claim"]>().mockResolvedValue({
      commandId,
      requiredScope: "anytype.objects.read",
      payload: { domain: "anytype", operation: { type: "not-real" } },
      createdByKind: "consumer-api-key",
      actorDigest: "a".repeat(64),
      actorDigestVersion: 1,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      notBefore: new Date("2026-09-01T00:00:00Z"),
      expiresAt: new Date("2026-09-01T00:10:00Z"),
      attempt: 1,
      leaseToken: "lease_token_1234567890abcdefghijklmnop",
      leaseExpiresAt: new Date("2026-09-01T00:01:00Z"),
    });
    const response = await handlers(commands({ claim, complete })).claim(
      request(`/api/v1/connectors/${connectorId}/commands/claim`, {
        protocolVersion: "1.0",
        maximumCommands: 1,
        leaseSeconds: 60,
      }),
      connectorId,
    );

    expect(response.status).toBe(200);
    expect(
      commandClaimResponseSchema.parse(await response.json()).commands,
    ).toEqual([]);
    expect(complete).toHaveBeenCalledWith({
      tenantId,
      connectorId,
      commandId,
      attempt: 1,
      leaseToken: "lease_token_1234567890abcdefghijklmnop",
      completion: {
        outcome: "failed",
        retryable: false,
        errorCode: "invalid-command-envelope",
      },
    });
  });

  it("rejects a signed connector that does not match the route", async () => {
    const claim = vi.fn<CommandLedger["claim"]>();
    const otherConnectorId = "00000000-0000-4000-8000-000000000012";
    const response = await handlers(commands({ claim })).claim(
      request(`/api/v1/connectors/${otherConnectorId}/commands/claim`, {
        protocolVersion: "1.0",
        maximumCommands: 1,
        leaseSeconds: 60,
      }),
      otherConnectorId,
    );

    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(await response.json()).code).toBe(
      "forbidden",
    );
    expect(claim).not.toHaveBeenCalled();
  });

  it("canonicalizes an uppercase UUID connector path before fencing", async () => {
    const claim = vi.fn<CommandLedger["claim"]>().mockResolvedValue(undefined);
    const uppercaseConnectorId = connectorId.toUpperCase();
    const response = await handlers(commands({ claim })).claim(
      request(`/api/v1/connectors/${uppercaseConnectorId}/commands/claim`, {
        protocolVersion: "1.0",
        maximumCommands: 1,
        leaseSeconds: 60,
      }),
      uppercaseConnectorId,
    );

    expect(response.status).toBe(200);
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId }),
    );
  });

  it("returns server time when connector authentication rejects clock skew", async () => {
    const service = createConnectorCommandHandlers({
      commands: commands(),
      connectors: { findActiveConnector: () => Promise.resolve(undefined) },
      nonces: { claim: () => Promise.resolve("claimed") },
      allowedAuthorities: ["knot.test"],
      problemBaseUrl: "https://trusted.knot.test",
      authenticate: () =>
        Promise.reject(new ConnectorAuthenticationError("clock-skew", 401)),
      now: () => new Date("2026-09-01T00:00:00Z"),
    });
    const response = await service.claim(
      request(`/api/v1/connectors/${connectorId}/commands/claim`, {
        protocolVersion: "1.0",
        maximumCommands: 1,
        leaseSeconds: 60,
      }),
      connectorId,
    );

    expect(response.status).toBe(401);
    expect(problemDetailsSchema.parse(await response.json())).toMatchObject({
      type: "https://trusted.knot.test/problems/clock-skew",
      code: "clock-skew",
      retryable: false,
      serverUnixSeconds: 1_788_220_800,
    });
  });

  it("returns retry metadata when connector authentication is rate limited", async () => {
    const service = createConnectorCommandHandlers({
      commands: commands(),
      connectors: { findActiveConnector: () => Promise.resolve(undefined) },
      nonces: { claim: () => Promise.resolve("claimed") },
      allowedAuthorities: ["knot.test"],
      problemBaseUrl: "https://trusted.knot.test",
      authenticate: () =>
        Promise.reject(new ConnectorAuthenticationError("rate-limited", 429)),
    });
    const response = await service.claim(
      request(`/api/v1/connectors/${connectorId}/commands/claim`, {
        protocolVersion: "1.0",
        maximumCommands: 1,
        leaseSeconds: 60,
      }),
      connectorId,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(problemDetailsSchema.parse(await response.json())).toMatchObject({
      code: "rate-limited",
      retryable: true,
      retryAfterSeconds: 60,
    });
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

  it("rejects a non-UUID command id before calling the ledger", async () => {
    const complete = vi.fn<CommandLedger["complete"]>();
    const response = await handlers(commands({ complete })).complete(
      request(`/api/v1/connectors/${connectorId}/commands/result`, {
        protocolVersion: "1.0",
        commandId: "not-a-uuid",
        attempt: 1,
        leaseToken: "lease_token_1234567890abcdefghijklmnop",
        result: {
          outcome: "rejected-by-local-policy",
          reasonCode: "operator-approval-required",
        },
      }),
      connectorId,
    );

    expect(response.status).toBe(400);
    expect(problemDetailsSchema.parse(await response.json())).toMatchObject({
      code: "invalid-request",
      retryable: false,
    });
    expect(complete).not.toHaveBeenCalled();
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
      problemBaseUrl: "https://trusted.knot.test",
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

  it("rejects a malformed Content-Length as an invalid request", async () => {
    let authenticated = false;
    const service = createConnectorCommandHandlers({
      commands: commands(),
      connectors: { findActiveConnector: () => Promise.resolve(undefined) },
      nonces: { claim: () => Promise.resolve("claimed") },
      allowedAuthorities: ["knot.test"],
      problemBaseUrl: "https://trusted.knot.test",
      authenticate: () => {
        authenticated = true;
        return Promise.resolve({ connectorId, tenantId, scopes: [] });
      },
    });
    const response = await service.claim(
      new Request(
        `https://attacker.invalid/api/v1/connectors/${connectorId}/commands/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "not-a-number",
          },
          body: "{}",
        },
      ),
      connectorId,
    );

    expect(response.status).toBe(400);
    expect(problemDetailsSchema.parse(await response.json())).toMatchObject({
      type: "https://trusted.knot.test/problems/invalid-request",
      code: "invalid-request",
    });
    expect(authenticated).toBe(false);
  });

  it("accepts a legal command result larger than the control-route limit", async () => {
    const complete = vi.fn<CommandLedger["complete"]>().mockResolvedValue({
      status: "accepted",
      state: "succeeded",
    });
    const response = await handlers(commands({ complete })).complete(
      request(`/api/v1/connectors/${connectorId}/commands/result`, {
        protocolVersion: "1.0",
        commandId,
        attempt: 1,
        leaseToken: "lease_token_1234567890abcdefghijklmnop",
        result: {
          outcome: "succeeded",
          result: {
            type: "chat.read",
            spaceId: "space-1",
            chatId: "chat-1",
            messages: [
              {
                messageId: "message-1",
                text: "x".repeat(70 * 1024),
                sentAt: 1,
                senderDigest: "a".repeat(64),
                provenance: {
                  kind: "connector-attested-anytype",
                  connectorId,
                  senderDigest: "a".repeat(64),
                  spaceId: "space-1",
                  messageId: "message-1",
                },
              },
            ],
          },
        },
      }),
      connectorId,
    );

    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each(["22023", "22P02", "22P05"])(
    "maps database input error %s to an unprocessable result",
    async (databaseCode) => {
      const databaseError = Object.assign(new Error("result type mismatch"), {
        code: databaseCode,
      });
      const complete = vi
        .fn<CommandLedger["complete"]>()
        .mockRejectedValue(databaseError);
      const response = await handlers(commands({ complete })).complete(
        request(`/api/v1/connectors/${connectorId}/commands/result`, {
          protocolVersion: "1.0",
          commandId,
          attempt: 1,
          leaseToken: "lease_token_1234567890abcdefghijklmnop",
          result: {
            outcome: "rejected-by-local-policy",
            reasonCode: "operator-approval-required",
          },
        }),
        connectorId,
      );

      expect(response.status).toBe(422);
      expect(problemDetailsSchema.parse(await response.json())).toMatchObject({
        code: "invalid-request",
        retryable: false,
      });
    },
  );

  it("logs an internal command failure with the response request id", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const claim = vi
      .fn<CommandLedger["claim"]>()
      .mockRejectedValue(new Error("sensitive database diagnostic"));
    const response = await handlers(commands({ claim })).claim(
      request(`/api/v1/connectors/${connectorId}/commands/claim`, {
        protocolVersion: "1.0",
        maximumCommands: 1,
        leaseSeconds: 60,
      }),
      connectorId,
    );
    const problem = problemDetailsSchema.parse(await response.json());

    expect(response.status).toBe(500);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      level: "error",
      event: "connector-command-internal-error",
      requestId: problem.requestId,
      status: 500,
      code: "internal-error",
    });
    expect(error.mock.calls[0]?.[0]).not.toContain(
      "sensitive database diagnostic",
    );
    error.mockRestore();
  });

  it("returns a typed retryable problem when production providers cannot initialize", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const factory = vi.fn(() => {
      throw new Error("missing Upstash configuration");
    });
    const dispatch = createProductionConnectorCommandDispatcher(
      factory,
      () => "https://trusted.knot.test",
    );
    const connectorRequest = request(
      `/api/v1/connectors/${connectorId}/commands/claim`,
      { protocolVersion: "1.0", maximumCommands: 1, leaseSeconds: 60 },
    );

    const first = await dispatch("claim", connectorRequest, connectorId);
    const second = await dispatch(
      "claim",
      request(`/api/v1/connectors/${connectorId}/commands/claim`, {
        protocolVersion: "1.0",
        maximumCommands: 1,
        leaseSeconds: 60,
      }),
      connectorId,
    );

    expect(first.status).toBe(503);
    expect(first.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
    expect(first.headers.get("Retry-After")).toBe("30");
    const firstProblem = problemDetailsSchema.parse(await first.json());
    expect(firstProblem).toMatchObject({
      type: "https://trusted.knot.test/problems/dependency-unavailable",
      code: "dependency-unavailable",
      retryable: true,
      retryAfterSeconds: 30,
    });
    expect(second.status).toBe(503);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      event: "connector-provider-unavailable",
      requestId: firstProblem.requestId,
      status: 503,
      code: "dependency-unavailable",
    });
    error.mockRestore();
  });

  it("memoizes a successfully constructed production handler", async () => {
    const service = handlers(commands());
    const factory = vi.fn(() => service);
    const dispatch = createProductionConnectorCommandDispatcher(factory);

    for (let index = 0; index < 2; index += 1) {
      const response = await dispatch(
        "claim",
        request(`/api/v1/connectors/${connectorId}/commands/claim`, {
          protocolVersion: "1.0",
          maximumCommands: 1,
          leaseSeconds: 60,
        }),
        connectorId,
      );
      expect(response.status).toBe(200);
    }
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
