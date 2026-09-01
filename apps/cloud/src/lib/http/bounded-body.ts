import { HttpProblem } from "./problem";

export async function readBoundedBody(
  request: Request,
  maximumBodyBytes: number,
): Promise<Uint8Array> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new HttpProblem(
        400,
        "invalid-request",
        "Content-Length is not a valid non-negative integer",
      );
    }
    if (parsedLength > maximumBodyBytes) {
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
