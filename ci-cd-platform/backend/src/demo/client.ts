/**
 * A small client for the demo and load scripts: signs in like a browser, and drives the
 * system only through its public API, so these scripts exercise what a person can do.
 * @module demo/client
 */

export const API_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`

export class DemoClient {
  private cookie = ''

  async login(username: string, password = 'password123'): Promise<this> {
    const res = await fetch(`${API_URL}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
    if (!res.ok) throw new Error(`Could not sign in as ${username}: HTTP ${res.status}. Is the stack up and seeded?`)
    this.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
    return this
  }

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_URL}/api/v1${path}`, {
      method,
      headers: { Cookie: this.cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const parsed = (await res.json().catch(() => ({}))) as T & { error?: { code: string; message: string } }
    if (res.status >= 400) throw new Error(`${method} ${path}: HTTP ${res.status} ${parsed.error?.code ?? ''} ${parsed.error?.message ?? ''}`)
    return parsed
  }

  get<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  post<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>('POST', path, body)
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitUntil<T>(what: string, fn: () => Promise<T | false | null | undefined>, timeoutMs = 60_000, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${what}`)
}
