import type { Message, Reaction } from '../types';

/** The message lists a channel event can touch. */
export interface MessageLists {
  messages: Message[];
  threadMessages: Message[];
  threadParentId: string | null;
}

/** Fills the fields an event or API payload may omit. */
export function withDefaults(message: Message): Message {
  return { ...message, reactions: message.reactions ?? [], reply_count: message.reply_count ?? 0 };
}

/** Confirmed messages in seq order, then unconfirmed (optimistic) ones in the order they were sent. */
function ordered(list: Message[]): Message[] {
  const confirmed = list.filter((m) => !m.status).sort((a, b) => a.seq - b.seq);
  return [...confirmed, ...list.filter((m) => m.status)];
}

/**
 * Inserts a message, or replaces the optimistic copy that has the same clientMessageId. A message
 * that is already confirmed is left alone: the REST response and the stream event for one send can
 * arrive in either order, and whichever comes second must be a no-op.
 */
export function upsertMessage(list: Message[], incoming: Message): Message[] {
  if (list.some((m) => m.id === incoming.id && !m.status)) return list;
  const key = incoming.client_message_id;
  const index = key ? list.findIndex((m) => m.status && m.client_message_id === key) : -1;
  if (index === -1) return ordered([...list, incoming]);
  return ordered(list.map((m, i) => (i === index ? incoming : m)));
}

/** Adds a page of older history in front of what is loaded, skipping anything already present. */
export function mergeOlder(list: Message[], older: Message[]): Message[] {
  const known = new Set(list.map((m) => m.id));
  return ordered([...older.filter((m) => !known.has(m.id)), ...list]);
}

/**
 * Reactions are applied as a set of usernames per emoji, so applying the same change twice (an
 * optimistic toggle followed by its own stream event) is a no-op instead of a double count.
 */
export function applyReaction(message: Message, emoji: string, username: string, added: boolean): Message {
  const existing = message.reactions.find((r) => r.emoji === emoji);
  if (added === (existing?.users.includes(username) ?? false)) return message;

  let reactions: Reaction[];
  if (added && existing) {
    reactions = message.reactions.map((r) =>
      r.emoji === emoji ? { ...r, count: r.count + 1, users: [...r.users, username] } : r,
    );
  } else if (added) {
    reactions = [...message.reactions, { emoji, count: 1, users: [username] }];
  } else {
    reactions = message.reactions
      .map((r) =>
        r.emoji === emoji
          ? { ...r, count: r.count - 1, users: r.users.filter((u) => u !== username) }
          : r,
      )
      .filter((r) => r.count > 0);
  }
  return { ...message, reactions };
}

function updateEverywhere(
  state: MessageLists,
  id: string,
  update: (message: Message) => Message,
): Pick<MessageLists, 'messages' | 'threadMessages'> {
  return {
    messages: state.messages.map((m) => (m.id === id ? update(m) : m)),
    threadMessages: state.threadMessages.map((m) => (m.id === id ? update(m) : m)),
  };
}

/** Applies one channel stream event. Callers apply each seq once, in order. */
export function applyChannelEvent(
  state: MessageLists,
  type: string,
  payload: Record<string, unknown>,
): Partial<MessageLists> {
  switch (type) {
    case 'new_message': {
      const message = withDefaults(payload as unknown as Message);
      if (!message.parent_message_id) return { messages: upsertMessage(state.messages, message) };
      // A thread reply: it stays out of the channel view, bumps its root's count, and joins the
      // thread panel if that thread is open.
      return {
        messages: state.messages.map((m) =>
          m.id === message.parent_message_id ? { ...m, reply_count: (m.reply_count ?? 0) + 1 } : m,
        ),
        threadMessages:
          state.threadParentId === message.parent_message_id
            ? upsertMessage(state.threadMessages, message)
            : state.threadMessages,
      };
    }
    case 'message_edited':
      return updateEverywhere(state, payload.id as string, (m) => ({
        ...m,
        content: payload.content as string,
        is_edited: true,
        updated_at: payload.updated_at as string,
      }));
    case 'message_deleted': {
      const lists = updateEverywhere(state, payload.id as string, (m) => ({
        ...m,
        content: '',
        deleted_at: payload.deleted_at as string,
        reactions: [],
      }));
      const parentId = payload.parent_message_id as string | null;
      if (!parentId) return lists;
      return {
        ...lists,
        messages: lists.messages.map((m) =>
          m.id === parentId ? { ...m, reply_count: Math.max(0, (m.reply_count ?? 0) - 1) } : m,
        ),
      };
    }
    case 'reaction_added':
    case 'reaction_removed':
      return updateEverywhere(state, payload.messageId as string, (m) =>
        applyReaction(m, payload.emoji as string, payload.username as string, type === 'reaction_added'),
      );
    default:
      return {};
  }
}
