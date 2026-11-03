/**
 * The principals a user acts as: themselves, their org, and their groups.
 * Index chunks carry the principals allowed to read them, and every search
 * filters on the overlap.
 * @module retrieval/principals
 */
import type { Queryable } from '../shared/db.js'

export async function principalsFor(db: Queryable, userId: string, orgId: string): Promise<string[]> {
  const { rows } = await db.query<{ group_id: string }>('SELECT group_id FROM group_members WHERE user_id = $1', [userId])
  return [`user:${userId}`, `org:${orgId}`, ...rows.map((r) => `group:${r.group_id}`)]
}
