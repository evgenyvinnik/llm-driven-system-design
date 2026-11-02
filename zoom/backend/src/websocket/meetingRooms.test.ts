import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/db.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../services/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/metrics.js', () => ({
  activeMeetings: { inc: vi.fn(), dec: vi.fn() },
  activeParticipants: { inc: vi.fn(), dec: vi.fn() },
}));
vi.mock('../config/index.js', () => ({
  config: { ws: { reconnectGraceMs: 1000, emptyMeetingGraceMs: 5000, heartbeatIntervalMs: 30000, maxPayloadBytes: 65536 } },
}));
vi.mock('../services/meetingService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/meetingService.js')>();
  return {
    ...actual,
    getMeetingByCode: vi.fn(),
    autoStartMeeting: vi.fn().mockResolvedValue(undefined),
    upsertParticipant: vi.fn().mockResolvedValue({}),
    leaveMeeting: vi.fn().mockResolvedValue(null),
    endMeeting: vi.fn().mockResolvedValue({}),
    updateParticipantState: vi.fn().mockResolvedValue({}),
    setParticipantRole: vi.fn().mockResolvedValue({}),
    closeAllOpenAttendance: vi.fn().mockResolvedValue(0),
    getActiveMeetings: vi.fn().mockResolvedValue([]),
  };
});
vi.mock('../services/chatService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chatService.js')>();
  let n = 0;
  return {
    ...actual,
    saveMessage: vi.fn(async () => ({ id: `msg-${++n}`, created_at: new Date().toISOString() })),
  };
});

import * as rooms from './meetingRooms.js';
import type { ClientConn } from './meetingRooms.js';
import * as meetingService from '../services/meetingService.js';
import * as chatService from '../services/chatService.js';
import { activeParticipants } from '../services/metrics.js';
import { sfuService } from '../services/sfuService.js';

const ALICE = 'a0000000-0000-0000-0000-000000000001'; // organizer
const BOB = 'a0000000-0000-0000-0000-000000000002';
const CAROL = 'a0000000-0000-0000-0000-000000000003';
const DAVE = 'a0000000-0000-0000-0000-000000000004';
const MEETING = 'b0000000-0000-0000-0000-000000000001';
const CODE = 'abc-defg-hij';

type Sent = { type: string; [key: string]: unknown };
type FakeConn = ClientConn & { sent: Sent[]; closedWith?: number };

let connSeq = 0;
function conn(userId: string, username = userId.slice(-1)): FakeConn {
  const c: FakeConn = {
    connectionId: `c${++connSeq}`,
    userId,
    username,
    meetingId: null,
    waiting: false,
    closed: false,
    sent: [],
    send(message) {
      c.sent.push(message as Sent);
    },
    close(code) {
      c.closedWith = code;
    },
  };
  return c;
}

const last = (c: FakeConn, type: string) => [...c.sent].reverse().find((m) => m.type === type);
const count = (c: FakeConn, type: string) => c.sent.filter((m) => m.type === type).length;

const getMeetingByCode = vi.mocked(meetingService.getMeetingByCode);

function meetingRow(overrides: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  return {
    id: MEETING,
    meeting_code: CODE,
    title: 'Standup',
    host_id: ALICE,
    status: 'scheduled',
    settings: { waitingRoom: false, muteOnEntry: false, allowScreenShare: true, maxParticipants: 100, ...settings },
    ...overrides,
  };
}

async function join(c: FakeConn, extra: Record<string, unknown> = {}) {
  await rooms.joinMeeting(c, { meetingCode: CODE, displayName: c.username, ...extra });
  return c;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  rooms.resetLiveStateForTests();
  getMeetingByCode.mockResolvedValue(meetingRow());
});

afterEach(() => {
  rooms.resetLiveStateForTests();
  vi.useRealTimers();
});

describe('joining', () => {
  it('admits the organizer as host and others as participants, and tells the room', async () => {
    const alice = await join(conn(ALICE, 'Alice'));
    const bob = await join(conn(BOB, 'Bob'));

    expect(last(alice, 'joined')).toMatchObject({ role: 'host', hostId: ALICE });
    expect(last(bob, 'joined')).toMatchObject({ role: 'participant' });
    expect(last(alice, 'participant-joined')).toMatchObject({ participant: { userId: BOB, role: 'participant' } });
    await rooms.flushWritesForTests(MEETING);
    expect(meetingService.autoStartMeeting).toHaveBeenCalledWith(MEETING);
    expect(meetingService.upsertParticipant).toHaveBeenCalledWith(MEETING, BOB, expect.objectContaining({ role: 'participant' }));
  });

  it('rejects unknown codes, malformed codes and ended meetings', async () => {
    getMeetingByCode.mockResolvedValueOnce(null);
    const a = await join(conn(BOB));
    expect(last(a, 'join-rejected')).toMatchObject({ code: 'not-found' });

    const b = conn(BOB);
    await rooms.joinMeeting(b, { meetingCode: "x' OR 1=1" });
    expect(last(b, 'join-rejected')).toMatchObject({ code: 'not-found' });

    getMeetingByCode.mockResolvedValueOnce(meetingRow({ status: 'ended' }));
    const c = await join(conn(BOB));
    expect(last(c, 'join-rejected')).toMatchObject({ code: 'meeting-ended' });
    expect(c.meetingId).toBeNull();
  });

  it('enforces mute-on-entry for everyone but the host', async () => {
    getMeetingByCode.mockResolvedValue(meetingRow({}, { muteOnEntry: true }));
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB), { muted: false });
    expect(last(alice, 'joined')).toMatchObject({ self: { isMuted: false } });
    expect(last(bob, 'joined')).toMatchObject({ self: { isMuted: true } });
  });

  it('carries the lobby mute/camera state into the meeting', async () => {
    const bob = await join(conn(BOB), { muted: true, videoOn: false });
    expect(last(bob, 'joined')).toMatchObject({ self: { isMuted: true, isVideoOn: false } });
  });

  it('refuses joins past maxParticipants, except the organizer', async () => {
    getMeetingByCode.mockResolvedValue(meetingRow({}, { maxParticipants: 2 }));
    await join(conn(BOB));
    await join(conn(CAROL));
    const dave = await join(conn(DAVE));
    expect(last(dave, 'join-rejected')).toMatchObject({ code: 'meeting-full' });
    const alice = await join(conn(ALICE));
    expect(last(alice, 'joined')).toMatchObject({ role: 'host' });
  });

  it('joining a second meeting leaves the first', async () => {
    const bob = await join(conn(BOB));
    const carol = await join(conn(CAROL));
    getMeetingByCode.mockResolvedValueOnce(meetingRow({ id: 'b0000000-0000-0000-0000-000000000009', meeting_code: 'zzz-zzzz-zzz' }));
    await rooms.joinMeeting(bob, { meetingCode: 'zzz-zzzz-zzz' });
    expect(last(carol, 'participant-left')).toMatchObject({ userId: BOB, reason: 'left' });
    expect(bob.meetingId).toBe('b0000000-0000-0000-0000-000000000009');
  });
});

describe('waiting room', () => {
  beforeEach(() => {
    getMeetingByCode.mockResolvedValue(meetingRow({}, { waitingRoom: true }));
  });

  it('holds non-hosts until a host admits them', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB, 'Bob'));

    expect(last(bob, 'waiting')).toBeTruthy();
    expect(last(bob, 'joined')).toBeUndefined();
    expect(last(alice, 'waiting-room-update')).toMatchObject({ waiting: [{ userId: BOB, displayName: 'Bob' }] });

    // While waiting: no chat, no media, no host controls
    const chat = await rooms.sendChatMessage(MEETING, BOB, 'hi', undefined);
    expect(chat).toMatchObject({ ok: false, code: 'not-in-meeting' });
    rooms.produce(bob, { kind: 'audio' });
    expect(last(bob, 'error')).toMatchObject({ requestType: 'produce', code: 'not-in-meeting' });

    rooms.admitParticipant(alice, { userId: BOB });
    expect(last(bob, 'joined')).toMatchObject({ role: 'participant' });
    expect(last(alice, 'waiting-room-update')).toMatchObject({ waiting: [] });
  });

  it('only hosts and co-hosts can admit or deny', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    const carol = await join(conn(CAROL));
    rooms.admitParticipant(alice, { userId: CAROL });
    expect(last(carol, 'joined')).toBeTruthy();

    rooms.admitParticipant(carol, { userId: BOB });
    expect(last(carol, 'error')).toMatchObject({ code: 'forbidden' });
    rooms.denyParticipant(carol, { userId: BOB });
    expect(last(carol, 'error')).toMatchObject({ code: 'forbidden' });
    expect(last(bob, 'joined')).toBeUndefined();
    expect(last(bob, 'denied')).toBeUndefined();
  });

  it('denied users are told and detached', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    rooms.denyParticipant(alice, { userId: BOB });
    expect(last(bob, 'denied')).toBeTruthy();
    expect(bob.meetingId).toBeNull();
  });

  it('a host arriving later sees who is already waiting', async () => {
    const bob = await join(conn(BOB));
    expect(last(bob, 'waiting')).toBeTruthy();
    const alice = await join(conn(ALICE));
    expect(last(alice, 'joined')).toMatchObject({ waiting: [{ userId: BOB }] });
  });
});

describe('host controls', () => {
  it('participants cannot use host controls', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    for (const [fn, msg] of [
      [rooms.muteParticipant, { userId: ALICE }],
      [rooms.removeFromMeeting, { userId: ALICE }],
      [rooms.transferHost, { userId: ALICE }],
      [rooms.setLocked, { locked: true }],
      [rooms.setParticipantRole, { userId: ALICE, role: 'participant' }],
    ] as const) {
      bob.sent.length = 0;
      fn(bob, msg as Record<string, unknown>);
      expect(last(bob, 'error')).toMatchObject({ code: 'forbidden' });
    }
    rooms.endMeetingForAll(bob);
    expect(last(bob, 'error')).toMatchObject({ code: 'forbidden' });
    expect(last(alice, 'meeting-ended')).toBeUndefined();
    expect(last(alice, 'participant-update')).toBeUndefined();
  });

  it('host mutes a participant; the participant is told and everyone sees it', async () => {
    const alice = await join(conn(ALICE, 'Alice'));
    const bob = await join(conn(BOB));
    rooms.muteParticipant(alice, { userId: BOB });
    expect(last(bob, 'muted-by-host')).toMatchObject({ by: 'Alice' });
    expect(last(alice, 'participant-update')).toMatchObject({ userId: BOB, isMuted: true });
    await rooms.flushWritesForTests(MEETING);
    expect(meetingService.updateParticipantState).toHaveBeenCalledWith(MEETING, BOB, { isMuted: true });
  });

  it('removed participants are disconnected and cannot rejoin', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    const carol = await join(conn(CAROL));
    rooms.removeFromMeeting(alice, { userId: BOB });
    expect(last(bob, 'removed')).toBeTruthy();
    expect(bob.closedWith).toBe(rooms.CloseCode.REMOVED);
    expect(last(carol, 'participant-left')).toMatchObject({ userId: BOB, reason: 'removed' });

    const bobAgain = await join(conn(BOB));
    expect(last(bobAgain, 'join-rejected')).toMatchObject({ code: 'removed' });
  });

  it('a co-host cannot act on the host or another co-host', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    const carol = await join(conn(CAROL));
    rooms.setParticipantRole(alice, { userId: BOB, role: 'co-host' });
    rooms.setParticipantRole(alice, { userId: CAROL, role: 'co-host' });
    rooms.removeFromMeeting(bob, { userId: ALICE });
    expect(last(bob, 'error')).toMatchObject({ code: 'forbidden' });
    rooms.muteParticipant(bob, { userId: CAROL });
    expect(last(bob, 'error')).toMatchObject({ code: 'forbidden' });
    expect(last(carol, 'muted-by-host')).toBeUndefined();
    const dave = await join(conn(DAVE));
    rooms.muteParticipant(bob, { userId: DAVE });
    expect(last(dave, 'muted-by-host')).toBeTruthy();
  });

  it('transfer-host moves every host power to the new host', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    rooms.transferHost(alice, { userId: BOB });
    expect(last(alice, 'role-changed')).toMatchObject({ userId: ALICE, role: 'participant' });
    expect(last(bob, 'role-changed')).toMatchObject({ userId: ALICE, role: 'participant' });

    rooms.endMeetingForAll(alice);
    expect(last(alice, 'error')).toMatchObject({ code: 'forbidden' });
    rooms.endMeetingForAll(bob);
    expect(last(alice, 'meeting-ended')).toMatchObject({ reason: 'ended-by-host' });
  });

  it('locking keeps new people out; the organizer still gets in', async () => {
    const alice = await join(conn(ALICE));
    rooms.setLocked(alice, { locked: true });
    expect(last(alice, 'meeting-locked')).toMatchObject({ locked: true });
    const bob = await join(conn(BOB));
    expect(last(bob, 'join-rejected')).toMatchObject({ code: 'meeting-locked' });
    rooms.setLocked(alice, { locked: false });
    const bob2 = await join(conn(BOB));
    expect(last(bob2, 'joined')).toBeTruthy();
  });

  it('end-meeting ends it for everyone, persists, and refuses later joins', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    rooms.endMeetingForAll(alice);
    expect(last(bob, 'meeting-ended')).toBeTruthy();
    expect(bob.meetingId).toBeNull();
    await vi.waitFor(() => expect(meetingService.endMeeting).toHaveBeenCalledWith(MEETING, null));

    // Even if a read raced the end and still says 'active', the join is refused.
    getMeetingByCode.mockResolvedValueOnce(meetingRow({ status: 'active' }));
    const carol = await join(conn(CAROL));
    expect(last(carol, 'join-rejected')).toMatchObject({ code: 'meeting-ended' });
  });
});

describe('when the host leaves', () => {
  it('promotes a co-host first, otherwise the longest-present participant', async () => {
    const alice = await join(conn(ALICE));
    vi.advanceTimersByTime(10);
    const bob = await join(conn(BOB));
    vi.advanceTimersByTime(10);
    const carol = await join(conn(CAROL));
    rooms.setParticipantRole(alice, { userId: CAROL, role: 'co-host' });
    rooms.leaveMeeting(alice);
    expect(last(bob, 'role-changed')).toMatchObject({ userId: CAROL, role: 'host' });

    rooms.leaveMeeting(carol);
    expect(last(bob, 'role-changed')).toMatchObject({ userId: BOB, role: 'host' });
  });

  it('the organizer reclaims host on return; the interim host becomes co-host', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    rooms.leaveMeeting(alice);
    expect(last(bob, 'role-changed')).toMatchObject({ userId: BOB, role: 'host' });
    const alice2 = await join(conn(ALICE));
    expect(last(alice2, 'joined')).toMatchObject({ role: 'host' });
    expect(bob.sent.filter((m) => m.type === 'role-changed').at(-1)).toMatchObject({ userId: BOB, role: 'co-host' });
  });
});

describe('participant bookkeeping', () => {
  it('a second tab takes over the seat without a leave/join flicker', async () => {
    const alice = await join(conn(ALICE));
    const bobTab1 = await join(conn(BOB));
    const bobTab2 = await join(conn(BOB));

    expect(last(bobTab1, 'session-replaced')).toBeTruthy();
    expect(bobTab1.closedWith).toBe(rooms.CloseCode.REPLACED);
    expect(last(bobTab2, 'joined')).toMatchObject({ role: 'participant' });

    // Closing the old tab must not evict the new one.
    rooms.handleDisconnect(bobTab1);
    vi.advanceTimersByTime(5000);
    expect(count(alice, 'participant-left')).toBe(0);
    expect(rooms.getLiveRole(MEETING, BOB)).toBe('participant');
    expect(activeParticipants.inc).toHaveBeenCalledTimes(2);
  });

  it('a dropped socket keeps the seat through the grace window', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    rooms.handleDisconnect(bob);
    vi.advanceTimersByTime(500);
    expect(count(alice, 'participant-left')).toBe(0);
    const bobBack = await join(conn(BOB));
    expect(last(bobBack, 'joined')).toBeTruthy();
    vi.advanceTimersByTime(5000);
    expect(count(alice, 'participant-left')).toBe(0);

    rooms.handleDisconnect(bobBack);
    vi.advanceTimersByTime(1001);
    expect(last(alice, 'participant-left')).toMatchObject({ userId: BOB, reason: 'disconnected' });
  });

  it('leave followed by the socket closing counts one departure', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    rooms.leaveMeeting(bob);
    rooms.handleDisconnect(bob);
    vi.advanceTimersByTime(5000);
    expect(count(alice, 'participant-left')).toBe(1);
    expect(activeParticipants.dec).toHaveBeenCalledTimes(1);
    await rooms.flushWritesForTests(MEETING);
    expect(meetingService.leaveMeeting).toHaveBeenCalledTimes(1);
  });

  it('an empty meeting ends after the grace period unless someone returns', async () => {
    const alice = await join(conn(ALICE));
    rooms.leaveMeeting(alice);
    vi.advanceTimersByTime(4000);
    await join(conn(ALICE));
    vi.advanceTimersByTime(10_000);
    expect(meetingService.endMeeting).not.toHaveBeenCalled();

    rooms.resetLiveStateForTests();
    const bob = await join(conn(BOB));
    rooms.leaveMeeting(bob);
    vi.advanceTimersByTime(5001);
    await vi.waitFor(() => expect(meetingService.endMeeting).toHaveBeenCalledWith(MEETING, null));
  });

  it('startup reconciliation closes stale attendance and ends abandoned meetings', async () => {
    vi.mocked(meetingService.getActiveMeetings).mockResolvedValueOnce([meetingRow({ status: 'active' })]);
    await rooms.reconcileOnStartup();
    expect(meetingService.closeAllOpenAttendance).toHaveBeenCalled();
    vi.advanceTimersByTime(5001);
    await vi.waitFor(() => expect(meetingService.endMeeting).toHaveBeenCalledWith(MEETING, null));
  });
});

describe('screen sharing and media', () => {
  it('honours allowScreenShare=false for participants but not hosts', async () => {
    getMeetingByCode.mockResolvedValue(meetingRow({}, { allowScreenShare: false }));
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    rooms.startScreenShare(bob);
    expect(last(bob, 'error')).toMatchObject({ code: 'screen-share-disabled' });
    rooms.startScreenShare(alice);
    expect(last(bob, 'participant-update')).toMatchObject({ userId: ALICE, isScreenSharing: true });
  });

  it('allows one presenter at a time and gates the screen producer on it', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    rooms.produce(bob, { kind: 'screen' });
    expect(last(bob, 'error')).toMatchObject({ code: 'not-sharing' });
    rooms.startScreenShare(alice);
    rooms.startScreenShare(bob);
    expect(last(bob, 'error')).toMatchObject({ code: 'screen-share-busy' });
  });

  it('only the owner can close a producer; consumers stay inside the meeting', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    rooms.produce(alice, { kind: 'video', rtpParameters: {} });
    const producerId = last(alice, 'produced')!.producerId as string;
    expect(last(bob, 'new-producer')).toMatchObject({ producerId, userId: ALICE });

    rooms.closeProducer(bob, { producerId });
    expect(last(bob, 'error')).toMatchObject({ code: 'not-found' });
    expect(sfuService.getProducer(producerId)).toBeTruthy();

    rooms.consume(bob, { producerId });
    expect(last(bob, 'consume-response')).toMatchObject({ producerId, kind: 'video' });
    rooms.consume(alice, { producerId });
    expect(last(alice, 'error')).toMatchObject({ requestType: 'consume' });

    // An outsider in another meeting cannot consume it
    getMeetingByCode.mockResolvedValueOnce(meetingRow({ id: 'b0000000-0000-0000-0000-000000000009', meeting_code: 'zzz-zzzz-zzz' }));
    const carol = conn(CAROL);
    await rooms.joinMeeting(carol, { meetingCode: 'zzz-zzzz-zzz' });
    rooms.consume(carol, { producerId });
    expect(last(carol, 'error')).toMatchObject({ requestType: 'consume', code: 'not-found' });

    rooms.produce(alice, { kind: 'video' });
    expect(last(alice, 'error')).toMatchObject({ code: 'already-producing' });
    rooms.closeProducer(alice, { producerId });
    expect(last(bob, 'producer-closed')).toMatchObject({ producerId, userId: ALICE });
  });
});

describe('chat', () => {
  it('delivers DMs only to sender and recipient, and only to people in the meeting', async () => {
    const alice = await join(conn(ALICE));
    const bob = await join(conn(BOB));
    const carol = await join(conn(CAROL));

    const dm = await rooms.sendChatMessage(MEETING, BOB, 'psst', CAROL);
    expect(dm.ok).toBe(true);
    expect(last(carol, 'chat-message')).toMatchObject({ content: 'psst', recipientId: CAROL });
    expect(last(bob, 'chat-message')).toMatchObject({ content: 'psst' });
    expect(last(alice, 'chat-message')).toBeUndefined();

    const outsider = await rooms.sendChatMessage(MEETING, BOB, 'hi', DAVE);
    expect(outsider).toMatchObject({ ok: false, code: 'invalid-recipient' });

    const all = await rooms.sendChatMessage(MEETING, ALICE, '  hello all  ', null);
    expect(all.ok).toBe(true);
    expect(last(carol, 'chat-message')).toMatchObject({ content: 'hello all', recipientId: null });

    expect(await rooms.sendChatMessage(MEETING, ALICE, '   ', null)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await rooms.sendChatMessage(MEETING, DAVE, 'not here', null)).toMatchObject({ ok: false, code: 'not-in-meeting' });
    expect(chatService.saveMessage).toHaveBeenCalledTimes(2);
  });
});
