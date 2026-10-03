/**
 * Mirror of the backend's normalizePrefix: lowercase, no leading whitespace, a trailing
 * whitespace run kept as one space. The trailing space marks a word boundary ("java "
 * completes to "java spring boot", "java" to "javascript"), so the two never share a cache key.
 */
export function normalizePrefix(prefix: string): string {
  const lookup = prefix.toLowerCase().trimStart();
  const trimmed = lookup.trimEnd();
  return trimmed.length < lookup.length ? `${trimmed} ` : lookup;
}
