import {
  canonicalJson,
  protocolVersion,
  sha256Hex,
  transactionalEventAcceptedSchema,
  transactionalEventCreateSchema,
  type JsonValue,
} from "@imai/knot-cloud-contract";
import { ZodError } from "zod";

import { NeonConsumerDataRepository } from "@/lib/adapters/neon-consumer-data";
import { NeonTransactionalEventRepository } from "@/lib/adapters/neon-transactional-events";
import {
  ConsumerDataError,
  type ConsumerDataRepository,
  type ResolvedConsumerApiKey,
} from "@/lib/consumer-data";
import {
  TransactionalEventError,
  type TransactionalEventRepository,
} from "@/lib/transactional-events";
import { authenticateConsumerApiKey } from "@/lib/security/consumer-api-key";

import { jsonResponse, problemResponse } from "./problem";

const maximumBodyBytes = 16 * 1024;

async function readBoundedJson(request: Request): Promise<unknown> {
  if (
    request.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    throw new TransactionalEventError(
      "invalid-request",
      "Content-Type must be application/json",
    );
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (!Number.isSafeInteger(declared) || declared > maximumBodyBytes)
    throw new TransactionalEventError(
      "invalid-request",
      "Event body is too large",
    );
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader)
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBodyBytes) {
        await reader.cancel();
        throw new TransactionalEventError(
          "invalid-request",
          "Event body is too large",
        );
      }
      chunks.push(next.value);
    }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

export function createTransactionalEventHandler(dependencies?: {
  events?: TransactionalEventRepository;
  consumers?: ConsumerDataRepository;
  authenticate?: (
    authorization: string | null,
  ) => Promise<ResolvedConsumerApiKey>;
  now?: () => Date;
}) {
  const events = dependencies?.events ?? new NeonTransactionalEventRepository();
  const consumers = dependencies?.consumers ?? new NeonConsumerDataRepository();
  const authenticate =
    dependencies?.authenticate ??
    ((authorization) =>
      authenticateConsumerApiKey({ authorization, repository: consumers }));
  const now = dependencies?.now ?? (() => new Date());
  return async (request: Request): Promise<Response> => {
    try {
      const credential = await authenticate(
        request.headers.get("Authorization"),
      );
      const body = transactionalEventCreateSchema.parse(
        await readBoundedJson(request),
      );
      const current = Math.floor(now().getTime() / 1_000);
      if (Math.abs(body.createdAt - current) > 5 * 60)
        throw new TransactionalEventError(
          "invalid-request",
          "Event time is outside the accepted window",
        );
      if (!credential.scopes.includes("anytype.chats.read"))
        throw new TransactionalEventError(
          "scope-denied",
          "API key scope denied",
        );
      if (!credential.connectorIds.includes(body.connectorId))
        throw new TransactionalEventError(
          "connector-denied",
          "Connector binding denied",
        );
      const requestSha256 = await sha256Hex(
        canonicalJson(body as unknown as JsonValue),
      );
      const accepted = await events.enqueue({
        tenantId: credential.tenantId,
        apiKeyId: credential.id,
        values: body,
        requestSha256,
      });
      return jsonResponse(
        transactionalEventAcceptedSchema.parse({
          protocolVersion,
          eventId: accepted.eventId,
          status: "accepted",
          duplicate: !accepted.created,
        }),
        accepted.created ? 202 : 200,
      );
    } catch (error) {
      if (error instanceof TransactionalEventError) {
        const status =
          error.code === "idempotency-conflict"
            ? 409
            : error.code === "invalid-request"
              ? 400
              : 403;
        const code =
          error.code === "idempotency-conflict"
            ? "conflict"
            : error.code === "destination-denied" ||
                error.code === "connector-denied"
              ? "forbidden"
              : error.code;
        return problemResponse({ request, status, code, title: error.message });
      }
      if (error instanceof ConsumerDataError) {
        const status = error.code === "authentication-required" ? 401 : 403;
        return problemResponse({
          request,
          status,
          code: status === 401 ? "authentication-required" : "forbidden",
          title: error.message,
        });
      }
      if (error instanceof ZodError || error instanceof SyntaxError)
        return problemResponse({
          request,
          status: 400,
          code: "invalid-request",
          title: "Event body does not match the transactional event protocol",
        });
      return problemResponse({
        request,
        status: 500,
        code: "internal-error",
        title: "The transactional event could not be accepted",
        retryable: true,
        retryAfterSeconds: 5,
      });
    }
  };
}
