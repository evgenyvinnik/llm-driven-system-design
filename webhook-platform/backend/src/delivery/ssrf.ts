/**
 * SSRF protection for outbound deliveries.
 *
 * A webhook platform makes HTTP requests to URLs its customers type in, from
 * inside its own network. Without checks, `http://169.254.169.254/` reads the
 * cloud metadata service (instance credentials), and `http://10.0.0.5:6379/`
 * talks to an internal Redis. Three rules:
 *
 * 1. **Vet the resolved IP at connection time, every attempt.** Checking only
 *    at registration is useless: the customer controls DNS and can point the
 *    name at 10.0.0.5 a minute later (DNS rebinding).
 * 2. **Connect to the IP that was vetted.** The sender opens the socket to the
 *    exact address returned here and sends the original name in Host / SNI, so
 *    there's no second lookup that could return a different answer.
 * 3. **Never follow redirects.** A 302 to `http://169.254.169.254/` would
 *    bypass both checks; the sender treats 3xx as a failed attempt.
 *
 * Every address a name resolves to must be public, not just the first one:
 * otherwise a name with one public and one private A record can win a race.
 * IPv4-mapped (::ffff:a.b.c.d), NAT64 and 6to4 IPv6 forms are unwrapped and
 * the embedded IPv4 address is checked.
 *
 * Local development needs one exception, because the bundled mock receiver
 * runs on localhost. `SSRF_ALLOWLIST` lists exact `host:port` pairs that may
 * be reached anyway (default: only the mock receiver's port).
 * @module delivery/ssrf
 */
import { isIP } from 'node:net'

export type SsrfErrorClass = 'invalid_url' | 'ssrf_blocked' | 'dns_error'

export class SsrfError extends Error {
  constructor(
    public errorClass: SsrfErrorClass,
    message: string,
  ) {
    super(message)
  }
}

interface V4Range {
  base: number
  bits: number
  name: string
}

function v4ToInt(ip: string): number {
  const p = ip.split('.').map(Number)
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]
}

function v4(cidr: string, name: string): V4Range {
  const [ip, bits] = cidr.split('/')
  return { base: v4ToInt(ip), bits: Number(bits), name }
}

const V4_BLOCKED: V4Range[] = [
  v4('0.0.0.0/8', 'this-network'),
  v4('10.0.0.0/8', 'private'),
  v4('100.64.0.0/10', 'cgnat'),
  v4('127.0.0.0/8', 'loopback'),
  v4('169.254.0.0/16', 'link-local / cloud metadata'),
  v4('172.16.0.0/12', 'private'),
  v4('192.0.0.0/24', 'ietf-protocol'),
  v4('192.0.2.0/24', 'documentation'),
  v4('192.88.99.0/24', '6to4-relay'),
  v4('192.168.0.0/16', 'private'),
  v4('198.18.0.0/15', 'benchmarking'),
  v4('198.51.100.0/24', 'documentation'),
  v4('203.0.113.0/24', 'documentation'),
  v4('224.0.0.0/4', 'multicast'),
  v4('240.0.0.0/4', 'reserved / broadcast'),
]

function inV4(ipInt: number, r: V4Range): boolean {
  if (r.bits === 0) return true
  const mask = r.bits === 32 ? 0xffffffff : (~((1 << (32 - r.bits)) - 1)) >>> 0
  return ((ipInt & mask) >>> 0) === ((r.base & mask) >>> 0)
}

/** Expands any IPv6 text form (including a dotted IPv4 tail) to a 128-bit bigint. */
export function v6ToBigInt(ip: string): bigint {
  let addr = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  // Dotted IPv4 tail, e.g. ::ffff:127.0.0.1
  const dotted = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const n = v4ToInt(dotted[2])
    addr = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null]
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const missing = 8 - headParts.length - tailParts.length
  const groups = tail === null ? headParts : [...headParts, ...Array(missing).fill('0'), ...tailParts]
  let out = 0n
  for (const g of groups) out = (out << 16n) + BigInt(parseInt(g || '0', 16))
  return out
}

interface V6Range {
  base: bigint
  bits: number
  name: string
  /** Where the embedded IPv4 address sits, if this range wraps one. */
  embedsV4?: 'low32' | 'sixToFour'
}

function v6(cidr: string, name: string, embedsV4?: V6Range['embedsV4']): V6Range {
  const [ip, bits] = cidr.split('/')
  return { base: v6ToBigInt(ip), bits: Number(bits), name, embedsV4 }
}

// Order matters: wrappers that embed IPv4 are checked first.
const V6_RANGES: V6Range[] = [
  v6('::ffff:0:0/96', 'ipv4-mapped', 'low32'),
  v6('64:ff9b::/96', 'nat64', 'low32'),
  v6('2002::/16', '6to4', 'sixToFour'),
  v6('::/128', 'unspecified'),
  v6('::1/128', 'loopback'),
  v6('::/96', 'ipv4-compatible (deprecated)'),
  v6('64:ff9b:1::/48', 'nat64-local'),
  v6('100::/64', 'discard'),
  v6('2001::/23', 'ietf-protocol / teredo'),
  v6('2001:db8::/32', 'documentation'),
  v6('fc00::/7', 'unique-local (incl. fd00:ec2::254 metadata)'),
  v6('fe80::/10', 'link-local'),
  v6('fec0::/10', 'site-local (deprecated)'),
  v6('ff00::/8', 'multicast'),
]

function inV6(ip: bigint, r: V6Range): boolean {
  const shift = BigInt(128 - r.bits)
  return ip >> shift === r.base >> shift
}

function intToV4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

export type IpVerdict = { blocked: false } | { blocked: true; range: string }

export function classifyIp(ip: string): IpVerdict {
  const family = isIP(ip.replace(/^\[|\]$/g, '').split('%')[0])
  if (family === 4) {
    const n = v4ToInt(ip)
    const hit = V4_BLOCKED.find((r) => inV4(n, r))
    return hit ? { blocked: true, range: hit.name } : { blocked: false }
  }
  if (family === 6) {
    const n = v6ToBigInt(ip)
    for (const r of V6_RANGES) {
      if (!inV6(n, r)) continue
      if (r.embedsV4) {
        const embedded = r.embedsV4 === 'low32' ? Number(n & 0xffffffffn) : Number((n >> 80n) & 0xffffffffn)
        const inner = classifyIp(intToV4(embedded))
        return inner.blocked ? { blocked: true, range: `${r.name} → ${inner.range}` } : { blocked: false }
      }
      return { blocked: true, range: r.name }
    }
    return { blocked: false }
  }
  return { blocked: true, range: 'not an IP address' }
}

export interface ParsedTarget {
  url: URL
  /** Hostname without IPv6 brackets. */
  hostname: string
  port: number
  isIpLiteral: boolean
}

export function parseTarget(raw: string, opts: { allowHttp: boolean }): ParsedTarget {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfError('invalid_url', 'Not a valid absolute URL')
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new SsrfError('invalid_url', opts.allowHttp ? 'Only http and https URLs are allowed' : 'Only https URLs are allowed')
  }
  if (url.username || url.password) throw new SsrfError('invalid_url', 'Credentials in the URL are not allowed')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname) throw new SsrfError('invalid_url', 'URL has no host')
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return { url, hostname, port, isIpLiteral: isIP(hostname) !== 0 }
}

const BLOCKED_NAMES = [/^localhost$/, /\.localhost$/, /\.internal$/, /\.local$/, /^metadata$/]

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>

export interface ResolvedTarget extends ParsedTarget {
  ip: string
  family: 4 | 6
  allowlisted: boolean
}

function hostKey(host: string, port: number): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`
}

/**
 * Parses, resolves and vets a delivery URL. Call this immediately before
 * connecting, on every attempt, and connect to the returned `ip`.
 */
export async function resolveTarget(raw: string, opts: { allowHttp: boolean; allowlist: string[]; lookup: LookupFn }): Promise<ResolvedTarget> {
  const target = parseTarget(raw, opts)
  const allow = new Set(opts.allowlist.map((a) => a.toLowerCase()))
  const nameAllowed = allow.has(hostKey(target.hostname, target.port))

  if (target.isIpLiteral) {
    const verdict = classifyIp(target.hostname)
    if (verdict.blocked && !nameAllowed) throw new SsrfError('ssrf_blocked', `${target.hostname} is in a blocked range (${verdict.range})`)
    return { ...target, ip: target.hostname, family: isIP(target.hostname) as 4 | 6, allowlisted: nameAllowed }
  }

  if (!nameAllowed && BLOCKED_NAMES.some((re) => re.test(target.hostname))) {
    throw new SsrfError('ssrf_blocked', `${target.hostname} is an internal name`)
  }

  let addresses: { address: string; family: number }[]
  try {
    addresses = await opts.lookup(target.hostname)
  } catch (err) {
    throw new SsrfError('dns_error', `DNS lookup failed for ${target.hostname}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`)
  }
  if (addresses.length === 0) throw new SsrfError('dns_error', `${target.hostname} has no addresses`)

  for (const a of addresses) {
    const verdict = classifyIp(a.address)
    if (verdict.blocked && !nameAllowed && !allow.has(hostKey(a.address, target.port))) {
      throw new SsrfError('ssrf_blocked', `${target.hostname} resolves to ${a.address} (${verdict.range})`)
    }
  }
  // Prefer IPv4 when both families are present: the local mock receiver binds IPv4.
  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0]
  return { ...target, ip: chosen.address, family: chosen.family as 4 | 6, allowlisted: nameAllowed }
}
