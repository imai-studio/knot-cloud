import { pairingSessionPollSchema } from "@imai/knot-cloud-contract";

import { NeonPairingRepository } from "@/lib/adapters/neon-pairing";
import {
  hasConflictingPairingPollCredential,
  noStoreJson,
  problemResponse,
} from "@/lib/http";
import { pollPairingSession } from "@/lib/pairing";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (hasConflictingPairingPollCredential(request)) {
    return problemResponse(request, {
      status: 400,
      code: "invalid-request",
      title: "Use only the pairing poll token on this route.",
    });
  }
  const parsed = pairingSessionPollSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return problemResponse(request, {
      status: 400,
      code: "invalid-request",
      title: "The pairing ID or poll token is invalid.",
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
      title: "The pairing ID and poll token do not match.",
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
