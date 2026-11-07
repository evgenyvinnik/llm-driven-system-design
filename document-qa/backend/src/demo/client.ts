/**
 * Minimal API client for the demo script: one cookie per signed-in user.
 * @module demo/client
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export const API = process.env.API_URL || `http://localhost:${process.env.PORT ?? 3000}`

export class Client {
  private cookie = ''
  constructor(public username: string) {}

  async login(password = 'password123'): Promise<this> {
    const res = await fetch(`${API}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password }),
    })
    if (!res.ok) throw new Error(`login ${this.username} failed: ${res.status}`)
    this.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
    return this
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: { Cookie: this.cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T }
  }

  async upload<T = Record<string, unknown>>(file: string, opts: { documentId?: string; filename?: string; key?: string } = {}): Promise<{ status: number; body: T }> {
    const form = new FormData()
    form.append('file', new Blob([readFileSync(file)]), opts.filename ?? basename(file))
    const res = await fetch(`${API}/api/v1/documents${opts.documentId ? `/${opts.documentId}/versions` : ''}`, {
      method: 'POST',
      headers: { Cookie: this.cookie, 'Idempotency-Key': opts.key ?? randomUUID() },
      body: form,
    })
    return { status: res.status, body: (await res.json()) as T }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
