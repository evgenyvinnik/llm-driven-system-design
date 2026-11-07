/**
 * Prompt templates with {{variable}} placeholders, as in the prompt playground.
 * A run is validated before it is created: every variable the prompt version
 * uses must exist in every case of the dataset version, so a missing variable
 * is a 422 at creation instead of N errored tasks later.
 * @module shared/template
 */

const VARIABLE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/** Variable names in order of first appearance. */
export function extractVariables(...texts: string[]): string[] {
  const seen: string[] = []
  for (const text of texts) {
    for (const match of text.matchAll(VARIABLE)) if (!seen.includes(match[1])) seen.push(match[1])
  }
  return seen
}

export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(VARIABLE, (_whole, name: string) => {
    const value = values[name]
    if (value === undefined || value === null) return ''
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

/** Variables the template needs that `values` lacks. */
export function missingVariables(variables: readonly string[], values: Record<string, unknown>): string[] {
  return variables.filter((v) => values[v] === undefined || values[v] === null)
}
