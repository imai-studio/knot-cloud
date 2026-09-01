export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function assertJsonNumber(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("Canonical JSON supports only safe integers");
  }

  return Object.is(value, -0) ? 0 : value;
}

function encodeCanonicalJson(value: JsonValue, depth: number): string {
  if (depth > 100) {
    throw new TypeError("Canonical JSON exceeds the maximum depth");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return JSON.stringify(assertJsonNumber(value));
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => encodeCanonicalJson(entry, depth + 1)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${encodeCanonicalJson(entry, depth + 1)}`,
    )
    .join(",")}}`;
}

export function canonicalJson(value: JsonValue): string {
  return encodeCanonicalJson(value, 0);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
