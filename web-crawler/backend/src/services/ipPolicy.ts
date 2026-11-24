/**
 * @fileoverview Per-IP politeness exemptions (CDN ranges).
 *
 * The per-IP lock protects a shared host serving many domains. But large CDNs
 * serve thousands of *unrelated* sites from shared anycast IPs, and a per-IP
 * limit would throttle all of them as though they were one server. IPs in an
 * exempt range skip the per-IP lock; per-domain politeness still applies.
 *
 * Exempt ranges come from two places:
 * - `CRAWLER_IP_EXEMPT_CIDRS`: a static list in the environment
 * - `CRAWLER_IP_EXEMPT_SOURCES`: URLs of published CDN range lists (plain text
 *   or JSON). The API's maintenance loop fetches them every
 *   `ipExemptRefreshHours` into one Redis SET per source. A failed fetch keeps
 *   the source's last good list, so a CDN's endpoint being down doesn't
 *   suddenly re-throttle every site behind it.
 *
 * No ranges are shipped as defaults: CDN ranges change, and a stale or wrong
 * range silently removes protection from real servers. Configure the
 * providers' own published lists instead.
 *
 * Workers check membership with Node's built-in `net.BlockList`, rebuilt from
 * env + Redis at most every 60s per process.
 *
 * @module services/ipPolicy
 */

import crypto from 'crypto';
import net from 'node:net';
import axios from 'axios';
import { redis, REDIS_KEYS } from '../models/redis.js';
import { config } from '../config.js';
import { logger } from '../shared/logger.js';

/** How long a worker reuses its compiled BlockList before re-reading Redis. */
const LOCAL_CACHE_MS = 60_000;
/** Largest list we'll accept from a source (AWS's full ip-ranges.json is ~1.5 MB). */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export interface Cidr {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/**
 * Parses and validates one CIDR ("1.2.3.0/24", "2001:db8::/32"). A bare
 * address is treated as a single-host range (/32 or /128).
 */
export function parseCidr(raw: string): Cidr | null {
  const [address, prefixStr, extra] = raw.trim().split('/');
  if (extra !== undefined || !address) return null;
  const version = net.isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  const prefix = prefixStr === undefined ? max : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (prefixStr ?? '').trim() !== (prefixStr ?? '')) {
    return null;
  }
  return { address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
}

/** Matches CIDR-looking tokens in arbitrary text (validated afterwards). */
const CIDR_TOKEN = /[0-9a-fA-F:.]+\/\d{1,3}/g;

/**
 * Extracts every valid CIDR from a published list. Handles plain text (one per
 * line, comments allowed) and JSON (e.g. Fastly's {"addresses": [...],
 * "ipv6_addresses": [...]}) by scanning for CIDR-shaped tokens.
 */
export function parseCidrList(body: string): string[] {
  const found = new Set<string>();
  for (const token of body.match(CIDR_TOKEN) ?? []) {
    const cidr = parseCidr(token);
    if (cidr) found.add(`${cidr.address}/${cidr.prefix}`);
  }
  return [...found];
}

/**
 * Compiles CIDR strings into a BlockList (invalid entries are skipped and logged).
 */
export function buildBlockList(cidrs: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const raw of cidrs) {
    const cidr = parseCidr(raw);
    if (!cidr) {
      logger.warn({ cidr: raw }, 'Ignoring invalid exempt CIDR');
      continue;
    }
    list.addSubnet(cidr.address, cidr.prefix, cidr.family);
  }
  return list;
}

function sourceId(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}

let localCache: { list: net.BlockList; count: number; loadedAt: number } | null = null;

/**
 * Builds the effective exempt list from env + every configured source's last
 * good fetch in Redis.
 */
async function loadEffective(): Promise<{ list: net.BlockList; cidrs: string[] }> {
  const fromSources =
    config.crawler.ipExemptSources.length > 0
      ? await redis.sunion(...config.crawler.ipExemptSources.map((u) => REDIS_KEYS.IP_EXEMPT_SOURCE(sourceId(u))))
      : [];
  const cidrs = [...new Set([...config.crawler.ipExemptCidrs, ...fromSources])];
  return { list: buildBlockList(cidrs), cidrs };
}

/**
 * True if `ip` is in an exempt range and should skip the per-IP lock.
 */
export async function isIpExempt(ip: string): Promise<boolean> {
  if (config.crawler.ipExemptCidrs.length === 0 && config.crawler.ipExemptSources.length === 0) {
    return false;
  }
  if (!localCache || Date.now() - localCache.loadedAt > LOCAL_CACHE_MS) {
    const { list, cidrs } = await loadEffective();
    localCache = { list, count: cidrs.length, loadedAt: Date.now() };
  }
  const family = net.isIP(ip);
  if (family === 0) return false;
  return localCache.list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Drops the per-process cache (tests, or after an admin-triggered refresh). */
export function invalidateLocalCache(): void {
  localCache = null;
}

export interface SourceStatus {
  url: string;
  count: number;
  fetchedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/**
 * Fetches every configured source and replaces its Redis SET on success.
 * A failure records the error but keeps the previous list.
 */
export async function refreshSources(): Promise<SourceStatus[]> {
  const results: SourceStatus[] = [];
  for (const url of config.crawler.ipExemptSources) {
    const id = sourceId(url);
    const metaKey = REDIS_KEYS.IP_EXEMPT_META(id);
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        maxContentLength: MAX_SOURCE_BYTES,
        responseType: 'text',
        transformResponse: (data) => data, // keep raw text even for JSON
        headers: { 'User-Agent': config.crawler.userAgent },
      });
      const cidrs = parseCidrList(String(response.data ?? ''));
      if (cidrs.length === 0) throw new Error('No valid CIDRs in response');

      const tx = redis.multi();
      tx.del(REDIS_KEYS.IP_EXEMPT_SOURCE(id));
      tx.sadd(REDIS_KEYS.IP_EXEMPT_SOURCE(id), ...cidrs);
      tx.hset(metaKey, { url, count: cidrs.length, fetchedAt: new Date().toISOString(), lastError: '' });
      await tx.exec();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ url, err: message }, 'Exempt-range source fetch failed; keeping previous list');
      await redis.hset(metaKey, { url, lastError: message.slice(0, 300), lastErrorAt: new Date().toISOString() });
    }
    results.push(await getSourceStatus(url));
  }
  await redis.set(REDIS_KEYS.IP_EXEMPT_REFRESHED_AT, Date.now().toString());
  invalidateLocalCache();
  return results;
}

/**
 * Refreshes sources if the last refresh is older than `ipExemptRefreshHours`.
 * Called by the maintenance loop every interval; cheap when nothing is due.
 */
export async function refreshSourcesIfDue(): Promise<boolean> {
  if (config.crawler.ipExemptSources.length === 0) return false;
  const last = Number(await redis.get(REDIS_KEYS.IP_EXEMPT_REFRESHED_AT)) || 0;
  if (Date.now() - last < config.crawler.ipExemptRefreshHours * 3600_000) return false;
  await refreshSources();
  return true;
}

async function getSourceStatus(url: string): Promise<SourceStatus> {
  const meta = await redis.hgetall(REDIS_KEYS.IP_EXEMPT_META(sourceId(url)));
  return {
    url,
    count: Number(meta.count) || 0,
    fetchedAt: meta.fetchedAt || null,
    lastError: meta.lastError || null,
    lastErrorAt: meta.lastErrorAt || null,
  };
}

/**
 * Snapshot for the admin API / dashboard.
 */
export async function getPolicy(): Promise<{
  ipDelayMs: number;
  staticCidrs: string[];
  sources: SourceStatus[];
  effectiveCount: number;
  refreshHours: number;
}> {
  const { cidrs } = await loadEffective();
  return {
    ipDelayMs: config.crawler.ipDelayMs,
    staticCidrs: config.crawler.ipExemptCidrs,
    sources: await Promise.all(config.crawler.ipExemptSources.map(getSourceStatus)),
    effectiveCount: cidrs.length,
    refreshHours: config.crawler.ipExemptRefreshHours,
  };
}
