/**
 * The live view of connected SDK clients and the snapshot version each holds.
 *
 * SDKs report the version they have applied (after each update and every 15 s).
 * The first report of a new version is the moment that version reached the
 * client, so (report time − publish time) is the propagation latency the
 * console shows next to each client, and the kill-switch measurement.
 *
 * Two hashes per environment, each with a single writer per field, so a report
 * and a stream (dis)connect arriving at the same moment can't overwrite each other:
 *   exp:clients:<env>  what the SDK reported (version, source, last update)
 *   exp:streams:<env>  SSE connection state, written by the stream route
 * @module services/client-registry
 */
import { keys, redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { propagationSeconds } from '../shared/metrics.js'

interface ReportState {
  sdkInstanceId: string
  label: string
  heldVersion: number
  source: string
  transport: 'sse' | 'poll'
  reportedVia: string
  firstSeenAt: number
  lastSeenAt: number
  lastUpdate: { version: number; latencyMs: number | null; reason: string | null; at: number } | null
}

interface StreamState {
  sdkInstanceId: string
  /** The connection that wrote this state; a late close from an older connection must not mark a reconnected client offline. */
  connId: string
  label: string
  apiInstance: string
  connected: boolean
  connectedAt: number
  lastSeenAt: number
}

export interface ClientState {
  sdkInstanceId: string
  label: string
  environment: string
  apiInstance: string
  transport: 'sse' | 'poll'
  connected: boolean
  heldVersion: number
  source: string
  connectedAt: number
  lastSeenAt: number
  /** Propagation of the last version change this client reported. */
  lastUpdate: ReportState['lastUpdate']
}

export interface ClientReport {
  sdkInstanceId: string
  label?: string
  version: number
  source?: string
  transport?: 'sse' | 'poll'
}

async function readJson<T>(key: string, field: string): Promise<T | null> {
  const raw = await redis.hget(key, field)
  return raw ? (JSON.parse(raw) as T) : null
}

export async function reportClient(environment: string, report: ClientReport, apiInstance: string, now = Date.now()): Promise<ReportState> {
  const prev = await readJson<ReportState>(keys.clients(environment), report.sdkInstanceId)
  let lastUpdate = prev?.lastUpdate ?? null
  if (!prev || prev.heldVersion !== report.version) {
    const raw = await redis.get(keys.snapshotPublishedAt(environment, report.version))
    const meta = raw ? (JSON.parse(raw) as { at: number; reason: string }) : null
    // Only a change seen while running is a propagation sample; a cold start that
    // fetches an hours-old version measures nothing.
    const latencyMs = prev && meta ? Math.max(0, now - meta.at) : null
    if (latencyMs !== null) propagationSeconds.observe({ environment, reason: meta?.reason === 'kill_switch' ? 'kill_switch' : 'change' }, latencyMs / 1000)
    lastUpdate = { version: report.version, latencyMs, reason: meta?.reason ?? null, at: now }
  }
  const state: ReportState = {
    sdkInstanceId: report.sdkInstanceId,
    label: report.label ?? prev?.label ?? report.sdkInstanceId,
    heldVersion: report.version,
    source: report.source ?? prev?.source ?? 'network',
    transport: report.transport ?? prev?.transport ?? 'poll',
    reportedVia: apiInstance,
    firstSeenAt: prev?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastUpdate,
  }
  await redis.hset(keys.clients(environment), report.sdkInstanceId, JSON.stringify(state))
  return state
}

/** Called by the SSE route on connect and disconnect. */
export async function markStream(environment: string, sdkInstanceId: string, label: string, apiInstance: string, connected: boolean, connId: string): Promise<void> {
  const now = Date.now()
  const prev = await readJson<StreamState>(keys.streams(environment), sdkInstanceId)
  if (!connected && prev && prev.connId !== connId) return // the client already reconnected elsewhere
  const state: StreamState = {
    sdkInstanceId,
    connId,
    label: label || prev?.label || sdkInstanceId,
    apiInstance,
    connected,
    connectedAt: connected ? now : (prev?.connectedAt ?? now),
    lastSeenAt: now,
  }
  await redis.hset(keys.streams(environment), sdkInstanceId, JSON.stringify(state))
}

/** Clients seen within the TTL (stale entries are deleted as they are found). */
export async function listClients(environment: string, now = Date.now()): Promise<ClientState[]> {
  const [reports, streams] = await Promise.all([redis.hgetall(keys.clients(environment)), redis.hgetall(keys.streams(environment))])
  const ttlMs = config.clientTtlSeconds * 1000
  const live: ClientState[] = []
  const staleReports: string[] = []
  const staleStreams: string[] = []
  for (const [id, raw] of Object.entries(streams)) {
    const s = JSON.parse(raw) as StreamState
    if (!s.connected && now - s.lastSeenAt > ttlMs) staleStreams.push(id)
  }
  for (const [id, raw] of Object.entries(reports)) {
    const r = JSON.parse(raw) as ReportState
    const s = streams[id] ? (JSON.parse(streams[id]) as StreamState) : null
    const connected = s?.connected ?? false
    // A connected stream keeps a client listed even between its 15 s reports.
    if (!connected && now - r.lastSeenAt > ttlMs) {
      staleReports.push(id)
      continue
    }
    live.push({
      sdkInstanceId: id,
      label: r.label,
      environment,
      apiInstance: s?.connected ? s.apiInstance : r.reportedVia,
      transport: connected ? 'sse' : r.transport,
      connected,
      heldVersion: r.heldVersion,
      source: r.source,
      connectedAt: s?.connectedAt ?? r.firstSeenAt,
      lastSeenAt: Math.max(r.lastSeenAt, s?.lastSeenAt ?? 0),
      lastUpdate: r.lastUpdate,
    })
  }
  if (staleReports.length > 0) await redis.hdel(keys.clients(environment), ...staleReports)
  if (staleStreams.length > 0) await redis.hdel(keys.streams(environment), ...staleStreams)
  return live.sort((a, b) => a.label.localeCompare(b.label))
}
