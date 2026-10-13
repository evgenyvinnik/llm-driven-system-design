/** Mirrors the server's `{{variable}}` syntax so the editor can list variables as you type. */
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export function extractVariables(...texts: string[]): string[] {
  const seen = new Set<string>()
  for (const text of texts) for (const match of text.matchAll(VARIABLE_PATTERN)) seen.add(match[1])
  return [...seen]
}
