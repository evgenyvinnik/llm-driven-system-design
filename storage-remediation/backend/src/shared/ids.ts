import { randomBytes } from 'node:crypto'

/** Short, sortable-enough, URL-safe IDs with a type prefix (cmp_, exc_, ...). */
export function newId(prefix: string): string {
  const time = Date.now().toString(36)
  return `${prefix}_${time}${randomBytes(5).toString('hex')}`
}
