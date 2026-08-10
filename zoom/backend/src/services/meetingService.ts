import { pool } from './db.js';
import { logger } from './logger.js';

function generateMeetingCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const part = (len: number) => {
    let result = '';
    for (let i = 0; i < len; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };
  return `${part(3)}-${part(4)}-${part(3)}`;
}

export interface CreateMeetingInput {
  title?: string;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  settings?: {
    waitingRoom?: boolean;
    muteOnEntry?: boolean;
    allowScreenShare?: boolean;
    maxParticipants?: number;
  };
}

/** Creates a meeting with a unique human-readable code and default settings. */
export async function createMeeting(hostId: string, input: CreateMeetingInput) {
  const meetingCode = generateMeetingCode();
  const settings = {
    waitingRoom: false,
    muteOnEntry: false,
    allowScreenShare: true,
    maxParticipants: 100,
    ...input.settings,
  };

  const result = await pool.query(
    `INSERT INTO meetings (meeting_code, title, host_id, scheduled_start, scheduled_end, settings)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [meetingCode, input.title || 'Untitled Meeting', hostId, input.scheduledStart || null, input.scheduledEnd || null, JSON.stringify(settings)]
  );

  logger.info({ meetingId: result.rows[0].id, meetingCode }, 'Meeting created');
  return result.rows[0];
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

/** Returns all meetings hosted by a user, ordered by most recent. */
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

/** Transitions a meeting to active status and records the start time. */
export async function startMeeting(meetingId: string, hostId: string) {
  const result = await pool.query(
    `UPDATE meetings SET status = 'active', actual_start = NOW(), updated_at = NOW()
     WHERE id = $1 AND host_id = $2
     RETURNING *`,
    [meetingId, hostId]
  );
  if (result.rows.length === 0) {
    throw new Error('Meeting not found or unauthorized');
  }
  logger.info({ meetingId }, 'Meeting started');
  return result.rows[0];
}

/** Ends a meeting and records the end time, host-only. */
export async function endMeeting(meetingId: string, hostId: string) {
  const result = await pool.query(
    `UPDATE meetings SET status = 'ended', actual_end = NOW(), updated_at = NOW()
     WHERE id = $1 AND host_id = $2
     RETURNING *`,
    [meetingId, hostId]
  );
  if (result.rows.length === 0) {
    throw new Error('Meeting not found or unauthorized');
  }
  logger.info({ meetingId }, 'Meeting ended');
  return result.rows[0];
}

/** Adds a participant to a meeting or re-joins if previously left. */
export async function joinMeeting(meetingId: string, userId: string, displayName: string) {
  // Upsert: if already joined but left, update left_at to null
  const result = await pool.query(
    `INSERT INTO meeting_participants (meeting_id, user_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (meeting_id, user_id)
     DO UPDATE SET left_at = NULL, joined_at = NOW(), display_name = EXCLUDED.display_name
     RETURNING *`,
    [meetingId, userId, displayName]
  );
  logger.info({ meetingId, userId }, 'Participant joined meeting');
  return result.rows[0];
}

/** Records a participant's departure from the meeting. */
export async function leaveMeeting(meetingId: string, userId: string) {
  const result = await pool.query(
    `UPDATE meeting_participants SET left_at = NOW()
     WHERE meeting_id = $1 AND user_id = $2 AND left_at IS NULL
     RETURNING *`,
    [meetingId, userId]
  );
  logger.info({ meetingId, userId }, 'Participant left meeting');
  return result.rows[0] || null;
}

/** Returns all currently active participants in a meeting. */
export async function getParticipants(meetingId: string) {
  const result = await pool.query(
    `SELECT mp.*, u.username, u.avatar_url
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
