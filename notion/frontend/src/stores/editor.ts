/**
 * @fileoverview Editor state for the open page, and the client half of the
 * sync protocol.
 *
 * Server state arrives two ways: a snapshot (GET /api/pages/:id, together with
 * the operation seq it reflects) and committed operations pushed over the
 * WebSocket, each carrying the page's next seq. Operations are applied strictly
 * in seq order; a gap means a message was missed, so the store asks the server
 * to replay from its log. Replays and live messages may overlap, so anything at
 * or below the last applied seq is ignored.
 *
 * Local edits are optimistic. Each block has a save queue: edits made while a
 * request is in flight are coalesced into one follow-up request (one write per
 * block at a time, so a slow request can never land after a newer one), and
 * every write carries the version it was based on. A 409 means someone else
 * changed the block first: the store takes the server's block, re-applies the
 * fields this user changed and retries, which is field-level last-writer-wins
 * that is detected rather than silent. Network errors keep the edit and retry
 * with backoff.
 */

import { create } from 'zustand';
import type { Block, BlockType, Operation, PermissionLevel, Presence, RichText } from '@/types';
import { ApiError, blocksApi, pagesApi } from '@/services/api';
import { wsService } from '@/services/websocket';
import { generateKeyBetween } from '@/utils/fractionalIndex';
import { v4 as fallbackUuid } from './uuid';

/** Fields a user edits in place; everything else changes through operations. */
type EditableFields = Partial<Pick<Block, 'type' | 'content' | 'properties' | 'is_collapsed'>>;

/** Typing is saved after this pause (and at most one request per block is in flight). */
const SAVE_DEBOUNCE_MS = 300;
const MAX_CONFLICT_RETRIES = 5;

type SaveState = 'saved' | 'saving' | 'offline' | 'error';

/**
 * Editor state interface.
 */
interface EditorState {
  pageId: string | null;
  blocks: Block[];
  /** Highest operation seq applied; the next live operation must be lastSeq + 1. */
  lastSeq: number;
  permission: PermissionLevel;
  saveState: SaveState;
  selectedBlockId: string | null;
  focusedBlockId: string | null;
  presence: Presence[];

  loadSnapshot: (pageId: string, blocks: Block[], seq: number, permission: PermissionLevel) => void;
  addBlock: (
    pageId: string,
    type: BlockType,
    afterBlockId?: string,
    parentBlockId?: string | null,
    content?: RichText[]
  ) => Promise<Block>;
  updateBlock: (blockId: string, updates: EditableFields) => Promise<void>;
  deleteBlock: (blockId: string) => Promise<void>;
  moveBlock: (blockId: string, parentBlockId?: string | null, afterBlockId?: string) => Promise<void>;
  setSelectedBlock: (blockId: string | null) => void;
  setFocusedBlock: (blockId: string | null) => void;

  // Real-time
  receiveOperation: (operation: Operation) => void;
  receiveSync: (operations: Operation[], headSeq: number) => void;
  requestCatchUp: () => void;
  resync: () => Promise<void>;
  setPresence: (presence: Presence[]) => void;
  addPresence: (presence: Presence) => void;
  removePresence: (userId: string) => void;
  updatePresencePosition: (userId: string, cursorPosition?: { block_id: string; offset: number }) => void;
}

/** Per-block save queue (module state: it holds timers and in-flight flags). */
interface SaveQueue {
  /** False until the server confirmed the optimistic create. */
  created: boolean;
  inFlight: boolean;
  /** Edited fields not yet sent. */
  pending: EditableFields;
  /** Fields in the request currently in flight. */
  sending: EditableFields | null;
  /** Server version the next write is based on (sent as expected_version). */
  baseVersion: number;
  deleted: boolean;
  attempts: number;
  timer: number | null;
}

const queues = new Map<string, SaveQueue>();
let catchUpTimer: number | null = null;

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
}

function sortBlocks(blocks: Block[]): Block[] {
  return [...blocks].sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
}

function hasFields(fields: EditableFields | null | undefined): boolean {
  return !!fields && Object.keys(fields).length > 0;
}

/** Fields this user changed that the server has not confirmed yet. */
function unconfirmedFields(blockId: string): EditableFields {
  const queue = queues.get(blockId);
  return queue ? { ...queue.sending, ...queue.pending } : {};
}

function queueFor(block: Block): SaveQueue {
  let queue = queues.get(block.id);
  if (!queue) {
    queue = {
      created: true,
      inFlight: false,
      pending: {},
      sending: null,
      baseVersion: block.version,
      deleted: false,
      attempts: 0,
      timer: null,
    };
    queues.set(block.id, queue);
  }
  return queue;
}

function dropQueue(blockId: string): void {
  const queue = queues.get(blockId);
  if (queue?.timer) clearTimeout(queue.timer);
  queues.delete(blockId);
}

/** Ids of a block and everything nested under it. */
function subtreeIds(blocks: Block[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const block of blocks) {
      if (block.parent_block_id && ids.has(block.parent_block_id) && !ids.has(block.id)) {
        ids.add(block.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * Editor store for managing block content and real-time collaboration.
 */
export const useEditorStore = create<EditorState>((set, get) => {
  /** Puts a server version of a block on screen, keeping unconfirmed local edits on top. */
  const applyServerBlock = (server: Block) => {
    set((state) => {
      const current = state.blocks.find((b) => b.id === server.id);
      if (current && current.version > server.version) return {}; // already newer
      const merged = { ...server, ...unconfirmedFields(server.id) };
      const blocks = current
        ? state.blocks.map((b) => (b.id === server.id ? merged : b))
        : [...state.blocks, merged];
      return { blocks: sortBlocks(blocks) };
    });
  };

  const removeSubtree = (blockId: string) => {
    set((state) => {
      const ids = subtreeIds(state.blocks, blockId);
      ids.forEach(dropQueue);
      return {
        blocks: state.blocks.filter((b) => !ids.has(b.id)),
        focusedBlockId: state.focusedBlockId && ids.has(state.focusedBlockId) ? null : state.focusedBlockId,
        selectedBlockId: state.selectedBlockId && ids.has(state.selectedBlockId) ? null : state.selectedBlockId,
      };
    });
  };

  const refreshSaveState = () => {
    const busy = [...queues.values()].some((q) => q.inFlight || hasFields(q.pending));
    if (!busy && get().saveState === 'saving') set({ saveState: 'saved' });
  };

  const scheduleFlush = (blockId: string, delay: number) => {
    const queue = queues.get(blockId);
    if (!queue) return;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = window.setTimeout(() => {
      queue.timer = null;
      void flush(blockId);
    }, delay);
  };

  /** Sends a block's pending fields, one request at a time per block. */
  const flush = async (blockId: string): Promise<void> => {
    const queue = queues.get(blockId);
    if (!queue || queue.inFlight || !queue.created || queue.deleted || !hasFields(queue.pending)) return;

    queue.sending = queue.pending;
    queue.pending = {};
    queue.inFlight = true;
    set({ saveState: 'saving' });

    let retryDelay: number | null = null;
    try {
      const { block } = await blocksApi.update(blockId, {
        ...queue.sending,
        expected_version: queue.baseVersion,
      });
      queue.sending = null;
      queue.attempts = 0;
      queue.baseVersion = block.version;
      applyServerBlock(block);
    } catch (error) {
      const fields = queue.sending ?? {};
      queue.sending = null;
      if (error instanceof ApiError && error.status === 409 && error.body.block) {
        // Someone else saved first: rebase our fields onto their version.
        const server = error.body.block as Block;
        queue.baseVersion = server.version;
        queue.pending = { ...fields, ...queue.pending };
        applyServerBlock(server);
        queue.attempts++;
        if (queue.attempts > MAX_CONFLICT_RETRIES) {
          queue.pending = {};
          set({ saveState: 'error' });
        } else {
          retryDelay = 0;
        }
      } else if (error instanceof ApiError && error.status === 404) {
        removeSubtree(blockId); // deleted by someone else
      } else if (error instanceof ApiError && error.status < 500) {
        // Not retryable (for example view-only access): drop the edit, reload.
        queue.pending = {};
        set({ saveState: 'error' });
        void get().resync();
      } else {
        // Network or server error: keep the edit and retry with backoff.
        queue.pending = { ...fields, ...queue.pending };
        queue.attempts++;
        retryDelay = Math.min(1000 * 2 ** queue.attempts, 15_000);
        set({ saveState: 'offline' });
      }
    } finally {
      queue.inFlight = false;
    }

    if (queues.get(blockId) === queue && hasFields(queue.pending)) {
      scheduleFlush(blockId, retryDelay ?? 0);
    }
    refreshSaveState();
  };

  /** Applies one committed operation (already known to be the next seq). */
  const applyOperation = (op: Operation) => {
    if (op.type === 'delete') {
      removeSubtree(op.block_id);
      return;
    }
    if (!op.block) return;
    const queue = queues.get(op.block_id);
    if (queue && !queue.inFlight && op.block.version > queue.baseVersion) {
      // The user has now seen this version; base the next save on it.
      queue.baseVersion = op.block.version;
    }
    applyServerBlock(op.block);
  };

  return {
    pageId: null,
    blocks: [],
    lastSeq: 0,
    permission: 'edit',
    saveState: 'saved',
    selectedBlockId: null,
    focusedBlockId: null,
    presence: [],

    loadSnapshot: (pageId, blocks, seq, permission) => {
      if (get().pageId !== pageId) {
        queues.forEach((_, id) => dropQueue(id));
      }
      set({
        pageId,
        blocks: sortBlocks(blocks.map((b) => ({ ...b, ...unconfirmedFields(b.id) }))),
        lastSeq: seq,
        permission,
        saveState: 'saved',
      });
    },

    addBlock: async (pageId, type, afterBlockId, parentBlockId, content) => {
      const { blocks } = get();
      const after = afterBlockId ? blocks.find((b) => b.id === afterBlockId) : undefined;
      const parentId = after ? after.parent_block_id : (parentBlockId ?? null);
      const siblings = blocks.filter((b) => b.parent_block_id === parentId);
      const index = after ? siblings.findIndex((b) => b.id === after.id) : siblings.length - 1;

      // Optimistic position where the server will most likely put it.
      let position: string;
      try {
        position = generateKeyBetween(siblings[index]?.position ?? null, siblings[index + 1]?.position ?? null);
      } catch {
        position = `${siblings[index]?.position ?? ''}n`;
      }

      const id = newId();
      const now = new Date().toISOString();
      const optimistic: Block = {
        id,
        page_id: pageId,
        parent_block_id: parentId,
        type,
        properties: {},
        content: content || [],
        position,
        version: 0,
        is_collapsed: false,
        created_by: null,
        created_at: now,
        updated_at: now,
      };
      const queue = queueFor(optimistic);
      queue.created = false;
      queue.inFlight = true;
      set((state) => ({ blocks: sortBlocks([...state.blocks, optimistic]), focusedBlockId: id }));

      // The id is ours, so retrying after a timeout can never create a duplicate.
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { block } = await blocksApi.create({
            id,
            page_id: pageId,
            type,
            parent_block_id: parentId,
            content: content || [],
            after_block_id: afterBlockId,
          });
          queue.created = true;
          queue.inFlight = false;
          queue.baseVersion = block.version;
          applyServerBlock(block);
          if (queue.deleted) {
            await get().deleteBlock(id);
          } else if (hasFields(queue.pending)) {
            scheduleFlush(id, 0);
          }
          return block;
        } catch (error) {
          lastError = error;
          if (error instanceof ApiError) break; // the server answered: retrying will not help
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }

      dropQueue(id);
      set((state) => ({ blocks: state.blocks.filter((b) => b.id !== id) }));
      throw lastError;
    },

    updateBlock: async (blockId, updates) => {
      const current = get().blocks.find((b) => b.id === blockId);
      if (!current) return;
      const fields: EditableFields = {};
      if (updates.type !== undefined) fields.type = updates.type;
      if (updates.content !== undefined) fields.content = updates.content;
      if (updates.properties !== undefined) fields.properties = updates.properties;
      if (updates.is_collapsed !== undefined) fields.is_collapsed = updates.is_collapsed;
      if (!hasFields(fields)) return;

      set((state) => ({
        blocks: state.blocks.map((b) => (b.id === blockId ? { ...b, ...fields } : b)),
      }));
      const queue = queueFor(current);
      queue.pending = { ...queue.pending, ...fields };
      scheduleFlush(blockId, SAVE_DEBOUNCE_MS);
    },

    deleteBlock: async (blockId) => {
      const queue = queues.get(blockId);
      if (queue && !queue.created) {
        queue.deleted = true; // the create is still in flight; delete when it lands
        set((state) => ({ blocks: state.blocks.filter((b) => b.id !== blockId) }));
        return;
      }
      removeSubtree(blockId);
      try {
        await blocksApi.delete(blockId);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) {
          void get().resync();
          throw error;
        }
      }
    },

    moveBlock: async (blockId, parentBlockId, afterBlockId) => {
      try {
        const { block } = await blocksApi.move(blockId, parentBlockId, afterBlockId);
        const queue = queues.get(blockId);
        if (queue && !queue.inFlight) queue.baseVersion = block.version;
        applyServerBlock(block);
      } catch (error) {
        void get().resync();
        throw error;
      }
    },

    setSelectedBlock: (blockId) => {
      set({ selectedBlockId: blockId });
    },

    setFocusedBlock: (blockId) => {
      set({ focusedBlockId: blockId });
      if (blockId) {
        wsService.updatePresence({ block_id: blockId, offset: 0 });
      }
    },

    receiveOperation: (op) => {
      const { pageId, lastSeq } = get();
      if (op.page_id !== pageId || op.seq <= lastSeq) return; // other page or already applied
      if (op.seq > lastSeq + 1) {
        get().requestCatchUp(); // we missed something: replay it from the log
        return;
      }
      applyOperation(op);
      set({ lastSeq: op.seq });
    },

    receiveSync: (operations, headSeq) => {
      if (catchUpTimer) {
        clearTimeout(catchUpTimer);
        catchUpTimer = null;
      }
      for (const op of operations) {
        const { pageId, lastSeq } = get();
        if (op.page_id !== pageId || op.seq <= lastSeq) continue;
        if (op.seq !== lastSeq + 1) break;
        applyOperation(op);
        set({ lastSeq: op.seq });
      }
      if (get().lastSeq < headSeq) get().requestCatchUp();
    },

    requestCatchUp: () => {
      const { pageId, lastSeq } = get();
      if (!pageId || catchUpTimer) return;
      wsService.requestSync(pageId, lastSeq);
      // If the answer is lost, allow another request after a few seconds.
      catchUpTimer = window.setTimeout(() => {
        catchUpTimer = null;
      }, 5_000);
    },

    resync: async () => {
      const { pageId } = get();
      if (!pageId) return;
      try {
        const data = await pagesApi.get(pageId);
        if (get().pageId !== pageId) return;
        get().loadSnapshot(pageId, data.blocks, data.seq, data.permission);
        if (catchUpTimer) {
          clearTimeout(catchUpTimer);
          catchUpTimer = null;
        }
        get().requestCatchUp(); // the snapshot may come from cache: replay after it
      } catch (error) {
        console.error('Failed to reload page:', error);
      }
    },

    setPresence: (presence) => {
      set({ presence });
    },

    addPresence: (newPresence) => {
      set((state) => ({
        presence: [...state.presence.filter((p) => p.user_id !== newPresence.user_id), newPresence],
      }));
    },

    removePresence: (userId) => {
      set((state) => ({
        presence: state.presence.filter((p) => p.user_id !== userId),
      }));
    },

    updatePresencePosition: (userId, cursorPosition) => {
      set((state) => ({
        presence: state.presence.map((p) =>
          p.user_id === userId ? { ...p, cursor_position: cursorPosition } : p
        ),
      }));
    },
  };
});
