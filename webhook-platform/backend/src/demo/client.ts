/**
 * Small HTTP client for the demo scripts: sign in, emit with API keys, drive
 * the mock receiver through the API (the same org-scoped proxy the console uses).
 */
import { config } from '../shared/config.js'
import { SEED_API_KEYS } from '../db/seed-data.js'

export const API = process.env.API_URL || config.apiUrl

export async function login(username: string): Promise<string> {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123' }),
  })
  if (!res.ok) throw new Error(`login ${username}: HTTP ${res.status}`)
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function call(method: string, path: string, opts: { cookie?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<any> {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  if (res.status === 204) return null
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json)}`)
  return json
}

let n = 0
export async function emit(org: 'acme' | 'globex', type: string, data: Record<string, unknown>, orderingKey?: string): Promise<{ event: { id: string; createdAt: string } }> {
  const key = org === 'acme' ? SEED_API_KEYS.org_acme : SEED_API_KEYS.org_globex
  return call('POST', '/events', { key, body: { type, data, ...(orderingKey ? { orderingKey } : {}) }, headers: { 'idempotency-key': `demo-${Date.now()}-${n++}` } })
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 500): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(everyMs)
  }
  return null
}
