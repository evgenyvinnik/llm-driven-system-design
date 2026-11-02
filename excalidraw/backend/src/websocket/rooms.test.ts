import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('../services/drawingService.js', () => ({
  getDrawing: vi.fn(),
  updateDrawing: vi.fn(),
  hasAccess: vi.fn(),
}));
vi.mock('../services/presenceService.js', () => ({
  removeCursor: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/logger.js', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getDrawing, updateDrawing, hasAccess } from '../services/drawingService.js';
import {
  getOrLoadRoom,
  getRoom,
  leaveRoom,
  markDirty,
  mergeHttpSave,
  refreshRoomAccess,
  flushAllRooms,
  type ClientInfo,
} from './rooms.js';
import { applyOperation, type CrdtElement } from '../services/crdtService.js';
import { isValidElement } from './handler.js';

const el = (id: string, version: number, extra: Partial<CrdtElement> = {}): CrdtElement => ({
  id,
  type: 'rectangle',
  version,
  updatedAt: 1000 + version,
  isDeleted: false,
  x: 0,
  y: 0,
  ...extra,
});

let nextDrawing = 0;
const drawingId = () => `00000000-0000-4000-8000-${String(++nextDrawing).padStart(12, '0')}`;

const fakeClient = (overrides: Partial<ClientInfo> = {}): ClientInfo & { sent: Record<string, unknown>[] } => {
  const sent: Record<string, unknown>[] = [];
  return {
    ws: { readyState: WebSocket.OPEN, send: (m: string) => sent.push(JSON.parse(m)) } as unknown as WebSocket,
    clientId: `c-${Math.random()}`,
    userId: 'user-1',
    username: 'alice',
    color: '#000',
    drawingId: null,
    canEdit: true,
    sent,
    ...overrides,
  };
};

const join = async (id: string, client: ClientInfo) => {
  const room = await getOrLoadRoom(id);
  client.drawingId = id;
  room.clients.add(client);
  return room;
};

beforeEach(() => {
  vi.mocked(getDrawing).mockReset().mockResolvedValue({ elements: [el('seed', 1)], is_public: false } as never);
  vi.mocked(updateDrawing).mockReset().mockResolvedValue({ id: 'saved' } as never);
  vi.mocked(hasAccess).mockReset().mockResolvedValue({ canView: true, canEdit: true, isOwner: false });
});

afterEach(async () => {
  vi.useRealTimers();
  await flushAllRooms();
});

describe('room loading', () => {
  it('loads a drawing once for concurrent joins', async () => {
    const id = drawingId();
    const [a, b] = await Promise.all([getOrLoadRoom(id), getOrLoadRoom(id)]);
    expect(a).toBe(b);
    expect(getDrawing).toHaveBeenCalledTimes(1);
    expect(a.elements.map((e) => e.id)).toEqual(['seed']);
  });
});

describe('debounced persistence', () => {
  it('coalesces a burst of edits into one save after the quiet period', async () => {
    vi.useFakeTimers();
    const id = drawingId();
    const room = await join(id, fakeClient());
    for (let i = 0; i < 5; i++) {
      room.elements = applyOperation(room.elements, { type: 'add', elementId: `e${i}`, elementData: el(`e${i}`, 1) });
      markDirty(room);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(updateDrawing).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateDrawing).toHaveBeenCalledTimes(1);
    expect((vi.mocked(updateDrawing).mock.calls[0][1].elements as CrdtElement[]).length).toBe(6);
  });

  it('still saves within the max wait while edits never pause', async () => {
    vi.useFakeTimers();
    const id = drawingId();
    const room = await join(id, fakeClient());
    for (let i = 0; i < 12; i++) {
      markDirty(room);
      await vi.advanceTimersByTimeAsync(1000); // always inside the 2s quiet period
    }
    expect(updateDrawing).toHaveBeenCalledTimes(1);
  });

  it('keeps changes and retries when a save fails', async () => {
    vi.useFakeTimers();
    vi.mocked(updateDrawing).mockRejectedValueOnce(new Error('db down'));
    const id = drawingId();
    const room = await join(id, fakeClient());
    markDirty(room);
    await vi.advanceTimersByTimeAsync(2000);
    expect(updateDrawing).toHaveBeenCalledTimes(1);
    expect(room.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(updateDrawing).toHaveBeenCalledTimes(2);
    expect(room.dirty).toBe(false);
  });
});

describe('leaving and rejoining', () => {
  it('saves the last state before releasing the room', async () => {
    const id = drawingId();
    const client = fakeClient();
    const room = await join(id, client);
    room.elements = [...room.elements, el('new', 1)];
    markDirty(room);
    leaveRoom(client);
    await flushAllRooms();
    expect(updateDrawing).toHaveBeenCalledWith(id, { elements: room.elements });
    expect(getRoom(id)).toBeUndefined();
  });

  it('reuses in-memory state when someone joins during the final save', async () => {
    const id = drawingId();
    let finishSave!: () => void;
    vi.mocked(updateDrawing).mockImplementationOnce(
      () => new Promise((resolve) => { finishSave = () => resolve({ id } as never); })
    );
    const first = fakeClient();
    const room = await join(id, first);
    room.elements = [...room.elements, el('unsaved', 1)];
    markDirty(room);
    leaveRoom(first); // final save starts and is still in flight

    const rejoined = await getOrLoadRoom(id);
    expect(rejoined).toBe(room);
    expect(rejoined.elements.some((e) => e.id === 'unsaved')).toBe(true);
    rejoined.clients.add(fakeClient({ drawingId: id }));
    finishSave();
    await flushAllRooms();
    expect(getRoom(id)).toBe(room); // occupied again, so not released
    expect(getDrawing).toHaveBeenCalledTimes(1); // never reloaded the older row
  });
});

describe('HTTP saves merge instead of replacing', () => {
  it('merges into a live room, keeps tombstones, and tells every client', async () => {
    const id = drawingId();
    const watcher = fakeClient();
    const room = await join(id, watcher);
    room.elements = [el('kept', 3), el('gone', 2, { isDeleted: true })];

    const merged = await mergeHttpSave(id, [el('kept', 2, { x: 99 }), el('gone', 1), el('added', 1)]);

    const byId = Object.fromEntries(merged!.map((e) => [e.id, e]));
    expect(byId.kept.version).toBe(3); // stale tab loses
    expect(byId.gone.isDeleted).toBe(true); // tombstone survives
    expect(byId.added).toBeDefined();
    expect(watcher.sent.some((m) => m.type === 'elements-sync')).toBe(true);
    expect(updateDrawing).toHaveBeenCalledWith(id, { elements: merged });
  });

  it('merges with the stored row when nobody has the drawing open', async () => {
    const id = drawingId();
    vi.mocked(getDrawing).mockResolvedValueOnce({ elements: [el('a', 5)], is_public: false } as never);
    const merged = await mergeHttpSave(id, [el('a', 4), el('b', 1)]);
    expect(merged!.map((e) => [e.id, e.version])).toEqual([['a', 5], ['b', 1]]);
  });
});

describe('access changes reach open sockets', () => {
  it('downgrades an editor and removes a revoked viewer', async () => {
    const id = drawingId();
    const editor = fakeClient({ userId: 'editor' });
    const revoked = fakeClient({ userId: 'revoked' });
    await join(id, editor);
    await join(id, revoked);
    vi.mocked(hasAccess).mockImplementation(async (_d, userId) =>
      userId === 'editor'
        ? { canView: true, canEdit: false, isOwner: false }
        : { canView: false, canEdit: false, isOwner: false }
    );

    await refreshRoomAccess(id);

    expect(editor.canEdit).toBe(false);
    expect(editor.sent).toContainEqual({ type: 'permission-changed', drawingId: id, canEdit: false });
    expect(revoked.drawingId).toBeNull();
    expect(revoked.sent.some((m) => m.type === 'access-revoked')).toBe(true);
    expect(getRoom(id)!.clients.has(revoked)).toBe(false);
  });
});

describe('element rules', () => {
  it('does not let a replayed add resurrect a deleted element', () => {
    const deleted = applyOperation([el('x', 1)], { type: 'delete', elementId: 'x' });
    const replayed = applyOperation(deleted, { type: 'add', elementId: 'x', elementData: el('x', 1) });
    expect(replayed[0].isDeleted).toBe(true);
  });

  it('breaks equal-version update ties by time, not arrival', () => {
    const current = [el('x', 2, { updatedAt: 2000, x: 1 })];
    const older = applyOperation(current, { type: 'update', elementId: 'x', elementData: el('x', 2, { updatedAt: 1500, x: 2 }) });
    expect(older[0].x).toBe(1);
  });

  it('rejects malformed elements', () => {
    expect(isValidElement(el('ok', 1))).toBe(true);
    expect(isValidElement({ ...el('bad', 1), type: 'script' })).toBe(false);
    expect(isValidElement({ ...el('bad', 1), version: 'NaN' })).toBe(false);
    expect(isValidElement({ id: 'x' })).toBe(false);
  });
});
