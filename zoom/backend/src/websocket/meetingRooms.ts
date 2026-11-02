import { config } from '../config/index.js';
import { logger } from '../services/logger.js';
import { sfuService } from '../services/sfuService.js';
import * as meetingService from '../services/meetingService.js';
import * as chatService from '../services/chatService.js';
import { activeMeetings, activeParticipants } from '../services/metrics.js';

/**
 * Live meeting state for the signaling server.
 *
 * The in-process maps here are the authority for who is in a meeting right now,
 * with which role and media state. PostgreSQL is the record (attendance, roles,
 * history) and is written through after every change, in order, per meeting.
 * State changes are synchronous, so the policy checks below (capacity, single
 * host, single presenter) cannot race each other on the single event loop.
 */

export type Role = 'host' | 'co-host' | 'participant';
const ROLE_RANK: Record<Role, number> = { participant: 0, 'co-host': 1, host: 2 };

/** One WebSocket connection, already authenticated from the session. */
export interface ClientConn {
  connectionId: string;
  userId: string;
  username: string;
  send(message: object): void;
  close(code: number, reason: string): void;
  /** Meeting this connection is admitted to or waiting for. */
  meetingId: string | null;
  waiting: boolean;
  closed: boolean;
}

/** Close codes the client treats as final (no auto-reconnect). */
export const CloseCode = {
  AUTH_REQUIRED: 4001,
  REPLACED: 4002,
  REMOVED: 4003,
} as const;

interface LiveParticipant {
  /** null while the participant's socket is gone but their seat is held (reconnect grace). */
  conn: ClientConn | null;
  userId: string;
  displayName: string;
  role: Role;
  joinedAt: number;
  isMuted: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;
  isHandRaised: boolean;
  graceTimer: NodeJS.Timeout | null;
}

interface WaitingEntry {
  conn: ClientConn;
  userId: string;
  displayName: string;
  since: number;
  muted: boolean;
  videoOn: boolean;
}

interface LiveMeeting {
  id: string;
  code: string;
  title: string;
  /** meetings.host_id: the organizer. The live host role can move; this does not. */
  organizerId: string;
  settings: meetingService.MeetingSettings;
  locked: boolean;
  participants: Map<string, LiveParticipant>;
  waiting: Map<string, WaitingEntry>;
  /** Users the host removed; they cannot rejoin while this meeting runs. */
  removed: Set<string>;
  emptyTimer: NodeJS.Timeout | null;
  /** Serializes this meeting's database writes so they land in the order they happened. */
  writes: Promise<void>;
}

const meetings = new Map<string, LiveMeeting>();
/** Meetings ended in this process recently; guards joins whose meeting read predates the end. */
const recentlyEnded = new Set<string>();

// ---------------------------------------------------------------------------
// helpers

function sendTo(p: LiveParticipant, message: object) {
  p.conn?.send(message);
}

function broadcast(m: LiveMeeting, message: object, excludeUserId?: string) {
  for (const p of m.participants.values()) {
    if (p.userId !== excludeUserId) sendTo(p, message);
  }
}

function isManager(p: LiveParticipant) {
  return ROLE_RANK[p.role] >= ROLE_RANK['co-host'];
}

function sendToManagers(m: LiveMeeting, message: object) {
  for (const p of m.participants.values()) {
    if (isManager(p)) sendTo(p, message);
  }
}

function sendError(conn: ClientConn, requestType: string, code: string, message: string) {
  conn.send({ type: 'error', requestType, code, message });
}

function publicParticipant(p: LiveParticipant) {
  return {
    userId: p.userId,
    displayName: p.displayName,
    role: p.role,
    isMuted: p.isMuted,
    isVideoOn: p.isVideoOn,
    isScreenSharing: p.isScreenSharing,
    isHandRaised: p.isHandRaised,
  };
}

function waitingList(m: LiveMeeting) {
  return [...m.waiting.values()].map((w) => ({
    userId: w.userId,
    displayName: w.displayName,
    since: new Date(w.since).toISOString(),
  }));
}

function notifyWaitingChanged(m: LiveMeeting) {
  sendToManagers(m, { type: 'waiting-room-update', waiting: waitingList(m) });
}

/** Queues a database write behind this meeting's earlier writes; failures are logged, not thrown. */
function persist(m: LiveMeeting, what: string, write: () => Promise<unknown>): Promise<void> {
  m.writes = m.writes
    .then(async () => {
      await write();
    })
    .catch((err) => {
      logger.error({ err, meetingId: m.id, what }, 'Meeting write-through failed');
    });
  return m.writes;
}

function cleanDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, 100) : fallback;
}

/** The connection's current admitted participant entry, or null. */
function participantOf(conn: ClientConn): { m: LiveMeeting; p: LiveParticipant } | null {
  if (!conn.meetingId || conn.waiting) return null;
  const m = meetings.get(conn.meetingId);
  const p = m?.participants.get(conn.userId);
  if (!m || !p || p.conn !== conn) return null;
  return { m, p };
}

function requireParticipant(conn: ClientConn, requestType: string) {
  const found = participantOf(conn);
  if (!found) sendError(conn, requestType, 'not-in-meeting', 'Not in a meeting');
  return found;
}

function requireRole(conn: ClientConn, requestType: string, minRole: Role) {
  const found = requireParticipant(conn, requestType);
  if (!found) return null;
  if (ROLE_RANK[found.p.role] < ROLE_RANK[minRole]) {
    sendError(conn, requestType, 'forbidden', minRole === 'host' ? 'Only the host can do that' : 'Only the host or a co-host can do that');
    return null;
  }
  return found;
}

/** Target of a host action: must be admitted and rank strictly below the actor. */
function requireTarget(conn: ClientConn, requestType: string, m: LiveMeeting, actor: LiveParticipant, userId: unknown) {
  const target = typeof userId === 'string' ? m.participants.get(userId) : undefined;
  if (!target) {
    sendError(conn, requestType, 'not-found', 'That participant is not in the meeting');
    return null;
  }
  if (target === actor || ROLE_RANK[target.role] >= ROLE_RANK[actor.role]) {
    sendError(conn, requestType, 'forbidden', 'You cannot do that to this participant');
    return null;
  }
  return target;
}

function getOrCreateLive(row: Record<string, unknown>): LiveMeeting {
  let m = meetings.get(row.id as string);
  if (!m) {
    m = {
      id: row.id as string,
      code: row.meeting_code as string,
      title: (row.title as string) || 'Meeting',
      organizerId: row.host_id as string,
      settings: meetingService.normalizeSettings(row.settings),
      locked: false,
      participants: new Map(),
      waiting: new Map(),
      removed: new Set(),
      emptyTimer: null,
      writes: Promise.resolve(),
    };
    meetings.set(m.id, m);
    activeMeetings.inc();
  }
  return m;
}

function dispose(m: LiveMeeting) {
  if (meetings.get(m.id) !== m) return;
  meetings.delete(m.id);
  activeMeetings.dec();
  if (m.emptyTimer) clearTimeout(m.emptyTimer);
  m.emptyTimer = null;
  sfuService.closeRoom(m.id);
}

/** A live meeting that never had anyone admitted and has nobody waiting is just dropped. */
function disposeIfIdle(m: LiveMeeting) {
  if (m.participants.size === 0 && m.waiting.size === 0 && !m.emptyTimer) dispose(m);
}

function startEmptyTimer(m: LiveMeeting) {
  if (m.emptyTimer) return;
  m.emptyTimer = setTimeout(() => {
    m.emptyTimer = null;
    if (meetings.get(m.id) === m && m.participants.size === 0) {
      endLive(m, 'empty');
    }
  }, config.ws.emptyMeetingGraceMs);
  m.emptyTimer.unref?.();
}

function cancelEmptyTimer(m: LiveMeeting) {
  if (m.emptyTimer) clearTimeout(m.emptyTimer);
  m.emptyTimer = null;
}

function setRole(m: LiveMeeting, p: LiveParticipant, role: Role) {
  if (p.role === role) return;
  p.role = role;
  broadcast(m, { type: 'role-changed', userId: p.userId, role });
  // A new manager needs to see who is already waiting.
  if (isManager(p)) sendTo(p, { type: 'waiting-room-update', waiting: waitingList(m) });
  persist(m, 'set-role', () => meetingService.setParticipantRole(m.id, p.userId, role));
}

function currentHost(m: LiveMeeting): LiveParticipant | undefined {
  for (const p of m.participants.values()) {
    if (p.role === 'host') return p;
  }
  return undefined;
}

/**
 * The host left: hand the role to the longest-present co-host, else the
 * longest-present participant, preferring people who are actually connected.
 * Without this a meeting outlives its host with nobody able to admit, mute,
 * remove or end.
 */
function promoteNewHost(m: LiveMeeting) {
  if (currentHost(m)) return;
  const candidates = [...m.participants.values()].sort((a, b) => {
    const connected = Number(b.conn !== null) - Number(a.conn !== null);
    if (connected !== 0) return connected;
    const rank = ROLE_RANK[b.role] - ROLE_RANK[a.role];
    return rank !== 0 ? rank : a.joinedAt - b.joinedAt;
  });
  if (candidates[0]) setRole(m, candidates[0], 'host');
}

function closeProducerAndNotify(m: LiveMeeting, producerId: string, ownerId: string) {
  sfuService.closeProducer(m.id, producerId);
  broadcast(m, { type: 'producer-closed', producerId, userId: ownerId }, ownerId);
}

function setScreenSharing(m: LiveMeeting, p: LiveParticipant, sharing: boolean) {
  if (p.isScreenSharing === sharing) return;
  p.isScreenSharing = sharing;
  if (!sharing) {
    const screen = sfuService.findProducer(m.id, p.userId, 'screen');
    if (screen) closeProducerAndNotify(m, screen.id, p.userId);
  }
  broadcast(m, { type: 'participant-update', userId: p.userId, isScreenSharing: sharing });
  persist(m, 'screen-share', () => meetingService.updateParticipantState(m.id, p.userId, { isScreenSharing: sharing }));
}

// ---------------------------------------------------------------------------
// join / admit / leave

function reject(conn: ClientConn, code: string, message: string) {
  conn.send({ type: 'join-rejected', code, message });
}

function sendJoined(m: LiveMeeting, p: LiveParticipant, conn: ClientConn) {
  const { sendTransportOptions, recvTransportOptions, routerRtpCapabilities } = sfuService.joinRoom(m.id, p.userId);
  conn.send({
    type: 'joined',
    meetingId: m.id,
    meetingCode: m.code,
    title: m.title,
    hostId: m.organizerId,
    role: p.role,
    settings: m.settings,
    locked: m.locked,
    self: publicParticipant(p),
    participants: [...m.participants.values()].map(publicParticipant),
    waiting: isManager(p) ? waitingList(m) : [],
    routerRtpCapabilities,
    sendTransportOptions,
    recvTransportOptions,
    existingProducers: sfuService.getProducersForRoom(m.id, p.userId).map((producer) => ({
      producerId: producer.id,
      userId: producer.userId,
      kind: producer.kind,
    })),
  });
}

function admit(
  m: LiveMeeting,
  conn: ClientConn,
  opts: { displayName: string; muted: boolean; videoOn: boolean }
) {
  cancelEmptyTimer(m);
  const isOrganizer = conn.userId === m.organizerId;

  let role: Role = 'participant';
  if (isOrganizer) {
    // The organizer reclaims host on (re)joining; whoever held it meanwhile stays a co-host.
    const interim = currentHost(m);
    if (interim) setRole(m, interim, 'co-host');
    role = 'host';
  }

  const p: LiveParticipant = {
    conn,
    userId: conn.userId,
    displayName: opts.displayName,
    role,
    joinedAt: Date.now(),
    // Mute-on-entry applies to everyone but the host; it was stored but never enforced.
    isMuted: opts.muted || (m.settings.muteOnEntry && role !== 'host'),
    isVideoOn: opts.videoOn,
    isScreenSharing: false,
    isHandRaised: false,
    graceTimer: null,
  };
  m.participants.set(p.userId, p);
  conn.meetingId = m.id;
  conn.waiting = false;
  activeParticipants.inc();

  sendJoined(m, p, conn);
  broadcast(m, { type: 'participant-joined', participant: publicParticipant(p) }, p.userId);
  logger.info({ meetingId: m.id, userId: p.userId, role }, 'Participant admitted');

  persist(m, 'admit', async () => {
    await meetingService.autoStartMeeting(m.id);
    await meetingService.upsertParticipant(m.id, p.userId, {
      displayName: p.displayName,
      role: p.role,
      isMuted: p.isMuted,
      isVideoOn: p.isVideoOn,
    });
  });
}

/**
 * The same user joined again (second tab, or a reconnect inside the grace
 * window). One seat per user per meeting: the newer connection takes the seat
 * and its role; the older one is told and closed. Previously the second tab
 * overwrote the first in the map, and closing the first tab then evicted the
 * second from the meeting and told everyone the user had left.
 */
function takeOver(m: LiveMeeting, p: LiveParticipant, conn: ClientConn, displayName: string) {
  const old = p.conn;
  if (old && old !== conn) {
    old.meetingId = null;
    old.waiting = false;
    old.send({ type: 'session-replaced', message: 'You joined this meeting from another window' });
    old.close(CloseCode.REPLACED, 'Joined from another window');
  }
  if (p.graceTimer) clearTimeout(p.graceTimer);
  p.graceTimer = null;

  // The old connection's tracks died with it.
  if (p.isScreenSharing) setScreenSharing(m, p, false);
  for (const producer of sfuService.getProducersForRoom(m.id).filter((x) => x.userId === p.userId)) {
    closeProducerAndNotify(m, producer.id, p.userId);
  }

  p.conn = conn;
  p.displayName = displayName;
  conn.meetingId = m.id;
  conn.waiting = false;
  sendJoined(m, p, conn);
  // participant-joined is idempotent on the client (keyed by userId), so this refreshes the entry.
  broadcast(m, { type: 'participant-joined', participant: publicParticipant(p) }, p.userId);
  persist(m, 'takeover', () =>
    meetingService.upsertParticipant(m.id, p.userId, {
      displayName: p.displayName,
      role: p.role,
      isMuted: p.isMuted,
      isVideoOn: p.isVideoOn,
    })
  );
}

function removeParticipant(m: LiveMeeting, p: LiveParticipant, reason: 'left' | 'disconnected' | 'removed') {
  if (m.participants.get(p.userId) !== p) return;
  if (p.graceTimer) clearTimeout(p.graceTimer);
  p.graceTimer = null;
  m.participants.delete(p.userId);
  if (p.conn) {
    p.conn.meetingId = null;
    p.conn.waiting = false;
  }
  activeParticipants.dec();

  for (const producerId of sfuService.leaveRoom(m.id, p.userId)) {
    broadcast(m, { type: 'producer-closed', producerId, userId: p.userId });
  }
  broadcast(m, { type: 'participant-left', userId: p.userId, reason });
  if (p.role === 'host') promoteNewHost(m);
  persist(m, 'leave', () => meetingService.leaveMeeting(m.id, p.userId));
  logger.info({ meetingId: m.id, userId: p.userId, reason }, 'Participant left meeting');

  if (m.participants.size === 0) startEmptyTimer(m);
}

/**
 * Detaches a connection from whatever meeting it is in. An explicit leave
 * frees the seat immediately; a dropped socket holds it for the reconnect
 * grace window first.
 */
function detach(conn: ClientConn, mode: 'leave' | 'disconnect') {
  const m = conn.meetingId ? meetings.get(conn.meetingId) : undefined;
  const wasWaiting = conn.waiting;
  conn.meetingId = null;
  conn.waiting = false;
  if (!m) return null;

  if (wasWaiting) {
    const w = m.waiting.get(conn.userId);
    if (w && w.conn === conn) {
      m.waiting.delete(conn.userId);
      notifyWaitingChanged(m);
      disposeIfIdle(m);
    }
    return m.id;
  }

  const p = m.participants.get(conn.userId);
  // A newer tab already owns the seat: nothing to clean up for this connection.
  if (!p || p.conn !== conn) return m.id;

  if (mode === 'disconnect' && config.ws.reconnectGraceMs > 0) {
    p.conn = null;
    p.graceTimer = setTimeout(() => {
      p.graceTimer = null;
      if (p.conn === null) removeParticipant(m, p, 'disconnected');
    }, config.ws.reconnectGraceMs);
    p.graceTimer.unref?.();
    return m.id;
  }
  removeParticipant(m, p, mode === 'leave' ? 'left' : 'disconnected');
  return m.id;
}

/** join-meeting: { meetingCode, displayName?, muted?, videoOn? } */
export async function joinMeeting(conn: ClientConn, message: Record<string, unknown>) {
  const code = typeof message.meetingCode === 'string' ? message.meetingCode.trim().toLowerCase() : '';
  if (!meetingService.MEETING_CODE_RE.test(code)) {
    reject(conn, 'not-found', 'Meeting not found');
    return;
  }
  const displayName = cleanDisplayName(message.displayName, conn.username);
  const muted = message.muted === true;
  const videoOn = message.videoOn !== false;

  // A connection is in at most one meeting; joining another leaves the first.
  if (conn.meetingId) detach(conn, 'leave');

  const row = await meetingService.getMeetingByCode(code);
  if (conn.closed) return;
  if (!row) {
    reject(conn, 'not-found', 'Meeting not found');
    return;
  }
  if (row.status === 'ended' || row.status === 'cancelled' || recentlyEnded.has(row.id)) {
    reject(conn, 'meeting-ended', 'This meeting has ended');
    return;
  }

  const m = getOrCreateLive(row);
  const isOrganizer = conn.userId === m.organizerId;

  const seat = m.participants.get(conn.userId);
  if (seat) {
    takeOver(m, seat, conn, displayName);
    return;
  }

  // The organizer always gets in: a host locked out of their own meeting by its
  // own lock, waiting room or capacity has no way to fix it.
  if (!isOrganizer) {
    if (m.removed.has(conn.userId)) {
      reject(conn, 'removed', 'You were removed from this meeting by the host');
      disposeIfIdle(m);
      return;
    }
    if (m.locked) {
      reject(conn, 'meeting-locked', 'The host has locked this meeting');
      disposeIfIdle(m);
      return;
    }
    if (m.participants.size >= m.settings.maxParticipants) {
      reject(conn, 'meeting-full', 'This meeting is full');
      disposeIfIdle(m);
      return;
    }
    if (m.settings.waitingRoom) {
      const previous = m.waiting.get(conn.userId);
      if (previous && previous.conn !== conn) {
        previous.conn.meetingId = null;
        previous.conn.waiting = false;
        previous.conn.send({ type: 'session-replaced', message: 'You joined this meeting from another window' });
        previous.conn.close(CloseCode.REPLACED, 'Joined from another window');
      }
      m.waiting.set(conn.userId, { conn, userId: conn.userId, displayName, since: Date.now(), muted, videoOn });
      conn.meetingId = m.id;
      conn.waiting = true;
      conn.send({ type: 'waiting', meetingId: m.id, meetingCode: m.code, title: m.title });
      notifyWaitingChanged(m);
      logger.info({ meetingId: m.id, userId: conn.userId }, 'Participant placed in waiting room');
      return;
    }
  }

  admit(m, conn, { displayName, muted, videoOn });
}

/** leave-meeting */
export function leaveMeeting(conn: ClientConn) {
  const meetingId = detach(conn, 'leave');
  if (meetingId) conn.send({ type: 'left', meetingId });
}

/** Socket closed without (or after) a leave. */
export function handleDisconnect(conn: ClientConn) {
  conn.closed = true;
  detach(conn, 'disconnect');
}

// ---------------------------------------------------------------------------
// host controls

/** admit-participant: { userId } — host or co-host lets someone out of the waiting room. */
export function admitParticipant(conn: ClientConn, message: Record<string, unknown>) {
  const found = requireRole(conn, 'admit-participant', 'co-host');
  if (!found) return;
  const { m } = found;
  const w = typeof message.userId === 'string' ? m.waiting.get(message.userId) : undefined;
  if (!w) {
    sendError(conn, 'admit-participant', 'not-found', 'That person is no longer waiting');
    return;
  }
  if (m.participants.size >= m.settings.maxParticipants) {
    sendError(conn, 'admit-participant', 'meeting-full', 'This meeting is full');
    return;
  }
  m.waiting.delete(w.userId);
  notifyWaitingChanged(m);
  admit(m, w.conn, { displayName: w.displayName, muted: w.muted, videoOn: w.videoOn });
}

/** deny-participant: { userId } */
export function denyParticipant(conn: ClientConn, message: Record<string, unknown>) {
  const found = requireRole(conn, 'deny-participant', 'co-host');
  if (!found) return;
  const { m } = found;
  const w = typeof message.userId === 'string' ? m.waiting.get(message.userId) : undefined;
  if (!w) {
    sendError(conn, 'deny-participant', 'not-found', 'That person is no longer waiting');
    return;
  }
  m.waiting.delete(w.userId);
  w.conn.meetingId = null;
  w.conn.waiting = false;
  w.conn.send({ type: 'denied', message: 'The host did not admit you to this meeting' });
  notifyWaitingChanged(m);
}

/** mute-participant: { userId } — host/co-host may mute, never unmute, someone ranked below them. */
export function muteParticipant(conn: ClientConn, message: Record<string, unknown>) {
  const found = requireRole(conn, 'mute-participant', 'co-host');
  if (!found) return;
  const target = requireTarget(conn, 'mute-participant', found.m, found.p, message.userId);
  if (!target) return;
  forceMute(found.m, target, found.p);
}

/** mute-all — mutes everyone ranked below the caller. */
export function muteAll(conn: ClientConn) {
  const found = requireRole(conn, 'mute-all', 'co-host');
  if (!found) return;
  for (const p of found.m.participants.values()) {
    if (ROLE_RANK[p.role] < ROLE_RANK[found.p.role]) forceMute(found.m, p, found.p);
  }
}

function forceMute(m: LiveMeeting, target: LiveParticipant, by: LiveParticipant) {
  sendTo(target, { type: 'muted-by-host', by: by.displayName });
  if (target.isMuted) return;
  target.isMuted = true;
  broadcast(m, { type: 'participant-update', userId: target.userId, isMuted: true });
  persist(m, 'force-mute', () => meetingService.updateParticipantState(m.id, target.userId, { isMuted: true }));
}

/** remove-participant: { userId } — removed users cannot rejoin this meeting. */
export function removeFromMeeting(conn: ClientConn, message: Record<string, unknown>) {
  const found = requireRole(conn, 'remove-participant', 'co-host');
  if (!found) return;
  const target = requireTarget(conn, 'remove-participant', found.m, found.p, message.userId);
  if (!target) return;
  found.m.removed.add(target.userId);
  const targetConn = target.conn;
  removeParticipant(found.m, target, 'removed');
  if (targetConn) {
    targetConn.send({ type: 'removed', message: 'The host removed you from this meeting' });
    targetConn.close(CloseCode.REMOVED, 'Removed by host');
  }
}

/** transfer-host: { userId } — the caller becomes a participant. */
export function transferHost(conn: ClientConn, message: Record<string, unknown>) {
  const found = requireRole(conn, 'transfer-host', 'host');
  if (!found) return;
  const target = requireTarget(conn, 'transfer-host', found.m, found.p, message.userId);
  if (!target) return;
  if (!target.conn) {
    sendError(conn, 'transfer-host', 'not-connected', 'That participant is reconnecting; try again shortly');
    return;
  }
  setRole(found.m, target, 'host');
  setRole(found.m, found.p, 'participant');
}

/** set-role: { userId, role: 'co-host' | 'participant' } — host only. */
export function setParticipantRole(conn: ClientConn, message: Record<string, unknown>) {
  const found = requireRole(conn, 'set-role', 'host');
  if (!found) return;
  if (message.role !== 'co-host' && message.role !== 'participant') {
    sendError(conn, 'set-role', 'invalid', 'role must be co-host or participant');
    return;
  }
  const target = requireTarget(conn, 'set-role', found.m, found.p, message.userId);
  if (!target) return;
  setRole(found.m, target, message.role);
}

/** lock-meeting: { locked } — a locked meeting admits nobody new, waiting room included. */
export function setLocked(conn: ClientConn, message: Record<string, unknown>) {
  const found = requireRole(conn, 'lock-meeting', 'co-host');
  if (!found) return;
  if (typeof message.locked !== 'boolean') {
    sendError(conn, 'lock-meeting', 'invalid', 'locked must be a boolean');
    return;
  }
  found.m.locked = message.locked;
  broadcast(found.m, { type: 'meeting-locked', locked: message.locked, by: found.p.displayName });
}

/** end-meeting — host only; ends it for everyone. */
export function endMeetingForAll(conn: ClientConn) {
  const found = requireRole(conn, 'end-meeting', 'host');
  if (!found) return;
  endLive(found.m, 'ended-by-host');
}

function endLive(m: LiveMeeting, reason: 'ended-by-host' | 'empty') {
  if (meetings.get(m.id) !== m) return;
  recentlyEnded.add(m.id);
  for (const p of m.participants.values()) {
    if (p.graceTimer) clearTimeout(p.graceTimer);
    p.graceTimer = null;
    if (p.conn) {
      p.conn.meetingId = null;
      p.conn.waiting = false;
      p.conn.send({ type: 'meeting-ended', reason });
    }
    activeParticipants.dec();
  }
  for (const w of m.waiting.values()) {
    w.conn.meetingId = null;
    w.conn.waiting = false;
    w.conn.send({ type: 'meeting-ended', reason });
  }
  m.participants.clear();
  m.waiting.clear();
  dispose(m);
  logger.info({ meetingId: m.id, reason }, 'Meeting ended');

  persist(m, 'end', () => meetingService.endMeeting(m.id, null)).finally(() => {
    // Once the 'ended' status is committed, fresh reads see it; keep the guard a
    // little longer for reads that started before the commit.
    setTimeout(() => recentlyEnded.delete(m.id), 60_000).unref?.();
  });
}

/** Ends a live meeting from outside the socket layer (REST end by the organizer). */
export function endLiveMeeting(meetingId: string) {
  const m = meetings.get(meetingId);
  if (m) endLive(m, 'ended-by-host');
}

// ---------------------------------------------------------------------------
// own media state

function requireBoolean(conn: ClientConn, requestType: string, value: unknown): value is boolean {
  if (typeof value === 'boolean') return true;
  sendError(conn, requestType, 'invalid', 'Expected a boolean');
  return false;
}

/** toggle-mute / toggle-video / raise-hand: changes only the caller's own state. */
export function updateOwnState(
  conn: ClientConn,
  requestType: 'toggle-mute' | 'toggle-video' | 'raise-hand',
  value: unknown
) {
  const found = requireParticipant(conn, requestType);
  if (!found || !requireBoolean(conn, requestType, value)) return;
  const { m, p } = found;
  const field = requestType === 'toggle-mute' ? 'isMuted' : requestType === 'toggle-video' ? 'isVideoOn' : 'isHandRaised';
  if (p[field] === value) return;
  p[field] = value;
  broadcast(m, { type: 'participant-update', userId: p.userId, [field]: value });
  persist(m, requestType, () => meetingService.updateParticipantState(m.id, p.userId, { [field]: value }));
}

/** start-screen-share: one presenter at a time, and only hosts when sharing is disabled. */
export function startScreenShare(conn: ClientConn) {
  const found = requireParticipant(conn, 'start-screen-share');
  if (!found) return;
  const { m, p } = found;
  if (!m.settings.allowScreenShare && !isManager(p)) {
    sendError(conn, 'start-screen-share', 'screen-share-disabled', 'The host has disabled screen sharing');
    return;
  }
  for (const other of m.participants.values()) {
    if (other !== p && other.isScreenSharing) {
      sendError(conn, 'start-screen-share', 'screen-share-busy', `${other.displayName} is already sharing`);
      return;
    }
  }
  setScreenSharing(m, p, true);
}

export function stopScreenShare(conn: ClientConn) {
  const found = requireParticipant(conn, 'stop-screen-share');
  if (!found) return;
  setScreenSharing(found.m, found.p, false);
}

// ---------------------------------------------------------------------------
// SFU signaling

const PRODUCER_KINDS = new Set(['audio', 'video', 'screen']);

/** produce: { kind, rtpParameters } */
export function produce(conn: ClientConn, message: Record<string, unknown>) {
  const found = requireParticipant(conn, 'produce');
  if (!found) return;
  const { m, p } = found;
  const kind = message.kind;
  if (typeof kind !== 'string' || !PRODUCER_KINDS.has(kind)) {
    sendError(conn, 'produce', 'invalid', 'kind must be audio, video or screen');
    return;
  }
  // A screen track is only accepted while the share is granted (start-screen-share),
  // so the presenter rule and allowScreenShare cannot be bypassed at the media layer.
  if (kind === 'screen' && !p.isScreenSharing) {
    sendError(conn, 'produce', 'not-sharing', 'Start screen sharing before producing a screen track');
    return;
  }
  if (sfuService.findProducer(m.id, p.userId, kind as 'audio' | 'video' | 'screen')) {
    sendError(conn, 'produce', 'already-producing', `Already producing ${kind}`);
    return;
  }
  const producerId = sfuService.createProducer(m.id, p.userId, kind as 'audio' | 'video' | 'screen', message.rtpParameters ?? {});
  conn.send({ type: 'produced', producerId, kind });
  broadcast(m, { type: 'new-producer', userId: p.userId, producerId, kind }, p.userId);
}

/** consume: { producerId } — only producers of this meeting, never one's own. */
export function consume(conn: ClientConn, message: Record<string, unknown>) {
  const found = requireParticipant(conn, 'consume');
  if (!found) return;
  const producerId = typeof message.producerId === 'string' ? message.producerId : '';
  try {
    const { consumerId, kind, rtpParameters } = sfuService.createConsumer(found.m.id, found.p.userId, producerId);
    conn.send({ type: 'consume-response', consumerId, producerId, kind, rtpParameters });
  } catch {
    sendError(conn, 'consume', 'not-found', 'Producer not found');
  }
}

/** producer-close: { producerId } — only the producer's owner may close it. */
export function closeProducer(conn: ClientConn, message: Record<string, unknown>) {
  const found = requireParticipant(conn, 'producer-close');
  if (!found) return;
  const { m, p } = found;
  const producer = typeof message.producerId === 'string' ? sfuService.getProducer(message.producerId) : undefined;
  // Producer ids are broadcast to the whole meeting, so ownership must be checked:
  // before, anyone could stop anyone's camera or screen share.
  if (!producer || producer.meetingId !== m.id || producer.userId !== p.userId) {
    sendError(conn, 'producer-close', 'not-found', 'Producer not found');
    return;
  }
  if (producer.kind === 'screen' && p.isScreenSharing) {
    setScreenSharing(m, p, false); // also closes the screen producer
    return;
  }
  closeProducerAndNotify(m, producer.id, p.userId);
}

// ---------------------------------------------------------------------------
// chat

export type ChatResult =
  | { ok: true; message: chatService.ChatMessageDto }
  | { ok: false; status: number; code: string; error: string };

/**
 * Sends a chat message as a participant currently in the meeting. Broadcast
 * messages reach everyone admitted; a DM reaches only its recipient and the
 * sender, and the recipient must be in the meeting (the old handler stored DMs
 * to arbitrary user ids). Used by the socket and by REST.
 */
export async function sendChatMessage(
  meetingId: string,
  senderId: string,
  content: unknown,
  recipientId: unknown
): Promise<ChatResult> {
  const m = meetings.get(meetingId);
  const sender = m?.participants.get(senderId);
  if (!m || !sender) return { ok: false, status: 409, code: 'not-in-meeting', error: 'You are not in this meeting' };

  const text = typeof content === 'string' ? content.trim() : '';
  if (!text || text.length > chatService.MAX_CHAT_LENGTH) {
    return { ok: false, status: 400, code: 'invalid', error: `Message must be 1-${chatService.MAX_CHAT_LENGTH} characters` };
  }

  let recipient: LiveParticipant | undefined;
  if (recipientId !== undefined && recipientId !== null && recipientId !== '') {
    recipient = typeof recipientId === 'string' ? m.participants.get(recipientId) : undefined;
    if (!recipient || recipient === sender) {
      return { ok: false, status: 400, code: 'invalid-recipient', error: 'Direct messages must go to someone in the meeting' };
    }
  }

  const saved = await chatService.saveMessage(m.id, sender.userId, text, recipient?.userId ?? null);
  const dto: chatService.ChatMessageDto = {
    id: saved.id,
    senderId: sender.userId,
    senderName: sender.displayName,
    content: text,
    recipientId: recipient?.userId ?? null,
    createdAt: new Date(saved.created_at).toISOString(),
  };
  const wire = { type: 'chat-message', ...dto };
  if (recipient) {
    sendTo(recipient, wire);
    sendTo(sender, wire);
  } else {
    broadcast(m, wire);
  }
  return { ok: true, message: dto };
}

// ---------------------------------------------------------------------------
// queries for REST routes

/** The caller's live role in a running meeting, or null if they are not in it. */
export function getLiveRole(meetingId: string, userId: string): Role | null {
  return meetings.get(meetingId)?.participants.get(userId)?.role ?? null;
}

/** Pushes a server event to everyone admitted to a live meeting. */
export function notifyMeeting(meetingId: string, message: object) {
  const m = meetings.get(meetingId);
  if (m) broadcast(m, message);
}

/**
 * Boot-time repair. Signaling state is in-process, so after a restart every
 * open attendance row is stale (left_at NULL forever, ghosts in participant
 * lists) and every 'active' meeting has nobody in it. Close the rows and give
 * each active meeting the normal empty-meeting grace: clients that reconnect
 * in time carry on, the rest end instead of staying 'active' forever.
 */
export async function reconcileOnStartup() {
  const closed = await meetingService.closeAllOpenAttendance();
  const active = await meetingService.getActiveMeetings();
  for (const row of active) {
    startEmptyTimer(getOrCreateLive(row));
  }
  logger.info({ closedAttendance: closed, activeMeetings: active.length }, 'Startup reconciliation done');
}

/** Test hook: drops all live state and timers. */
export function resetLiveStateForTests() {
  for (const m of meetings.values()) {
    if (m.emptyTimer) clearTimeout(m.emptyTimer);
    for (const p of m.participants.values()) if (p.graceTimer) clearTimeout(p.graceTimer);
  }
  meetings.clear();
  recentlyEnded.clear();
}

/** Test hook: settles queued write-throughs for a meeting. */
export async function flushWritesForTests(meetingId: string) {
  await meetings.get(meetingId)?.writes;
}
