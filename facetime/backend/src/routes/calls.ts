import { Router, Request, Response } from 'express';
import { query } from '../db/index.js';
import type { Call, CallParticipant } from '../types/index.js';

const router = Router();

// Get call history for a user
router.get('/history/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const calls = await query<Call & { participants: CallParticipant[] }>(
      `SELECT c.*,
        (SELECT json_agg(json_build_object(
          'user_id', cp.user_id,
          'state', cp.state,
          'is_initiator', cp.is_initiator,
          'joined_at', cp.joined_at,
          'left_at', cp.left_at,
          'user', json_build_object(
            'id', u.id,
            'username', u.username,
            'display_name', u.display_name,
            'avatar_url', u.avatar_url
          )
        ))
        FROM call_participants cp
        JOIN users u ON u.id = cp.user_id
        WHERE cp.call_id = c.id) as participants
      FROM calls c
      WHERE c.id IN (
        SELECT call_id FROM call_participants WHERE user_id = $1
      )
      ORDER BY c.created_at DESC
      LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    res.json(calls);
  } catch (error) {
    console.error('Error fetching call history:', error);
    res.status(500).json({ error: 'Failed to fetch call history' });
  }
});

// Get call details
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const call = await query<Call>(
      'SELECT * FROM calls WHERE id = $1',
      [id]
    );

    if (call.length === 0) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }

    const participants = await query<CallParticipant>(
      `SELECT cp.*, json_build_object(
        'id', u.id,
        'username', u.username,
        'display_name', u.display_name,
        'avatar_url', u.avatar_url
      ) as user
      FROM call_participants cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.call_id = $1`,
      [id]
    );

    res.json({
      ...call[0],
      participants,
    });
  } catch (error) {
    console.error('Error fetching call:', error);
    res.status(500).json({ error: 'Failed to fetch call' });
  }
});

export default router;
