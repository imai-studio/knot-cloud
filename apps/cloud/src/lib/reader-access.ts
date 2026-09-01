export function safeReaderReturnPath(
  value: string | undefined,
  siteSlug: string,
) {
  const fallback = `/p/${encodeURIComponent(siteSlug)}/index`;
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return fallback;
  }
  return value;
}
