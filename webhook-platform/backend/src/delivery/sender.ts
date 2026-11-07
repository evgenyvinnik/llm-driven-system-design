/**
 * The outbound HTTP call for one attempt.
 *
 * - Resolves and vets the target right now (see ssrf.ts), then opens the
 *   socket to that exact IP. Host header and TLS SNI carry the original name,
 *   so virtual hosting and certificate checks still work.
 * - One deadline covers connect, send, response headers and body.
 * - Redirects are never followed (node:http never does by itself).
 * - At most 64 KB of the response body is read; the first `bodyLimit`
 *   characters are kept for the delivery log.
 * - No connection reuse (agent: false). Production would pool per endpoint;
 *   locally a fresh socket makes "drop the acknowledgment" faults explicit.
 * @module delivery/sender
 */
import http from 'node:http'
import https from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { resolveTarget, SsrfError, type LookupFn } from './ssrf.js'

export interface SendRequest {
  url: string
  body: string
  headers: Record<string, string>
  timeoutMs: number
  bodyLimit: number
  allowHttp: boolean
  allowlist: string[]
  lookup?: LookupFn
}

export type SendResult =
  | { kind: 'response'; status: number; headers: http.IncomingHttpHeaders; body: string; latencyMs: number; ip: string }
  | { kind: 'error'; errorClass: 'timeout' | 'connection_error' | 'dns_error' | 'ssrf_blocked' | 'invalid_url'; message: string; latencyMs: number; ip: string | null }

const MAX_READ = 64 * 1024

export const systemLookup: LookupFn = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

export async function sendWebhook(req: SendRequest): Promise<SendResult> {
  const started = Date.now()
  let target
  try {
    target = await resolveTarget(req.url, { allowHttp: req.allowHttp, allowlist: req.allowlist, lookup: req.lookup ?? systemLookup })
  } catch (err) {
    if (err instanceof SsrfError) return { kind: 'error', errorClass: err.errorClass, message: err.message, latencyMs: Date.now() - started, ip: null }
    throw err
  }
  const isHttps = target.url.protocol === 'https:'
  const mod = isHttps ? https : http
  const ip = target.ip
  const hostHeader = target.url.host

  return new Promise<SendResult>((resolve) => {
    let settled = false
    let timedOut = false
    const finish = (r: SendResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const request = mod.request(
      {
        host: ip,
        family: target.family,
        port: target.port,
        method: 'POST',
        path: `${target.url.pathname}${target.url.search}`,
        headers: { ...req.headers, host: hostHeader, 'content-length': Buffer.byteLength(req.body).toString() },
        agent: false,
        ...(isHttps ? { servername: target.isIpLiteral ? undefined : target.hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        let read = 0
        res.on('data', (chunk: Buffer) => {
          if (read < MAX_READ) {
            chunks.push(chunk)
            read += chunk.length
          }
          if (read >= MAX_READ) res.destroy()
        })
        const done = () =>
          finish({
            kind: 'response',
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8').slice(0, req.bodyLimit),
            latencyMs: Date.now() - started,
            ip,
          })
        res.on('end', done)
        res.on('close', done)
        res.on('error', done)
      },
    )
    const timer = setTimeout(() => {
      timedOut = true
      request.destroy(new Error(`No response within ${req.timeoutMs} ms`))
    }, req.timeoutMs)
    request.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        kind: 'error',
        errorClass: timedOut ? 'timeout' : 'connection_error',
        message: timedOut ? `Timed out after ${req.timeoutMs} ms` : `${err.code ?? 'ERROR'}: ${err.message}`,
        latencyMs: Date.now() - started,
        ip,
      })
    })
    request.end(req.body)
  })
}
