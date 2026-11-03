/**
 * One event stream per browser tab, multiplexed: each API instance holds a
 * single Valkey pattern subscription and routes messages to its local
 * connections, instead of one Valkey connection per open stream.
 *
 * A connection only receives an org's events while its user is a member of
 * that org. Membership is loaded at connect, updated by access.revoked /
 * membership.added, and re-checked against PostgreSQL on every heartbeat in
 * case a pub/sub message was lost.
 */
import type { Response } from 'express'
import type { Redis } from 'ioredis'
import { loadSession } from '../../shared/auth.js'
import { createRedisConnection } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import type { UserEvent } from '../../shared/events.js'
import { logger } from '../../shared/logger.js'
import { sseConnections } from '../../shared/metrics.js'
import { writeSse, writeSseComment } from '../../shared/sse.js'

export interface Connection {
  id: number
  userId: string
  sessionId: string
  orgIds: Set<string>
  res: Pick<Response, 'write' | 'end'>
  closed: boolean
}

export class EventHub {
  private byUser = new Map<string, Set<Connection>>()
  private byOrg = new Map<string, Set<Connection>>()
  private subscriber: Redis | null = null
  private nextId = 1

  constructor(private readonly subscribe: () => Redis = () => createRedisConnection('event-hub')) {}

  get size(): number {
    let n = 0
    for (const set of this.byUser.values()) n += set.size
    return n
  }

  private ensureSubscribed(): void {
    if (this.subscriber) return
    this.subscriber = this.subscribe()
    this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => this.dispatch(channel, message))
    void this.subscriber.psubscribe('evt:org:*', 'evt:user:*').catch((err: Error) => {
      logger.error({ err: err.message }, 'event hub subscribe failed')
    })
  }

  add(userId: string, sessionId: string, orgIds: string[], res: Connection['res']): Connection {
    this.ensureSubscribed()
    const conn: Connection = { id: this.nextId++, userId, sessionId, orgIds: new Set(), res, closed: false }
    this.index(this.byUser, userId, conn)
    for (const orgId of orgIds) this.joinOrg(conn, orgId)
    sseConnections.set(this.size)
    return conn
  }

  remove(conn: Connection): void {
    if (conn.closed) return
    conn.closed = true
    this.unindex(this.byUser, conn.userId, conn)
    for (const orgId of conn.orgIds) this.unindex(this.byOrg, orgId, conn)
    conn.orgIds.clear()
    sseConnections.set(this.size)
  }

  joinOrg(conn: Connection, orgId: string): void {
    conn.orgIds.add(orgId)
    this.index(this.byOrg, orgId, conn)
  }

  leaveOrg(conn: Connection, orgId: string): void {
    conn.orgIds.delete(orgId)
    this.unindex(this.byOrg, orgId, conn)
  }

  dispatch(channel: string, message: string): void {
    let event: { type: string; orgId?: string }
    try {
      event = JSON.parse(message)
    } catch {
      return
    }
    if (channel.startsWith('evt:org:')) {
      const orgId = channel.slice('evt:org:'.length)
      for (const conn of [...(this.byOrg.get(orgId) ?? [])]) this.send(conn, event)
      return
    }
    if (channel.startsWith('evt:user:')) {
      const userId = channel.slice('evt:user:'.length)
      for (const conn of [...(this.byUser.get(userId) ?? [])]) this.deliverUserEvent(conn, event as UserEvent)
    }
  }

  private deliverUserEvent(conn: Connection, event: UserEvent): void {
    if (event.type === 'access.revoked') this.leaveOrg(conn, event.orgId)
    if (event.type === 'membership.added') this.joinOrg(conn, event.orgId)
    // Events about an org the connection no longer belongs to are dropped (export progress after removal).
    if ('orgId' in event && event.type !== 'access.revoked' && !conn.orgIds.has(event.orgId)) return
    this.send(conn, event)
    if (event.type === 'session.revoked') this.close(conn)
  }

  send(conn: Connection, event: { type: string }): void {
    if (conn.closed) return
    try {
      writeSse(conn.res as Response, event.type, event)
    } catch {
      this.remove(conn)
    }
  }

  close(conn: Connection): void {
    this.remove(conn)
    try {
      conn.res.end()
    } catch {
      // already closed by the client
    }
  }

  /**
   * Backstop for lost pub/sub messages: the session must still exist, and any
   * org the user has left since connecting is revoked on this connection.
   */
  async reconcile(conn: Connection): Promise<void> {
    if (conn.closed) return
    const session = await loadSession(conn.sessionId)
    if (!session) {
      this.send(conn, { type: 'session.revoked', reason: 'signed_out' } as UserEvent)
      this.close(conn)
      return
    }
    const { rows } = await pool.query(
      `SELECT o.id, o.name, o.authz_version FROM org_memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1`,
      [conn.userId],
    )
    const current = new Set(rows.map((r) => r.id as string))
    for (const orgId of [...conn.orgIds]) {
      if (!current.has(orgId)) {
        this.leaveOrg(conn, orgId)
        this.send(conn, { type: 'access.revoked', orgId, orgName: '', reason: 'removed' } as UserEvent)
      }
    }
    for (const row of rows) if (!conn.orgIds.has(row.id)) this.joinOrg(conn, row.id)
    // Versions ride along on the heartbeat, so a missed authz.changed is caught within one interval.
    this.send(conn, { type: 'versions', orgs: rows.map((r) => ({ orgId: r.id, version: Number(r.authz_version) })) } as {
      type: string
    })
  }

  startHeartbeat(conn: Connection): NodeJS.Timeout {
    return setInterval(() => {
      if (conn.closed) return
      try {
        writeSseComment(conn.res as Response, 'ping')
      } catch {
        this.remove(conn)
        return
      }
      this.reconcile(conn).catch((err: Error) => logger.warn({ err: err.message }, 'stream reconcile failed'))
    }, config.sseHeartbeatMs)
  }

  async shutdown(): Promise<void> {
    for (const set of this.byUser.values()) for (const conn of [...set]) this.close(conn)
    await this.subscriber?.quit().catch(() => undefined)
    this.subscriber = null
  }

  private index(map: Map<string, Set<Connection>>, key: string, conn: Connection): void {
    let set = map.get(key)
    if (!set) map.set(key, (set = new Set()))
    set.add(conn)
  }

  private unindex(map: Map<string, Set<Connection>>, key: string, conn: Connection): void {
    const set = map.get(key)
    if (!set) return
    set.delete(conn)
    if (set.size === 0) map.delete(key)
  }
}

export const eventHub = new EventHub()
