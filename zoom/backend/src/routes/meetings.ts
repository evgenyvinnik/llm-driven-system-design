import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { redis } from '../services/redis.js';
import * as meetingService from '../services/meetingService.js';
import { endLiveMeeting } from '../websocket/meetingRooms.js';

const router = Router();

const IDEMPOTENCY_PENDING = 'pending';
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
// A claim whose request died mid-flight must not block that key for a day.
const IDEMPOTENCY_PENDING_TTL_SECONDS = 60;

// Create a meeting. An optional Idempotency-Key makes retries and double clicks
// return the first meeting instead of creating orphaned duplicates.
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = meetingService.parseCreateMeetingInput(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const userId = req.session.userId!;
  const key = req.get('Idempotency-Key');
  if (key !== undefined && (key.length === 0 || key.length > 100)) {
    res.status(400).json({ error: 'Idempotency-Key must be 1-100 characters' });
    return;
  }
  const redisKey = key ? `zoom:idempotency:create-meeting:${userId}:${key}` : null;

  try {
    if (redisKey) {
      let claimed = true;
      try {
        claimed = (await redis.set(redisKey, IDEMPOTENCY_PENDING, 'EX', IDEMPOTENCY_PENDING_TTL_SECONDS, 'NX')) === 'OK';
      } catch (err) {
        // Fail open: losing dedup for one request beats refusing to create meetings.
        logger.warn({ err }, 'Idempotency claim failed; continuing without it');
      }
      if (!claimed) {
        const previous = await redis.get(redisKey);
        const meeting = previous && previous !== IDEMPOTENCY_PENDING ? await meetingService.getMeetingById(previous) : null;
        if (meeting) {
          res.status(200).json({ meeting, replayed: true });
        } else {
          res.status(409).json({ error: 'A request with this Idempotency-Key is still in progress' });
        }
        return;
      }
    }

    let meeting;
    try {
      meeting = await meetingService.createMeeting(userId, parsed.input);
    } catch (err) {
      if (redisKey) await redis.del(redisKey).catch(() => undefined);
      throw err;
    }
    if (redisKey) {
      await redis.set(redisKey, meeting.id, 'EX', IDEMPOTENCY_TTL_SECONDS).catch((err) => {
        logger.warn({ err }, 'Failed to record idempotency result');
      });
    }
    res.status(201).json({ meeting });
  } catch (err) {
    logger.error({ err }, 'Create meeting error');
    res.status(500).json({ error: 'Failed to create meeting' });
  }
});

// Get user's meetings
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const meetings = await meetingService.getUserMeetings(req.session.userId!);
    res.json({ meetings });
  } catch (err) {
    logger.error({ err }, 'Get meetings error');
    res.status(500).json({ error: 'Failed to get meetings' });
  }
});

// Get meeting by code. The code is the bearer credential for joining, so
// holding it is enough to see the meeting's title, status and settings.
router.get('/code/:code', requireAuth, async (req: Request, res: Response) => {
  try {
    const code = req.params.code.trim().toLowerCase();
    const meeting = meetingService.MEETING_CODE_RE.test(code) ? await meetingService.getMeetingByCode(code) : null;
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json({ meeting });
  } catch (err) {
    logger.error({ err }, 'Get meeting by code error');
    res.status(500).json({ error: 'Failed to get meeting' });
  }
});

// Get meeting by id: organizer and attendees only. Anyone else gets 404, so a
// leaked meeting UUID does not reveal the meeting or its joinable code.
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const meeting = await meetingService.getMeetingForViewer(req.params.id, req.session.userId!);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json({ meeting });
  } catch (err) {
    logger.error({ err }, 'Get meeting by id error');
    res.status(500).json({ error: 'Failed to get meeting' });
  }
});

// Start a meeting (organizer only, scheduled → active)
router.post('/:id/start', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const meeting = await meetingService.getMeetingForViewer(req.params.id, userId);
    if (!meeting || meeting.host_id !== userId) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    if (meeting.status === 'active') {
      res.json({ meeting });
      return;
    }
    const started = await meetingService.startMeeting(meeting.id, userId);
    if (!started) {
      res.status(409).json({ error: `Meeting is ${meeting.status}` });
      return;
    }
    res.json({ meeting: started });
  } catch (err) {
    logger.error({ err }, 'Start meeting error');
    res.status(500).json({ error: 'Failed to start meeting' });
  }
});

// End a meeting (organizer only). Also ends the live session: before, the row
// flipped to 'ended' while everyone stayed connected in the "ended" meeting.
router.post('/:id/end', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const meeting = await meetingService.getMeetingForViewer(req.params.id, userId);
    if (!meeting || meeting.host_id !== userId) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const ended = await meetingService.endMeeting(meeting.id, userId);
    if (!ended) {
      res.status(409).json({ error: `Meeting is already ${meeting.status}` });
      return;
    }
    endLiveMeeting(meeting.id);
    res.json({ meeting: ended });
  } catch (err) {
    logger.error({ err }, 'End meeting error');
    res.status(500).json({ error: 'Failed to end meeting' });
  }
});

// Get participants currently in a meeting (organizer and attendees only)
router.get('/:id/participants', requireAuth, async (req: Request, res: Response) => {
  try {
    const meeting = await meetingService.getMeetingForViewer(req.params.id, req.session.userId!);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const participants = await meetingService.getParticipants(meeting.id);
    res.json({ participants });
  } catch (err) {
    logger.error({ err }, 'Get participants error');
    res.status(500).json({ error: 'Failed to get participants' });
  }
});

export default router;
