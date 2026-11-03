/**
 * Valkey key names, in one place so every process (and the tests) agree.
 * @module shared/keys
 */
export const keys = {
  session: (id: string) => `session:${id}`,
  /** Dedup claim: value is the `partition:offset` of the Kafka message that claimed the event. */
  dedup: (eventId: string) => `dedup:${eventId}`,
  /** Highest offset per partition whose rows are already in ClickHouse. */
  insertedThrough: 'ingest:inserted-through',
  /** Offset range `first-last` per partition whose insert has started but not been recorded as done. */
  inflight: 'ingest:inflight',
  /** Per partition: `{ position, updatedAt }` used for the watermark. */
  positions: 'ingest:positions',
  counters: 'ingest:counters',
  /** Hash per org: local date → revision, bumped when late events land in that day. */
  revision: (orgId: string) => `rev:${orgId}`,
  query: (hash: string) => `q:${hash}`,
}
