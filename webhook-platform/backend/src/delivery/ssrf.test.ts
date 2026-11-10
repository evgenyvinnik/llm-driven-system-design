import { describe, expect, it } from 'vitest'
import { classifyIp, resolveTarget, SsrfError, v6ToBigInt, type LookupFn } from './ssrf.js'

const fakeDns =
  (table: Record<string, string[]>): LookupFn =>
  async (host) => {
    const ips = table[host]
    if (!ips) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
    return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }

const base = { allowHttp: true, allowlist: ['localhost:3300', '127.0.0.1:3300'] }

async function blockedReason(url: string, dns: Record<string, string[]> = {}) {
  try {
    await resolveTarget(url, { ...base, lookup: fakeDns(dns) })
    return 'allowed'
  } catch (err) {
    return (err as SsrfError).errorClass
  }
}

describe('classifyIp', () => {
  it.each([
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['10.1.2.3', 'private'],
    ['172.20.0.1', 'private'],
    ['192.168.1.10', 'private'],
    ['127.0.0.1', 'loopback'],
    ['100.100.100.200', 'cgnat'],
    ['0.0.0.0', 'this-network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved / broadcast'],
  ])('blocks IPv4 %s (%s)', (ip, range) => {
    expect(classifyIp(ip)).toEqual({ blocked: true, range })
  })

  it.each(['::1', '::', 'fe80::1', 'fd00:ec2::254', 'fc00::5', 'ff02::1', '2001:db8::1'])('blocks IPv6 %s', (ip) => {
    expect(classifyIp(ip).blocked).toBe(true)
  })

  it('unwraps IPv4-mapped IPv6 in both text forms', () => {
    expect(classifyIp('::ffff:127.0.0.1')).toMatchObject({ blocked: true })
    expect(classifyIp('::ffff:7f00:1')).toMatchObject({ blocked: true })
    expect(classifyIp('::ffff:a9fe:a9fe')).toEqual({ blocked: true, range: 'ipv4-mapped → link-local / cloud metadata' })
    expect(classifyIp('::ffff:8.8.8.8')).toEqual({ blocked: false })
  })

  it('unwraps NAT64 and 6to4 wrappers', () => {
    expect(classifyIp('64:ff9b::a00:1').blocked).toBe(true) // 10.0.0.1
    expect(classifyIp('2002:a9fe:a9fe::1').blocked).toBe(true) // 169.254.169.254
    expect(classifyIp('2002:0808:0808::1').blocked).toBe(false) // 8.8.8.8
  })

  it('allows public addresses', () => {
    expect(classifyIp('93.184.215.14')).toEqual({ blocked: false })
    expect(classifyIp('2606:4700:4700::1111')).toEqual({ blocked: false })
  })

  it('expands IPv6 text forms consistently', () => {
    expect(v6ToBigInt('::1')).toBe(1n)
    expect(v6ToBigInt('[::ffff:127.0.0.1]')).toBe(v6ToBigInt('::ffff:7f00:1'))
  })
})

describe('resolveTarget', () => {
  it('blocks the cloud metadata service, private ranges and loopback on non-allowlisted ports', async () => {
    expect(await blockedReason('http://169.254.169.254/latest/meta-data/')).toBe('ssrf_blocked')
    expect(await blockedReason('http://10.0.0.8:8080/hook')).toBe('ssrf_blocked')
    expect(await blockedReason('http://127.0.0.1:5432/')).toBe('ssrf_blocked')
    expect(await blockedReason('http://[::1]:3300/')).toBe('ssrf_blocked')
    expect(await blockedReason('http://[::ffff:169.254.169.254]/')).toBe('ssrf_blocked')
  })

  it('normalises sneaky IPv4 spellings before checking (WHATWG URL parsing)', async () => {
    expect(await blockedReason('http://2130706433/')).toBe('ssrf_blocked') // 127.0.0.1 as an integer
    expect(await blockedReason('http://0x7f.1/')).toBe('ssrf_blocked')
    expect(await blockedReason('http://0251.0376.0251.0376/')).toBe('ssrf_blocked') // 169.254.169.254 in octal
  })

  it('blocks a public-looking name that resolves to a private IP', async () => {
    expect(await blockedReason('https://hooks.attacker.example/x', { 'hooks.attacker.example': ['10.0.0.5'] })).toBe('ssrf_blocked')
  })

  it('blocks when ANY resolved address is private, not just the first', async () => {
    expect(await blockedReason('https://mixed.example/x', { 'mixed.example': ['93.184.215.14', '169.254.169.254'] })).toBe('ssrf_blocked')
  })

  it('blocks internal names before resolving them', async () => {
    expect(await blockedReason('http://metadata.google.internal/', { 'metadata.google.internal': ['169.254.169.254'] })).toBe('ssrf_blocked')
    expect(await blockedReason('http://localhost:6379/')).toBe('ssrf_blocked')
  })

  it('lets the allowlisted mock receiver through, and only on its port', async () => {
    const ok = await resolveTarget('http://localhost:3300/hooks/a', { ...base, lookup: fakeDns({ localhost: ['127.0.0.1'] }) })
    expect(ok).toMatchObject({ ip: '127.0.0.1', port: 3300, allowlisted: true })
    expect(await blockedReason('http://127.0.0.1:3300/hooks/a')).toBe('allowed')
    expect(await blockedReason('http://127.0.0.1:3301/hooks/a')).toBe('ssrf_blocked')
  })

  it('returns the vetted public IP to connect to', async () => {
    const r = await resolveTarget('https://hooks.customer.example/in', { ...base, lookup: fakeDns({ 'hooks.customer.example': ['2606:4700::1', '93.184.215.14'] }) })
    expect(r).toMatchObject({ ip: '93.184.215.14', family: 4, hostname: 'hooks.customer.example', port: 443 })
  })

  it('rejects invalid URLs, credentials and non-http schemes', async () => {
    expect(await blockedReason('not a url')).toBe('invalid_url')
    expect(await blockedReason('ftp://example.com/')).toBe('invalid_url')
    expect(await blockedReason('file:///etc/passwd')).toBe('invalid_url')
    expect(await blockedReason('https://user:pw@example.com/')).toBe('invalid_url')
    await expect(resolveTarget('http://example.com/', { allowHttp: false, allowlist: [], lookup: fakeDns({}) })).rejects.toMatchObject({ errorClass: 'invalid_url' })
  })

  it('reports DNS failures as dns_error (retryable), not as blocked', async () => {
    expect(await blockedReason('https://nxdomain.example/')).toBe('dns_error')
  })
})
