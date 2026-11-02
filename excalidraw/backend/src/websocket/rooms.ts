import { WebSocket } from 'ws';
import logger from '../services/logger.js';
import { getDrawing, updateDrawing, hasAccess } from '../services/drawingService.js';
import { mergeElements, type CrdtElement } from '../services/crdtService.js';
import { removeCursor } from '../services/presenceService.js';

/** One WebSocket connection. Identity comes from the session at upgrade time. */
export interface ClientInfo {
  ws: WebSocket;
  /** Per-connection ID, so two tabs of one account are distinct participants. */
  clientId: string;
  /** Null for an anonymous viewer of a public drawing. */
  userId: string | null;
  username: string;
  color: string;
  drawingId: string | null;
  canEdit: boolean;
}

/**
 * A live drawing: the connected clients and the merged element list, which is
 * the newest state of the drawing (Postgres lags it by at most one debounce).
 */
export interface Room {
  drawingId: string;
  clients: Set<ClientInfo>;
  elements: CrdtElement[];
  dirty: boolean;
  firstDirtyAt: number | null;
  timer: NodeJS.Timeout | null;
}

export interface Access {
  canView: boolean;
  canEdit: boolean;
}

/** Quiet period before a save. */
const SAVE_DEBOUNCE_MS = 2000;
/** Continuous editing still saves at least this often. */
const SAVE_MAX_WAIT_MS = 10000;
/** Backoff before retrying a failed save. */
const SAVE_RETRY_MS = 5000;

const rooms = new Map<string, Room>();
const roomLoads = new Map<string, Promise<Room>>();
const writeChains = new Map<string, Promise<void>>();

/**
 * Runs work for one drawing strictly after any earlier work for it. Room
 * flushes, HTTP saves and room loads all go through here, so an older snapshot
 * can never land after a newer one and a room never loads a half-written row.
 */
export function withDrawingLock<T>(drawingId: string, work: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(drawingId) ?? Promise.resolve();
  const result = previous.then(() => work());
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  writeChains.set(drawingId, tail);
  void tail.then(() => {
    if (writeChains.get(drawingId) === tail) writeChains.delete(drawingId);
  });
  return result;
}

/** What a user (or an anonymous viewer, userId null) may do with a drawing right now. */
export async function resolveAccess(drawingId: string, userId: string | null): Promise<Access> {
  if (userId) {
    const access = await hasAccess(drawingId, userId);
    return { canView: access.canView, canEdit: access.canEdit };
  }
  const drawing = await getDrawing(drawingId);
  return { canView: Boolean(drawing?.is_public), canEdit: false };
}

export function getRoom(drawingId: string): Room | undefined {
  return rooms.get(drawingId);
}

/**
 * Returns the live room, loading it from Postgres if nobody has it open. A room
 * whose last client just left stays in memory until its final save commits, so
 * a join during that window reuses the newer in-memory state instead of
 * reading the older row.
 */
export function getOrLoadRoom(drawingId: string): Promise<Room> {
  const existing = rooms.get(drawingId);
  if (existing) return Promise.resolve(existing);

  let loading = roomLoads.get(drawingId);
  if (!loading) {
    loading = withDrawingLock(drawingId, async () => {
      const already = rooms.get(drawingId);
      if (already) return already;
      const drawing = await getDrawing(drawingId);
      const room: Room = {
        drawingId,
        clients: new Set(),
        elements: (drawing?.elements ?? []) as CrdtElement[],
        dirty: false,
        firstDirtyAt: null,
        timer: null,
      };
      rooms.set(drawingId, room);
      return room;
    }).finally(() => roomLoads.delete(drawingId));
    roomLoads.set(drawingId, loading);
  }
  return loading;
}

export function send(client: ClientInfo, message: Record<string, unknown>): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(message));
  }
}

export function broadcast(room: Room, message: Record<string, unknown>, exclude?: ClientInfo): void {
  const data = JSON.stringify(message);
  for (const client of room.clients) {
    if (client !== exclude && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

/**
 * Schedules a save. Each edit restarts the quiet-period timer, but never past
 * SAVE_MAX_WAIT_MS after the first unsaved edit: a room with continuous
 * drawing used to postpone its save indefinitely.
 */
export function markDirty(room: Room): void {
  const now = Date.now();
  room.dirty = true;
  room.firstDirtyAt ??= now;
  if (room.timer) clearTimeout(room.timer);
  const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, room.firstDirtyAt + SAVE_MAX_WAIT_MS - now));
  room.timer = setTimeout(() => {
    room.timer = null;
    void flushRoom(room);
  }, wait);
}

/**
 * Writes the room's elements if they changed. Saves for one drawing are
 * serialized, and the snapshot is taken when the save starts, so a slow save
 * cannot overwrite a newer one. A failed save keeps the room dirty and retries;
 * nothing is dropped. An empty, clean room is released after its save.
 */
export function flushRoom(room: Room): Promise<void> {
  return withDrawingLock(room.drawingId, async () => {
    if (room.dirty) {
      if (room.timer) {
        clearTimeout(room.timer);
        room.timer = null;
      }
      // Element arrays are replaced, never mutated, so this snapshot is stable.
      const snapshot = room.elements;
      room.dirty = false;
      room.firstDirtyAt = null;
      try {
        const saved = await updateDrawing(room.drawingId, { elements: snapshot });
        if (!saved) {
          logger.warn({ drawingId: room.drawingId }, 'Drawing no longer exists; room changes dropped');
        } else {
          logger.debug({ drawingId: room.drawingId, elements: snapshot.length }, 'Drawing saved');
        }
      } catch (error) {
        logger.error(
          { error: (error as Error).message, drawingId: room.drawingId },
          'Failed to save drawing; will retry'
        );
        room.dirty = true;
        room.firstDirtyAt ??= Date.now();
        if (!room.timer) {
          room.timer = setTimeout(() => {
            room.timer = null;
            void flushRoom(room);
          }, SAVE_RETRY_MS);
        }
        return;
      }
    }

    if (room.clients.size === 0 && !room.dirty && rooms.get(room.drawingId) === room) {
      if (room.timer) clearTimeout(room.timer);
      rooms.delete(room.drawingId);
    }
  });
}

/** Removes a client from its room; the last one out triggers the final save and release. */
export function leaveRoom(client: ClientInfo): void {
  const drawingId = client.drawingId;
  client.drawingId = null;
  client.canEdit = false;
  if (!drawingId) return;

  const room = rooms.get(drawingId);
  if (!room || !room.clients.delete(client)) return;

  if (client.userId) {
    removeCursor(drawingId, client.clientId).catch(() => {});
  }
  broadcast(room, {
    type: 'user-left',
    clientId: client.clientId,
    userId: client.userId,
    username: client.username,
  });
  logger.info({ drawingId, userId: client.userId }, 'User left room');

  if (room.clients.size === 0) {
    void flushRoom(room);
  }
}

/**
 * Merges elements saved over HTTP using the same last-writer-wins rule as
 * socket edits, so there is one merge authority instead of two writers.
 * With the drawing open, the merge lands in the room, everyone (including
 * the saver) receives the merged list, and the room saves it. Otherwise the
 * stored elements are merged under the drawing lock. Tombstones survive
 * either way, so a save from a stale tab cannot resurrect deleted shapes.
 */
export async function mergeHttpSave(
  drawingId: string,
  incoming: CrdtElement[]
): Promise<CrdtElement[] | null> {
  const room = rooms.get(drawingId);
  if (room) {
    room.elements = mergeElements(room.elements, incoming);
    broadcast(room, { type: 'elements-sync', elements: room.elements });
    markDirty(room);
    await flushRoom(room);
    return room.elements;
  }

  return withDrawingLock(drawingId, async () => {
    const current = await getDrawing(drawingId);
    if (!current) return null;
    const merged = mergeElements((current.elements ?? []) as CrdtElement[], incoming);
    await updateDrawing(drawingId, { elements: merged });
    return merged;
  });
}

/**
 * Re-checks every connected client's access after sharing or visibility
 * changes: revoked viewers are removed from the room, and edit rights take
 * effect on live sockets immediately instead of at the next join.
 */
export async function refreshRoomAccess(drawingId: string): Promise<void> {
  const room = rooms.get(drawingId);
  if (!room) return;

  for (const client of [...room.clients]) {
    const access = await resolveAccess(drawingId, client.userId);
    if (client.drawingId !== drawingId) continue;
    if (!access.canView) {
      send(client, { type: 'access-revoked', drawingId });
      leaveRoom(client);
    } else if (access.canEdit !== client.canEdit) {
      client.canEdit = access.canEdit;
      send(client, { type: 'permission-changed', drawingId, canEdit: access.canEdit });
    }
  }
}

/** Disconnects everyone from a deleted drawing and discards its unsaved state. */
export function closeRoom(drawingId: string): void {
  const room = rooms.get(drawingId);
  if (!room) return;
  if (room.timer) clearTimeout(room.timer);
  room.dirty = false;
  rooms.delete(drawingId);
  for (const client of room.clients) {
    client.drawingId = null;
    client.canEdit = false;
    send(client, { type: 'access-revoked', drawingId, reason: 'deleted' });
  }
  room.clients.clear();
}

/** Saves every room with unsaved changes. Called on shutdown. */
export async function flushAllRooms(): Promise<void> {
  await Promise.all([...rooms.values()].map((room) => flushRoom(room)));
}
