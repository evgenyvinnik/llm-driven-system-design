/**
 * Environments and their keys. Keys are looked up on every SDK request, so
 * they are cached in memory (they change only when an operator rotates them).
 * @module services/environment-service
 */
import { pool } from '../shared/db.js'

export interface EnvironmentRow {
  key: string
  name: string
  clientKey: string
  serverKey: string
  snapshotVersion: number
}

let cache: { at: number; rows: EnvironmentRow[] } | null = null
const TTL_MS = 30_000

export async function listEnvironments(): Promise<EnvironmentRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows
  const { rows } = await pool.query<{ key: string; name: string; client_key: string; server_key: string; snapshot_version: string }>(
    'SELECT key, name, client_key, server_key, snapshot_version FROM environments ORDER BY key',
  )
  cache = { at: Date.now(), rows: rows.map((r) => ({ key: r.key, name: r.name, clientKey: r.client_key, serverKey: r.server_key, snapshotVersion: Number(r.snapshot_version) })) }
  return cache.rows
}

export async function environmentForClientKey(key: string | undefined): Promise<EnvironmentRow | null> {
  if (!key) return null
  return (await listEnvironments()).find((e) => e.clientKey === key) ?? null
}

export async function environmentForServerKey(key: string | undefined): Promise<EnvironmentRow | null> {
  if (!key) return null
  return (await listEnvironments()).find((e) => e.serverKey === key) ?? null
}

export async function environmentExists(key: string): Promise<boolean> {
  return (await listEnvironments()).some((e) => e.key === key)
}

export function clearEnvironmentCache(): void {
  cache = null
}
