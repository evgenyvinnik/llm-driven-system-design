/** JSON/JSONB values arrive as objects; String() would render them as "[object Object]". */
export function formatCell(value: unknown): string {
  return typeof value === 'object' && value !== null && !(value instanceof Date) ? JSON.stringify(value) : String(value);
}
