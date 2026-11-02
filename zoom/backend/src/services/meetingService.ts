import { randomInt } from 'crypto';
import { pool } from './db.js';
import { logger } from './logger.js';

/**
 * Meeting codes are bearer credentials (anyone holding one can try to join), so
 * they come from a CSPRNG: Math.random() state can be recovered from outputs.
 */
export function generateMeetingCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const part = (len: number) => {
    let result = '';
    for (let i = 0; i < len; i++) {
      result += chars.charAt(randomInt(chars.length));
    }
    return result;
  };
  return `${part(3)}-${part(4)}-${part(3)}`;
}

export const MEETING_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MeetingSettings {
  waitingRoom: boolean;
  muteOnEntry: boolean;
  allowScreenShare: boolean;
  maxParticipants: number;
}

export const DEFAULT_SETTINGS: MeetingSettings = {
  waitingRoom: false,
  muteOnEntry: false,
  allowScreenShare: true,
  maxParticipants: 100,
};

export interface CreateMeetingInput {
  title: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  settings: MeetingSettings;
}

/** Reads a stored settings object, falling back to defaults for missing or malformed keys. */
export function normalizeSettings(raw: unknown): MeetingSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    waitingRoom: typeof s.waitingRoom === 'boolean' ? s.waitingRoom : DEFAULT_SETTINGS.waitingRoom,
    muteOnEntry: typeof s.muteOnEntry === 'boolean' ? s.muteOnEntry : DEFAULT_SETTINGS.muteOnEntry,
    allowScreenShare:
      typeof s.allowScreenShare === 'boolean' ? s.allowScreenShare : DEFAULT_SETTINGS.allowScreenShare,
    maxParticipants:
      Number.isInteger(s.maxParticipants) && (s.maxParticipants as number) >= 2
        ? Math.min(s.maxParticipants as number, 1000)
        : DEFAULT_SETTINGS.maxParticipants,
  };
}

// An ISO-8601 timestamp that names its offset. A bare "2026-11-02T10:00" (what a
// datetime-local input produces) would be read in the database server's zone,
// silently moving the meeting by the user's UTC offset.
const ISO_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** Validates and normalizes a create-meeting body. Returns an error message or the clean input. */
export function parseCreateMeetingInput(body: unknown): { error: string } | { input: CreateMeetingInput } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  let title = 'Untitled Meeting';
  if (b.title !== undefined && b.title !== null && b.title !== '') {
    if (typeof b.title !== 'string' || b.title.trim().length === 0 || b.title.length > 255) {
      return { error: 'title must be a string of at most 255 characters' };
    }
    title = b.title.trim();
  }

  const parseTime = (value: unknown, field: string): { error: string } | { value: string | null } => {
    if (value === undefined || value === null || value === '') return { value: null };
    if (typeof value !== 'string' || !ISO_WITH_ZONE_RE.test(value) || Number.isNaN(Date.parse(value))) {
      return { error: `${field} must be an ISO-8601 timestamp with a time zone offset` };
    }
    return { value: new Date(value).toISOString() };
  };
  const start = parseTime(b.scheduledStart, 'scheduledStart');
  if ('error' in start) return start;
  const end = parseTime(b.scheduledEnd, 'scheduledEnd');
  if ('error' in end) return end;
  if (end.value && !start.value) return { error: 'scheduledEnd requires scheduledStart' };
  if (start.value && end.value && Date.parse(end.value) <= Date.parse(start.value)) {
    return { error: 'scheduledEnd must be after scheduledStart' };
  }

  const settings: MeetingSettings = { ...DEFAULT_SETTINGS };
  if (b.settings !== undefined && b.settings !== null) {
    if (typeof b.settings !== 'object') return { error: 'settings must be an object' };
    const s = b.settings as Record<string, unknown>;
    for (const key of ['waitingRoom', 'muteOnEntry', 'allowScreenShare'] as const) {
      if (s[key] === undefined) continue;
      if (typeof s[key] !== 'boolean') return { error: `settings.${key} must be a boolean` };
      settings[key] = s[key] as boolean;
    }
    if (s.maxParticipants !== undefined) {
      if (!Number.isInteger(s.maxParticipants) || (s.maxParticipants as number) < 2 || (s.maxParticipants as number) > 1000) {
        return { error: 'settings.maxParticipants must be an integer between 2 and 1000' };
      }
      settings.maxParticipants = s.maxParticipants as number;
    }
  }

  return { input: { title, scheduledStart: start.value, scheduledEnd: end.value, settings } };
}

/** Creates a meeting with a unique human-readable code. Retries on the rare code collision. */
export async function createMeeting(hostId: string, input: CreateMeetingInput) {
  for (let attempt = 0; ; attempt++) {
    const meetingCode = generateMeetingCode();
    try {
      const result = await pool.query(
        `INSERT INTO meetings (meeting_code, title, host_id, scheduled_start, scheduled_end, settings)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [meetingCode, input.title, hostId, input.scheduledStart, input.scheduledEnd, JSON.stringify(input.settings)]
      );
      logger.info({ meetingId: result.rows[0].id, meetingCode }, 'Meeting created');
      return result.rows[0];
    } catch (err) {
      // 23505 on meeting_code: two meetings drew the same code. Draw again.
      if ((err as { code?: string }).code === '23505' && attempt < 4) continue;
      throw err;
    }
  }
}

/** Looks up a meeting by its human-readable code. */
export async function getMeetingByCode(code: string) {
  const result = await pool.query('SELECT * FROM meetings WHERE meeting_code = $1', [code]);
  return result.rows[0] || null;
}

/** Looks up a meeting by its UUID. */
export async function getMeetingById(id: string) {
  const result = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/**
 * Returns the meeting if the user may see its details: its organizer, or anyone
 * who attended it. Everyone else gets null, which routes turn into a 404.
 */
export async function getMeetingForViewer(meetingId: string, userId: string) {
  if (!UUID_RE.test(meetingId)) return null;
  const result = await pool.query(
    `SELECT m.* FROM meetings m
     WHERE m.id = $1
       AND (m.host_id = $2
            OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = $2))`,
    [meetingId, userId]
  );
  return result.rows[0] || null;
}

/** Returns all meetings the user organized or attended, ordered by most recent. */
export async function getUserMeetings(userId: string) {
  // Meetings the user hosted OR attended. Filtering on host_id alone made
  // "Meeting History" empty for every participant who wasn't the organizer —
  // their attendance is recorded in meeting_participants, which nothing read.
  // DISTINCT because a host also has a participant row for their own meeting.
  const result = await pool.query(
    `SELECT DISTINCT m.*
     FROM meetings m
     LEFT JOIN meeting_participants p ON p.meeting_id = m.id AND p.user_id = $1
     WHERE m.host_id = $1 OR p.user_id = $1
     ORDER BY m.created_at DESC
     LIMIT 50`,
    [userId]
  );
  return result.rows;
}

/**
 * Transitions a scheduled meeting to active, organizer-only. Only 'scheduled'
 * moves: re-running this on an ended meeting used to reopen it and overwrite
 * actual_start, corrupting its history.
 */
export async function startMeeting(meetingId: string, hostId: string) {
  const result = await pool.query(
    `UPDATE meetings SET status = 'active', actual_start = NOW(), updated_at = NOW()
     WHERE id = $1 AND host_id = $2 AND status = 'scheduled'
     RETURNING *`,
    [meetingId, hostId]
  );
  if (result.rows[0]) logger.info({ meetingId }, 'Meeting started');
  return result.rows[0] || null;
}

/** Marks a scheduled meeting active when its first participant is admitted. No-op otherwise. */
export async function autoStartMeeting(meetingId: string) {
  // The status guard makes concurrent first joins safe: only one sets actual_start.
  await pool.query(
    `UPDATE meetings SET status = 'active', actual_start = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'scheduled'`,
    [meetingId]
  );
}

/**
 * Ends a meeting and closes every open attendance row in one transaction.
 * When hostId is given only the organizer may end it (REST); the live signaling
 * path passes null because it has already checked the caller holds the host role.
 */
export async function endMeeting(meetingId: string, hostId: string | null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE meetings SET status = 'ended', actual_end = NOW(), updated_at = NOW()
       WHERE id = $1 AND status IN ('scheduled', 'active') AND ($2::uuid IS NULL OR host_id = $2::uuid)
       RETURNING *`,
      [meetingId, hostId]
    );
    if (result.rows[0]) {
      await client.query(
        `UPDATE meeting_participants SET left_at = NOW(), is_screen_sharing = false, is_hand_raised = false
         WHERE meeting_id = $1 AND left_at IS NULL`,
        [meetingId]
      );
    }
    await client.query('COMMIT');
    if (result.rows[0]) logger.info({ meetingId }, 'Meeting ended');
    return result.rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface ParticipantRecord {
  displayName: string;
  role: 'host' | 'co-host' | 'participant';
  isMuted: boolean;
  isVideoOn: boolean;
}

/**
 * Records a participant's admission. A rejoin reuses the row (UNIQUE meeting_id,
 * user_id) but starts from fresh state: the old upsert kept the previous
 * session's role, hand and screen-share flags, so someone who left while
 * presenting rejoined "presenting", and a former host rejoined as a second host.
 * joined_at is kept when the row is still open (a second tab taking over).
 */
export async function upsertParticipant(meetingId: string, userId: string, record: ParticipantRecord) {
  const result = await pool.query(
    `INSERT INTO meeting_participants (meeting_id, user_id, display_name, role, is_muted, is_video_on)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (meeting_id, user_id)
     DO UPDATE SET
       joined_at = CASE WHEN meeting_participants.left_at IS NULL THEN meeting_participants.joined_at ELSE NOW() END,
       left_at = NULL,
       display_name = EXCLUDED.display_name,
       role = EXCLUDED.role,
       is_muted = EXCLUDED.is_muted,
       is_video_on = EXCLUDED.is_video_on,
       is_screen_sharing = false,
       is_hand_raised = false
     RETURNING *`,
    [meetingId, userId, record.displayName, record.role, record.isMuted, record.isVideoOn]
  );
  logger.info({ meetingId, userId }, 'Participant joined meeting');
  return result.rows[0];
}

/** Records a participant's departure from the meeting. */
export async function leaveMeeting(meetingId: string, userId: string) {
  const result = await pool.query(
    `UPDATE meeting_participants SET left_at = NOW(), is_screen_sharing = false, is_hand_raised = false
     WHERE meeting_id = $1 AND user_id = $2 AND left_at IS NULL
     RETURNING *`,
    [meetingId, userId]
  );
  logger.info({ meetingId, userId }, 'Participant left meeting');
  return result.rows[0] || null;
}

/**
 * Closes every open attendance row. Called once at boot: the signaling state is
 * in-process, so a fresh process has no connected participants and any open row
 * is a leftover from the previous run.
 */
export async function closeAllOpenAttendance() {
  const result = await pool.query(
    `UPDATE meeting_participants SET left_at = NOW(), is_screen_sharing = false, is_hand_raised = false
     WHERE left_at IS NULL`
  );
  return result.rowCount ?? 0;
}

/** Meetings currently marked active. */
export async function getActiveMeetings() {
  const result = await pool.query(`SELECT * FROM meetings WHERE status = 'active'`);
  return result.rows;
}

/** Returns all currently active participants in a meeting. */
export async function getParticipants(meetingId: string) {
  const result = await pool.query(
    `SELECT mp.id, mp.user_id, mp.display_name, mp.role, mp.joined_at, mp.left_at,
            mp.is_muted, mp.is_video_on, mp.is_screen_sharing, mp.is_hand_raised,
            u.username, u.avatar_url
     FROM meeting_participants mp
     JOIN users u ON mp.user_id = u.id
     WHERE mp.meeting_id = $1 AND mp.left_at IS NULL
     ORDER BY mp.joined_at`,
    [meetingId]
  );
  return result.rows;
}

/** Updates a participant's media state (mute, video, screen share, hand raise). */
export async function updateParticipantState(
  meetingId: string,
  userId: string,
  changes: {
    isMuted?: boolean;
    isVideoOn?: boolean;
    isScreenSharing?: boolean;
    isHandRaised?: boolean;
  }
) {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 3;

  if (changes.isMuted !== undefined) {
    setClauses.push(`is_muted = $${paramIndex++}`);
    values.push(changes.isMuted);
  }
  if (changes.isVideoOn !== undefined) {
    setClauses.push(`is_video_on = $${paramIndex++}`);
    values.push(changes.isVideoOn);
  }
  if (changes.isScreenSharing !== undefined) {
    setClauses.push(`is_screen_sharing = $${paramIndex++}`);
    values.push(changes.isScreenSharing);
  }
  if (changes.isHandRaised !== undefined) {
    setClauses.push(`is_hand_raised = $${paramIndex++}`);
    values.push(changes.isHandRaised);
  }

  if (setClauses.length === 0) return null;

  const result = await pool.query(
    `UPDATE meeting_participants SET ${setClauses.join(', ')}
     WHERE meeting_id = $1 AND user_id = $2 AND left_at IS NULL
     RETURNING *`,
    [meetingId, userId, ...values]
  );
  return result.rows[0] || null;
}

/** Changes a participant's role (e.g. host, co-host, participant). */
export async function setParticipantRole(meetingId: string, userId: string, role: string) {
  const result = await pool.query(
    `UPDATE meeting_participants SET role = $3
     WHERE meeting_id = $1 AND user_id = $2 AND left_at IS NULL
     RETURNING *`,
    [meetingId, userId, role]
  );
  return result.rows[0] || null;
}
