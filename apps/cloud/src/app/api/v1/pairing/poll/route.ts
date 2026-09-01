import { pairingSessionPollSchema } from "@imai/knot-cloud-contract";

import { NeonPairingRepository } from "@/lib/adapters/neon-pairing";
import {
  hasConflictingPairingPollCredential,
  noStoreJson,
  problemResponse,
} from "@/lib/http";
import { pollPairingSession } from "@/lib/pairing";
import { checkPairingPollRateLimit } from "@/lib/security/pairing-poll-rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (hasConflictingPairingPollCredential(request)) {
    return problemResponse(request, {
      status: 400,
      code: "invalid-request",
      title: "Use only the pairing poll token on this route.",
    });
  }
  let rateLimit;
  try {
    rateLimit = await checkPairingPollRateLimit(request);
  } catch {
    return problemResponse(request, {
      status: 503,
      code: "internal-error",
      title: "Pairing poll protection is temporarily unavailable.",
      retryable: true,
      headers: { "Retry-After": "3" },
    });
  }
  if (!rateLimit.allowed) {
    return problemResponse(request, {
      status: 429,
      code: "rate-limited",
      title: "Too many pairing polls. Wait before trying again.",
      retryable: true,
      headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
    });
  }
  const parsed = pairingSessionPollSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return problemResponse(request, {
      status: 401,
      code: "authentication-required",
      title: "The pairing credentials could not be verified.",
    });
  }
  const status = await pollPairingSession(
    {
      pairingId: parsed.data.pairingId,
      pollToken: parsed.data.pollToken,
    },
    new NeonPairingRepository(),
  );
  if (!status) {
    return problemResponse(request, {
      status: 401,
      code: "authentication-required",
      title: "The pairing credentials could not be verified.",
    });
  }
  return noStoreJson(status);
}

async function readJson(request: Request) {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}
