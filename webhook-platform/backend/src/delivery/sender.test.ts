import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sendWebhook } from './sender.js'

let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/slow') return void setTimeout(() => res.end('late'), 500)
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
        return void res.end()
      }
      if (req.url === '/drop') return void req.socket.destroy()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ host: req.headers.host, body, sig: req.headers['webhook-signature'] ?? null, filler: 'x'.repeat(5000) }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

const req = (path: string, extra: Partial<Parameters<typeof sendWebhook>[0]> = {}) =>
  sendWebhook({
    url: `http://127.0.0.1:${port}${path}`,
    body: '{"id":"evt_1"}',
    headers: { 'content-type': 'application/json', 'webhook-signature': 't=1,v1=abc' },
    timeoutMs: 200,
    bodyLimit: 100,
    allowHttp: true,
    allowlist: [`127.0.0.1:${port}`],
    ...extra,
  })

describe('sendWebhook', () => {
  it('posts the body to the vetted IP and truncates the stored response', async () => {
    const r = await req('/ok')
    expect(r.kind).toBe('response')
    if (r.kind !== 'response') return
    expect(r.status).toBe(200)
    expect(r.ip).toBe('127.0.0.1')
    expect(r.body.length).toBe(100)
    expect(r.body).toContain('"body":"{\\"id\\":\\"evt_1\\"}"')
  })

  it('does not follow redirects', async () => {
    const r = await req('/redirect')
    expect(r).toMatchObject({ kind: 'response', status: 302 })
  })

  it('times out slow receivers', async () => {
    const r = await req('/slow')
    expect(r).toMatchObject({ kind: 'error', errorClass: 'timeout' })
  })

  it('reports a dropped socket as a connection error', async () => {
    const r = await req('/drop')
    expect(r).toMatchObject({ kind: 'error', errorClass: 'connection_error' })
  })

  it('refuses loopback without an allowlist entry, before opening any socket', async () => {
    const r = await req('/ok', { allowlist: [] })
    expect(r).toMatchObject({ kind: 'error', errorClass: 'ssrf_blocked', ip: null })
  })

  it('pins the connection: a name resolving to the allowlisted IP:port connects there with the original Host', async () => {
    const r = await req('/ok', {
      url: `http://receiver.test:${port}/ok`,
      allowlist: [`127.0.0.1:${port}`],
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    })
    expect(r.kind).toBe('response')
    if (r.kind === 'response') expect(r.body).toContain(`"host":"receiver.test:${port}"`)
  })
})
