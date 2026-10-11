import { Response } from 'express';
import { logger } from './logger.js';
import {
  pubsubPublishFailuresTotal,
  sseConnectionsGauge,
  sseEventsSentTotal,
  sseGapFillsTotal,
  sseReplayedEventsTotal,
  sseResyncsTotal,
} from './metrics.js';
import {
  getChannelHead,
  getChannelHeads,
  readChannelEvents,
  type ChannelEvent,
} from './channelEvents.js';
import { publishChannelEvent, subscribeToChannel, unsubscribeFromChannel } from './pubsub.js';

/** A client further behind than this reloads history instead of replaying event by event. */
export const MAX_REPLAY_EVENTS = 500;

/** A client with more unsent output than this is cut off; it reconnects and resumes by seq. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

interface SSEClient {
  res: Response;
  userId: string;
  /** Highest seq written to this client; null until its join (replay) has run. */
  lastSeq: number | null;
}

/**
 * What this instance knows about one channel. Joins and deliveries for a channel run one at a
 * time through `queue`, so no client receives an event twice, out of order, or interleaved with
 * its own replay.
 */
interface ChannelStream {
  channelId: string;
  clients: Set<SSEClient>;
  /** Highest seq delivered to this channel's clients on this instance. */
  lastSeq: number | null;
  queue: Promise<void>;
  /** The SUBSCRIBE issued when the stream was created. */
  subscribed: Promise<void>;
}

const streams = new Map<string, ChannelStream>();

function enqueue(stream: ChannelStream, task: () => Promise<void>): Promise<void> {
  const run = stream.queue.then(task);
  stream.queue = run.catch((err) => {
    logger.error({ err, channelId: stream.channelId }, 'SSE stream task failed');
  });
  return run;
}

function send(client: SSEClient, frame: string): void {
  client.res.write(frame);
  if (client.res.writableLength > MAX_BUFFERED_BYTES) {
    // Buffering for a consumer this slow would grow without bound. Cut it off; EventSource
    // reconnects with Last-Event-ID and the replay below catches it up from the log.
    logger.warn({ userId: client.userId }, 'Dropping slow SSE client');
    client.res.end();
  }
}

function writeEvent(client: SSEClient, event: ChannelEvent): void {
  send(client, `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  client.lastSeq = event.seq;
  sseEventsSentTotal.inc();
}

/** Tells a client its gap cannot be replayed, so it must reload history and reconnect. */
function writeResync(client: SSEClient, reason: string, head: number): void {
  // No id field: the client's position only moves once it has reloaded.
  send(client, `event: resync\ndata: ${JSON.stringify({ reason, latestSeq: head })}\n\n`);
  client.lastSeq = head;
  sseResyncsTotal.inc({ reason });
}

function deliverToClients(stream: ChannelStream, event: ChannelEvent): void {
  for (const client of stream.clients) {
    if (client.lastSeq === null || event.seq <= client.lastSeq) continue;
    writeEvent(client, event);
  }
}

/** Brings every client of a stream up to `target`, reading whatever pub/sub has not delivered. */
async function catchUp(stream: ChannelStream, target: number): Promise<void> {
  if (stream.lastSeq === null) {
    stream.lastSeq = target;
    return;
  }
  const from = stream.lastSeq;
  if (target <= from) return;
  const events =
    target - from > MAX_REPLAY_EVENTS ? [] : await readChannelEvents(stream.channelId, from, target);
  if (events.length !== target - from) {
    // Too far behind, or part of the range was never logged: nobody can be caught up from here.
    for (const client of stream.clients) {
      if (client.lastSeq !== null) writeResync(client, 'history_unavailable', target);
    }
  } else {
    for (const event of events) deliverToClients(stream, event);
  }
  stream.lastSeq = target;
}

/** First task for every new client: bring the stream up to date, then replay what it missed. */
async function join(stream: ChannelStream, client: SSEClient, afterSeq: number | null): Promise<void> {
  await stream.subscribed;
  if (!stream.clients.has(client)) return;
  const head = await getChannelHead(stream.channelId);
  await catchUp(stream, head);
  if (!stream.clients.has(client)) return;
  const upto = Math.max(head, stream.lastSeq ?? head);

  if (afterSeq === null || afterSeq === upto) {
    client.lastSeq = upto;
  } else if (afterSeq > upto) {
    writeResync(client, 'ahead_of_server', upto);
  } else if (upto - afterSeq > MAX_REPLAY_EVENTS) {
    writeResync(client, 'too_far_behind', upto);
  } else {
    const events = await readChannelEvents(stream.channelId, afterSeq, upto);
    if (!stream.clients.has(client)) return;
    if (events.length !== upto - afterSeq) {
      writeResync(client, 'history_unavailable', upto);
    } else {
      for (const event of events) writeEvent(client, event);
      sseReplayedEventsTotal.inc(events.length);
    }
  }
}

function removeClient(stream: ChannelStream, client: SSEClient): void {
  if (!stream.clients.delete(client)) return;
  sseConnectionsGauge.dec();
  if (stream.clients.size > 0 || streams.get(stream.channelId) !== stream) return;
  streams.delete(stream.channelId);
  // Last local viewer left: stop receiving this channel's pub/sub traffic.
  unsubscribeFromChannel(stream.channelId).catch((err) => {
    logger.warn({ err, channelId: stream.channelId }, 'Pub/sub unsubscribe failed');
  });
}

/**
 * Registers an SSE response for a channel. The client first receives every event after
 * `afterSeq` from the log, then live events. `afterSeq` is the client's Last-Event-ID on an
 * automatic reconnect, or the `latestSeq` of the history page it just loaded; null means
 * "from now", which can miss events committed while the request was in flight.
 */
export function addClient(
  channelId: string,
  userId: string,
  res: Response,
  afterSeq: number | null,
): Promise<void> {
  let stream = streams.get(channelId);
  if (!stream) {
    stream = {
      channelId,
      clients: new Set(),
      lastSeq: null,
      queue: Promise.resolve(),
      // Subscribe before the first join reads the head, so no event falls between the two.
      subscribed: subscribeToChannel(channelId).catch((err) => {
        logger.warn({ err, channelId }, 'Pub/sub subscribe failed; relying on head checks');
      }),
    };
    streams.set(channelId, stream);
  }
  const owner = stream;
  const client: SSEClient = { res, userId, lastSeq: null };
  owner.clients.add(client);
  sseConnectionsGauge.inc();
  res.on('close', () => removeClient(owner, client));
  return enqueue(owner, () => join(owner, client, afterSeq));
}

/**
 * Hands an event to this instance's viewers of its channel. Called for every pub/sub message
 * and, directly, after local writes. Copies and stale events are dropped by seq; an event that
 * arrives ahead of its predecessors (two instances publishing in a race, or a lost publish)
 * triggers a read of the missing range from the log first.
 */
export function deliverChannelEvent(event: ChannelEvent): void {
  const stream = streams.get(event.channelId);
  if (!stream) return;
  enqueue(stream, async () => {
    if (stream.lastSeq === null || event.seq <= stream.lastSeq) return;
    if (event.seq > stream.lastSeq + 1) {
      sseGapFillsTotal.inc({ trigger: 'out_of_order' });
      await catchUp(stream, event.seq - 1);
      if (event.seq <= stream.lastSeq) return;
    }
    deliverToClients(stream, event);
    stream.lastSeq = event.seq;
  }).catch(() => {
    // Already logged by enqueue.
  });
}

/**
 * Fans an event out after its transaction has committed: local viewers get it directly, other
 * instances through Redis. Never throws. The event is durable in channel_events, so a failed
 * publish only delays delivery elsewhere until the next event exposes the gap or a head check runs.
 */
export async function broadcastChannelEvent(event: ChannelEvent): Promise<void> {
  deliverChannelEvent(event);
  try {
    await publishChannelEvent(event);
  } catch (err) {
    pubsubPublishFailuresTotal.inc();
    logger.warn(
      { err, channelId: event.channelId, seq: event.seq },
      'Pub/sub publish failed; other instances will catch up from the event log',
    );
  }
}

/**
 * Pub/sub loses messages during a Redis restart, or when a publisher dies between commit and
 * publish. With no further traffic in that channel nothing would reveal the gap, so each instance
 * periodically compares its streams with the committed heads (one query) and catches up.
 */
export async function checkHeads(): Promise<void> {
  if (streams.size === 0) return;
  const heads = await getChannelHeads([...streams.keys()]);
  for (const [channelId, head] of heads) {
    const stream = streams.get(channelId);
    if (!stream || stream.lastSeq === null || head <= stream.lastSeq) continue;
    sseGapFillsTotal.inc({ trigger: 'head_check' });
    enqueue(stream, () => catchUp(stream, head)).catch(() => {
      // Already logged by enqueue.
    });
  }
}

let headCheckTimer: NodeJS.Timeout | null = null;

export function startHeadChecks(intervalMs = 15_000): void {
  if (headCheckTimer) return;
  headCheckTimer = setInterval(() => {
    checkHeads().catch((err) => logger.warn({ err }, 'SSE head check failed'));
  }, intervalMs);
  headCheckTimer.unref();
}

export function stopHeadChecks(): void {
  if (headCheckTimer) clearInterval(headCheckTimer);
  headCheckTimer = null;
}

/** Ends every stream (graceful shutdown); clients reconnect elsewhere and resume by seq. */
export function closeAllStreams(): void {
  for (const stream of [...streams.values()]) {
    for (const client of [...stream.clients]) client.res.end();
  }
}

/** Counts for the health endpoint and tests. */
export function getStreamStats(): { channels: number; clients: number } {
  let clients = 0;
  for (const stream of streams.values()) clients += stream.clients.size;
  return { channels: streams.size, clients };
}
