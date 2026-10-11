import type pg from 'pg';
import { pool } from './db.js';

/** Event types a channel stream carries; the SSE `event:` field uses the same names. */
export type ChannelEventType =
  | 'new_message'
  | 'message_edited'
  | 'message_deleted'
  | 'reaction_added'
  | 'reaction_removed';

/** One entry in a channel's ordered event log. `seq` doubles as the SSE event id. */
export interface ChannelEvent {
  channelId: string;
  seq: number;
  type: ChannelEventType;
  payload: unknown;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<ChannelEventType>([
  'new_message',
  'message_edited',
  'message_deleted',
  'reaction_added',
  'reaction_removed',
]);

/** Shape check for events arriving over pub/sub, which is outside the type system. */
export function isChannelEvent(value: unknown): value is ChannelEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.channelId === 'string' &&
    Number.isSafeInteger(event.seq) &&
    (event.seq as number) > 0 &&
    typeof event.type === 'string' &&
    EVENT_TYPES.has(event.type)
  );
}

/**
 * Takes the next sequence number for a channel inside the caller's transaction. The channel row
 * stays locked until that transaction ends, which is what orders all writes to one channel.
 */
export async function nextChannelSeq(client: pg.PoolClient, channelId: string): Promise<number> {
  const { rows } = await client.query<{ seq: number }>('SELECT next_channel_seq($1) AS seq', [
    channelId,
  ]);
  return rows[0].seq;
}

/** Appends an event to the channel's log in the caller's transaction. */
export async function appendChannelEvent(
  client: pg.PoolClient,
  channelId: string,
  seq: number,
  type: ChannelEventType,
  payload: unknown,
): Promise<ChannelEvent> {
  await client.query(
    `INSERT INTO channel_events (channel_id, seq, event_type, payload) VALUES ($1, $2, $3, $4)`,
    [channelId, seq, type, JSON.stringify(payload)],
  );
  return { channelId, seq, type, payload };
}

/** Highest sequence number committed in a channel (0 when nothing has happened yet). */
export async function getChannelHead(channelId: string): Promise<number> {
  const { rows } = await pool.query<{ last_seq: number }>(
    'SELECT last_seq FROM channels WHERE id = $1',
    [channelId],
  );
  return rows[0]?.last_seq ?? 0;
}

/** Heads of several channels in one query; used by the periodic catch-up check. */
export async function getChannelHeads(channelIds: string[]): Promise<Map<string, number>> {
  const heads = new Map<string, number>();
  if (channelIds.length === 0) return heads;
  const { rows } = await pool.query<{ id: string; last_seq: number }>(
    'SELECT id, last_seq FROM channels WHERE id = ANY($1::uuid[])',
    [channelIds],
  );
  for (const row of rows) heads.set(row.id, row.last_seq);
  return heads;
}

/**
 * Events with afterSeq < seq <= uptoSeq, oldest first. Sequence numbers are gapless, so a result
 * shorter than `uptoSeq - afterSeq` means part of the range was never logged (seeded or hand-
 * inserted messages) or has been pruned, and the caller must fall back to a full reload.
 */
export async function readChannelEvents(
  channelId: string,
  afterSeq: number,
  uptoSeq: number,
): Promise<ChannelEvent[]> {
  const { rows } = await pool.query<{ seq: number; event_type: ChannelEventType; payload: unknown }>(
    `SELECT seq, event_type, payload FROM channel_events
     WHERE channel_id = $1 AND seq > $2 AND seq <= $3
     ORDER BY seq`,
    [channelId, afterSeq, uptoSeq],
  );
  return rows.map((row) => ({
    channelId,
    seq: row.seq,
    type: row.event_type,
    payload: row.payload,
  }));
}
