import { canonicalJson, sha256Hex, type JsonValue } from "./canonical-json.js";

export async function deriveIdempotencyKey(parts: {
  credentialId: string;
  tenantId: string;
  operation: string;
  targetId: string;
  payload: JsonValue;
}): Promise<string> {
  const material = canonicalJson({
    credentialId: parts.credentialId,
    operation: parts.operation,
    payload: parts.payload,
    targetId: parts.targetId,
    tenantId: parts.tenantId,
  });

  return `kc1_${await sha256Hex(material)}`;
}
