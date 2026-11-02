import { pool } from './db.js';
import { logger } from './logger.js';

export interface BreakoutRoomDto {
  id: string;
  name: string;
  isActive: boolean;
  participants: { userId: string; displayName: string }[];
}

/** Creates multiple named breakout rooms for a meeting, all or none. */
export async function createBreakoutRooms(meetingId: string, names: string[]) {
  const result = await pool.query(
    `INSERT INTO breakout_rooms (meeting_id, name)
     SELECT $1, name FROM unnest($2::text[]) WITH ORDINALITY AS t(name, ord)
     ORDER BY ord
     RETURNING id`,
    [meetingId, names]
  );
  logger.info({ meetingId, count: names.length }, 'Breakout rooms created');
  return result.rows.length;
}

/** Looks up a breakout room with the meeting it belongs to. */
export async function getBreakoutRoom(roomId: string) {
  const result = await pool.query('SELECT * FROM breakout_rooms WHERE id = $1', [roomId]);
  return result.rows[0] || null;
}

/**
 * Assigns a meeting participant (by user id) to a breakout room. The unique
 * index on participant_id means one room per participant, so re-assigning moves
 * them; before, the per-room unique key let one person sit in every room, and
 * any participant row from any meeting could be assigned. Returns null when the
 * user is not currently in the room's meeting.
 */
export async function assignParticipant(meetingId: string, roomId: string, userId: string) {
  const result = await pool.query(
    `INSERT INTO breakout_assignments (breakout_room_id, participant_id)
     SELECT $1, mp.id FROM meeting_participants mp
     WHERE mp.meeting_id = $2 AND mp.user_id = $3 AND mp.left_at IS NULL
     ON CONFLICT (participant_id)
     DO UPDATE SET breakout_room_id = EXCLUDED.breakout_room_id, assigned_at = NOW()
     RETURNING breakout_room_id`,
    [roomId, meetingId, userId]
  );
  if (result.rows.length === 0) return null;
  return { roomId, userId };
}

/** Activates all breakout rooms for a meeting. */
export async function activateBreakoutRooms(meetingId: string) {
  await pool.query(
    `UPDATE breakout_rooms SET is_active = true WHERE meeting_id = $1`,
    [meetingId]
  );
  logger.info({ meetingId }, 'Breakout rooms activated');
}

/** Closes breakout rooms and returns all participants to the main room. */
export async function closeBreakoutRooms(meetingId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE breakout_rooms SET is_active = false WHERE meeting_id = $1`, [meetingId]);
    // Delete assignments when closing
    await client.query(
      `DELETE FROM breakout_assignments
       WHERE breakout_room_id IN (SELECT id FROM breakout_rooms WHERE meeting_id = $1)`,
      [meetingId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  logger.info({ meetingId }, 'Breakout rooms closed, participants returned to main room');
}

/** Returns all breakout rooms for a meeting with their assigned participants. */
export async function getBreakoutRooms(meetingId: string): Promise<BreakoutRoomDto[]> {
  const result = await pool.query(
    `SELECT br.id, br.name, br.is_active, br.created_at,
            COALESCE(
              json_agg(json_build_object('userId', mp.user_id, 'displayName', mp.display_name)
                       ORDER BY mp.display_name)
                FILTER (WHERE mp.id IS NOT NULL),
              '[]'
            ) AS participants
     FROM breakout_rooms br
     LEFT JOIN breakout_assignments ba ON ba.breakout_room_id = br.id
     LEFT JOIN meeting_participants mp ON mp.id = ba.participant_id
     WHERE br.meeting_id = $1
     GROUP BY br.id
     ORDER BY br.created_at, br.name`,
    [meetingId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    participants: row.participants,
  }));
}

/** Permanently deletes all breakout rooms for a meeting. */
export async function deleteBreakoutRooms(meetingId: string) {
  await pool.query(
    `DELETE FROM breakout_rooms WHERE meeting_id = $1`,
    [meetingId]
  );
  logger.info({ meetingId }, 'Breakout rooms deleted');
}
