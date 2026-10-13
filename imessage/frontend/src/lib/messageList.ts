import type { Message, MessageStatus } from '@/types';

/**
 * Pure helpers for one conversation's message list.
 *
 * Delivery is at-least-once: the same message can arrive as a live push, in a
 * sync batch after reconnect, and in a REST page. These helpers make applying
 * any of them idempotent (dedupe by server ID and by client ID) and keep the
 * list in the server's order (seq), never in arrival order.
 */

const STATUS_RANK: Record<MessageStatus, number> = {
  failed: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

/** Confirmed messages sort by seq; optimistic ones (no seq yet) stay last, in send order. */
export function compareMessages(a: Message, b: Message): number {
  const aSeq = a.seq ?? Number.POSITIVE_INFINITY;
  const bSeq = b.seq ?? Number.POSITIVE_INFINITY;
  if (aSeq !== bSeq) return aSeq - bSeq;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

/** Picks the more advanced status, so a late "delivered" cannot overwrite "read". */
export function laterStatus(
  current: MessageStatus | null | undefined,
  incoming: MessageStatus | null | undefined
): MessageStatus | null | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  return STATUS_RANK[incoming] >= STATUS_RANK[current] ? incoming : current;
}

/**
 * Inserts or merges one message. Matches an existing entry by server ID, or by
 * client ID so the server's ack replaces the optimistic bubble instead of
 * adding a second one. A deleted message is removed. Returns a new array.
 */
export function upsertMessage(list: Message[], incoming: Message): Message[] {
  const clientId = incoming.clientMessageId ?? incoming.client_message_id ?? undefined;
  const index = list.findIndex(
    (m) => m.id === incoming.id || (clientId !== undefined && m.clientMessageId === clientId)
  );

  if (incoming.deleted_at) {
    return index >= 0 ? list.filter((_, i) => i !== index) : list;
  }

  const next = [...list];
  if (index >= 0) {
    const current = list[index];
    next[index] = { ...current, ...incoming, status: laterStatus(current.status, incoming.status) };
  } else {
    next.push(incoming);
  }
  return next.sort(compareMessages);
}

/** Applies a batch (sync or REST page) with the same rules as single messages. */
export function mergeMessages(list: Message[], incoming: Message[]): Message[] {
  return incoming.reduce(upsertMessage, list);
}

/** Marks the user's own messages in this list as delivered. */
export function markDelivered(list: Message[], messageIds: string[], ownUserId: string): Message[] {
  const ids = new Set(messageIds);
  let changed = false;
  const next = list.map((m) => {
    if (!ids.has(m.id) || m.sender_id !== ownUserId) return m;
    const status = laterStatus(m.status, 'delivered');
    if (status === m.status) return m;
    changed = true;
    return { ...m, status };
  });
  return changed ? next : list;
}

/** Marks the user's own messages at or below a recipient's read watermark as read. */
export function markReadUpTo(list: Message[], seq: number, ownUserId: string): Message[] {
  let changed = false;
  const next = list.map((m) => {
    if (m.sender_id !== ownUserId || m.seq === undefined || m.seq > seq) return m;
    const status = laterStatus(m.status, 'read');
    if (status === m.status) return m;
    changed = true;
    return { ...m, status };
  });
  return changed ? next : list;
}

/** Highest server seq in the list, or 0 when nothing is confirmed yet. */
export function highestSeq(list: Message[]): number {
  return list.reduce((max, m) => (m.seq !== undefined && m.seq > max ? m.seq : max), 0);
}

/**
 * True when a live message skips seqs this client has not seen: something
 * was missed (a dropped pub/sub event, a reconnect race) and should be
 * pulled. Without a known baseline there is nothing to compare against.
 */
export function hasGap(knownMaxSeq: number, incomingSeq: number | undefined): boolean {
  return knownMaxSeq > 0 && incomingSeq !== undefined && incomingSeq > knownMaxSeq + 1;
}
