import {
  maximumProtocolVersion,
  minimumProtocolVersion,
  protocolMetaSchema,
} from "@imai/knot-cloud-contract";

export const dynamic = "force-dynamic";

export function GET() {
  const body = protocolMetaSchema.parse({
    product: "knot-cloud",
    minimumProtocolVersion,
    maximumProtocolVersion,
    serverUnixSeconds: Math.floor(Date.now() / 1_000),
  });

  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
