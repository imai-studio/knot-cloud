import {
  commandClaimRequestSchema,
  commandClaimResponseSchema,
  commandEnvelopeSchema,
  commandLeaseExtendedSchema,
  commandLeaseExtensionSchema,
  commandResultReceiptSchema,
  commandResultSubmissionSchema,
  protocolVersion,
} from "@imai/knot-cloud-contract";
import { ZodError, type ZodType } from "zod";

import { NeonCommandLedger } from "@/lib/adapters/neon-command-ledger";
import { NeonConnectorRepository } from "@/lib/adapters/neon-connectors";
import { UpstashReplayNonceStore } from "@/lib/adapters/upstash-replay";
import { getSigningAuthorities } from "@/lib/env";
import type { CommandLedger, ReplayNonceStore } from "@/lib/ports";
import {
  authenticateConnectorRequest,
  ConnectorAuthenticationError,
  type ConnectorRepository,
} from "@/lib/security/connector-auth";

import { HttpProblem, jsonResponse, problemResponse } from "./problem";

const maximumBodyBytes = 64 * 1024;

type AuthenticatedConnector = {
  connectorId: string;
  tenantId: string;
  scopes: string[];
};

export interface ConnectorCommandDependencies {
  commands: CommandLedger;
  connectors: ConnectorRepository;
  nonces: ReplayNonceStore;
  allowedAuthorities: readonly string[];
  authenticate?: typeof authenticateConnectorRequest;
  now?: () => Date;
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumBodyBytes
    ) {
      throw new HttpProblem(
        413,
        "payload-too-large",
        "Request body is too large",
      );
    }
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBodyBytes) {
        await reader.cancel();
        throw new HttpProblem(
          413,
          "payload-too-large",
          "Request body is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJson<T>(body: Uint8Array, schema: ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpProblem(
      400,
      "invalid-request",
      "Request body is not valid JSON",
    );
  }
  return schema.parse(value);
}

function unixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}

export function createConnectorCommandHandlers(
  dependencies: ConnectorCommandDependencies,
) {
  const authenticate =
    dependencies.authenticate ?? authenticateConnectorRequest;
  const now = dependencies.now ?? (() => new Date());

  async function authorize(
    request: Request,
    pathConnectorId: string,
    body: Uint8Array,
  ): Promise<AuthenticatedConnector> {
    if (
      request.headers
        .get("Content-Type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      throw new HttpProblem(
        400,
        "invalid-request",
        "Content-Type must be application/json",
      );
    }
    const connector = await authenticate({
      request,
      body,
      connectors: dependencies.connectors,
      nonces: dependencies.nonces,
      allowedAuthorities: dependencies.allowedAuthorities,
    });
    if (connector.connectorId !== pathConnectorId) {
      throw new HttpProblem(
        403,
        "forbidden",
        "The signed connector does not match the request path",
      );
    }
    return connector;
  }

  async function execute(
    request: Request,
    pathConnectorId: string,
    operation: (
      body: Uint8Array,
      connector: AuthenticatedConnector,
    ) => Promise<Response>,
  ): Promise<Response> {
    try {
      const body = await readBoundedBody(request);
      const connector = await authorize(request, pathConnectorId, body);
      return await operation(body, connector);
    } catch (error) {
      if (error instanceof ConnectorAuthenticationError) {
        const code =
          error.code === "invalid-signature" ||
          error.code === "connector-not-found"
            ? "authentication-required"
            : error.code;
        return problemResponse({
          request,
          status: error.status,
          code,
          title: "Connector authentication failed",
          retryable: false,
          serverUnixSeconds:
            error.code === "clock-skew"
              ? Math.floor(now().getTime() / 1_000)
              : undefined,
        });
      }
      if (error instanceof HttpProblem) {
        return problemResponse({
          request,
          status: error.status,
          code: error.code,
          title: error.message,
          retryable: error.retryable,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      }
      if (error instanceof ZodError) {
        return problemResponse({
          request,
          status: 400,
          code: "invalid-request",
          title: "Request body does not match the protocol",
        });
      }
      return problemResponse({
        request,
        status: 500,
        code: "internal-error",
        title: "The command service could not complete the request",
        retryable: true,
        retryAfterSeconds: 5,
      });
    }
  }

  return {
    claim(request: Request, connectorId: string): Promise<Response> {
      return execute(request, connectorId, async (body, connector) => {
        const input = parseJson(body, commandClaimRequestSchema);
        const commands = [];
        for (let index = 0; index < input.maximumCommands; index += 1) {
          const command = await dependencies.commands.claim({
            tenantId: connector.tenantId,
            connectorId: connector.connectorId,
            allowedScopes: connector.scopes,
            leaseSeconds: input.leaseSeconds,
          });
          if (!command) break;
          commands.push(
            commandEnvelopeSchema.parse({
              protocolVersion,
              commandId: command.commandId,
              connectorId: connector.connectorId,
              requiredScope: command.requiredScope,
              createdBy: command.createdByKind,
              createdAt: unixSeconds(command.createdAt),
              notBefore: unixSeconds(command.notBefore),
              expiresAt: unixSeconds(command.expiresAt),
              attempt: command.attempt,
              leaseToken: command.leaseToken,
              leaseExpiresAt: unixSeconds(command.leaseExpiresAt),
              payload: command.payload,
            }),
          );
        }
        return jsonResponse(
          commandClaimResponseSchema.parse({
            protocolVersion,
            commands,
            pollAfterSeconds: commands.length === 0 ? 5 : 1,
          }),
        );
      });
    },

    extend(request: Request, connectorId: string): Promise<Response> {
      return execute(request, connectorId, async (body, connector) => {
        const input = parseJson(body, commandLeaseExtensionSchema);
        const leaseExpiresAt = await dependencies.commands.extend({
          tenantId: connector.tenantId,
          commandId: input.commandId,
          attempt: input.attempt,
          leaseToken: input.leaseToken,
          leaseSeconds: input.extendBySeconds,
        });
        if (!leaseExpiresAt) {
          throw new HttpProblem(
            409,
            "lease-lost",
            "The command lease is no longer active",
          );
        }
        return jsonResponse(
          commandLeaseExtendedSchema.parse({
            protocolVersion,
            commandId: input.commandId,
            attempt: input.attempt,
            leaseExpiresAt: unixSeconds(leaseExpiresAt),
          }),
        );
      });
    },

    complete(request: Request, connectorId: string): Promise<Response> {
      return execute(request, connectorId, async (body, connector) => {
        const input = parseJson(body, commandResultSubmissionSchema);
        const completion = await dependencies.commands.complete({
          tenantId: connector.tenantId,
          commandId: input.commandId,
          attempt: input.attempt,
          leaseToken: input.leaseToken,
          completion: input.result,
        });
        if (
          completion.status === "stale" ||
          completion.status === "unknown-lease"
        ) {
          throw new HttpProblem(
            409,
            "lease-lost",
            "The command lease is no longer active",
          );
        }
        return jsonResponse(
          commandResultReceiptSchema.parse({
            protocolVersion,
            commandId: input.commandId,
            attempt: input.attempt,
            status: completion.status,
            state: completion.state,
          }),
        );
      });
    },
  };
}

export function createProductionConnectorCommandHandlers() {
  return createConnectorCommandHandlers({
    commands: new NeonCommandLedger(),
    connectors: new NeonConnectorRepository(),
    nonces: new UpstashReplayNonceStore(),
    allowedAuthorities: getSigningAuthorities(),
  });
}
