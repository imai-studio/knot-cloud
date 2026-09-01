import {
  webhookSubscriptionCreateSchema,
  webhookSubscriptionListSchema,
  webhookSubscriptionSchema,
} from "@imai/knot-cloud-contract";
import { ZodError, z } from "zod";

import { NeonTransactionalEventRepository } from "@/lib/adapters/neon-transactional-events";
import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import {
  getWebhookDestinations,
  getWebhookMaxActiveSubscriptions,
} from "@/lib/env";
import {
  TransactionalEventError,
  type TransactionalEventRepository,
} from "@/lib/transactional-events";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { jsonResponse, problemResponse } from "./problem";

async function authorize(request: Request, mutation: boolean) {
  if (mutation && !isTrustedHumanMutationOrigin(request)) return null;
  const authorized = await getAuthorizedWorkspace(request.headers);
  if (!authorized || authorized.workspace.role === "member") return null;
  return authorized.workspace;
}

export function createSessionWebhookHandlers(
  repository: TransactionalEventRepository = new NeonTransactionalEventRepository(),
  destinationNames: ReadonlySet<string> = new Set(
    getWebhookDestinations().keys(),
  ),
  activeLimit = getWebhookMaxActiveSubscriptions(),
) {
  const failed = (request: Request, error: unknown) => {
    if (error instanceof ZodError)
      return problemResponse({
        request,
        status: 400,
        code: "invalid-request",
        title: "Webhook subscription is invalid",
      });
    if (error instanceof TransactionalEventError) {
      if (error.code === "connector-denied")
        return problemResponse({
          request,
          status: 403,
          code: "connector-denied",
          title: error.message,
        });
      if (error.code === "subscription-limit-exceeded")
        return problemResponse({
          request,
          status: 403,
          code: error.code,
          title: error.message,
        });
      if (
        error.code === "duplicate-subscription" ||
        error.code === "subscription-name-conflict"
      )
        return problemResponse({
          request,
          status: 409,
          code: error.code,
          title: error.message,
        });
    }
    if (error instanceof Error && error.message === "connector-denied")
      return problemResponse({
        request,
        status: 403,
        code: "forbidden",
        title: "A connector is not available in this workspace",
      });
    return problemResponse({
      request,
      status: 500,
      code: "internal-error",
      title: "Webhook subscription service is unavailable",
      retryable: true,
      retryAfterSeconds: 5,
    });
  };
  return {
    async list(request: Request) {
      const workspace = await authorize(request, false);
      if (!workspace)
        return problemResponse({
          request,
          status: 403,
          code: "forbidden",
          title: "This session cannot manage webhooks",
        });
      try {
        return jsonResponse(
          webhookSubscriptionListSchema.parse({
            subscriptions: await repository.listSubscriptions(
              workspace.tenantId,
            ),
          }),
        );
      } catch (error) {
        return failed(request, error);
      }
    },
    async create(request: Request) {
      const workspace = await authorize(request, true);
      if (!workspace)
        return problemResponse({
          request,
          status: 403,
          code: "forbidden",
          title: "This session cannot manage webhooks",
        });
      try {
        const values = webhookSubscriptionCreateSchema.parse(
          await request.json(),
        );
        if (!destinationNames.has(values.destinationName))
          return problemResponse({
            request,
            status: 403,
            code: "forbidden",
            title: "Webhook destination is not pre-approved by this deployment",
          });
        return jsonResponse(
          webhookSubscriptionSchema.parse(
            await repository.createSubscription({
              tenantId: workspace.tenantId,
              userId: workspace.userId,
              activeLimit,
              values,
            }),
          ),
          201,
        );
      } catch (error) {
        return failed(request, error);
      }
    },
    async disable(request: Request, subscriptionId: string) {
      const workspace = await authorize(request, true);
      if (!workspace)
        return problemResponse({
          request,
          status: 403,
          code: "forbidden",
          title: "This session cannot manage webhooks",
        });
      try {
        z.uuid().parse(subscriptionId);
        const found = await repository.disableSubscription({
          tenantId: workspace.tenantId,
          userId: workspace.userId,
          subscriptionId,
        });
        if (!found)
          return problemResponse({
            request,
            status: 404,
            code: "not-found",
            title: "Active webhook subscription not found",
          });
        return new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        return failed(request, error);
      }
    },
  };
}
