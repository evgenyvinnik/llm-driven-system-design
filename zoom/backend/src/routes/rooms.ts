import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import * as breakoutService from '../services/breakoutService.js';
import { getMeetingForViewer, UUID_RE } from '../services/meetingService.js';
import { getLiveRole, notifyMeeting } from '../websocket/meetingRooms.js';

const router = Router();

/**
 * Resolves the meeting for the caller. Attendees may look at breakout rooms;
 * only the organizer or the live host/co-host may change them. Every route here
 * used to accept any logged-in user for any meeting.
 */
async function resolveAccess(req: Request, res: Response, meetingId: string, needManage: boolean) {
  const userId = req.session.userId!;
  const meeting = await getMeetingForViewer(meetingId, userId);
  if (!meeting) {
    res.status(404).json({ error: 'Meeting not found' });
    return null;
  }
  const liveRole = getLiveRole(meeting.id, userId);
  const canManage = meeting.host_id === userId || liveRole === 'host' || liveRole === 'co-host';
  if (needManage && !canManage) {
    res.status(403).json({ error: 'Only the host or a co-host can manage breakout rooms' });
    return null;
  }
  return meeting;
}

async function pushRooms(meetingId: string, type: 'breakout-rooms-opened' | 'breakout-rooms-updated') {
  const rooms = await breakoutService.getBreakoutRooms(meetingId);
  notifyMeeting(meetingId, { type, rooms });
  return rooms;
}

// Create breakout rooms for a meeting
router.post('/:meetingId/breakout-rooms', requireAuth, async (req: Request, res: Response) => {
  try {
    const meeting = await resolveAccess(req, res, req.params.meetingId, true);
    if (!meeting) return;
    const { rooms } = req.body ?? {};
    if (!Array.isArray(rooms) || rooms.length === 0 || rooms.length > 50) {
      res.status(400).json({ error: 'rooms must be an array of 1-50 rooms' });
      return;
    }
    const names: string[] = [];
    for (const room of rooms) {
      const name = typeof room?.name === 'string' ? room.name.trim() : '';
      if (!name || name.length > 100) {
        res.status(400).json({ error: 'Each room needs a name of 1-100 characters' });
        return;
      }
      names.push(name);
    }
    await breakoutService.createBreakoutRooms(meeting.id, names);
    const result = await pushRooms(meeting.id, 'breakout-rooms-updated');
    res.status(201).json({ rooms: result });
  } catch (err) {
    logger.error({ err }, 'Create breakout rooms error');
    res.status(500).json({ error: 'Failed to create breakout rooms' });
  }
});

// Get breakout rooms for a meeting
router.get('/:meetingId/breakout-rooms', requireAuth, async (req: Request, res: Response) => {
  try {
    const meeting = await resolveAccess(req, res, req.params.meetingId, false);
    if (!meeting) return;
    const rooms = await breakoutService.getBreakoutRooms(meeting.id);
    res.json({ rooms });
  } catch (err) {
    logger.error({ err }, 'Get breakout rooms error');
    res.status(500).json({ error: 'Failed to get breakout rooms' });
  }
});

// Assign a participant (by user id) to a breakout room of the same meeting
router.post('/breakout-rooms/:roomId/assign', requireAuth, async (req: Request, res: Response) => {
  try {
    const room = UUID_RE.test(req.params.roomId) ? await breakoutService.getBreakoutRoom(req.params.roomId) : null;
    if (!room) {
      res.status(404).json({ error: 'Breakout room not found' });
      return;
    }
    const meeting = await resolveAccess(req, res, room.meeting_id, true);
    if (!meeting) return;
    const { userId } = req.body ?? {};
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }
    const assignment = await breakoutService.assignParticipant(meeting.id, room.id, userId);
    if (!assignment) {
      res.status(400).json({ error: 'That user is not in this meeting' });
      return;
    }
    await pushRooms(meeting.id, 'breakout-rooms-updated');
    res.status(201).json({ assignment });
  } catch (err) {
    logger.error({ err }, 'Assign participant error');
    res.status(500).json({ error: 'Failed to assign participant' });
  }
});

// Activate breakout rooms; everyone in the meeting learns where they are assigned
router.post('/:meetingId/breakout-rooms/activate', requireAuth, async (req: Request, res: Response) => {
  try {
    const meeting = await resolveAccess(req, res, req.params.meetingId, true);
    if (!meeting) return;
    await breakoutService.activateBreakoutRooms(meeting.id);
    await pushRooms(meeting.id, 'breakout-rooms-opened');
    res.json({ message: 'Breakout rooms activated' });
  } catch (err) {
    logger.error({ err }, 'Activate breakout rooms error');
    res.status(500).json({ error: 'Failed to activate breakout rooms' });
  }
});

// Close breakout rooms
router.post('/:meetingId/breakout-rooms/close', requireAuth, async (req: Request, res: Response) => {
  try {
    const meeting = await resolveAccess(req, res, req.params.meetingId, true);
    if (!meeting) return;
    await breakoutService.closeBreakoutRooms(meeting.id);
    notifyMeeting(meeting.id, { type: 'breakout-rooms-closed' });
    res.json({ message: 'Breakout rooms closed' });
  } catch (err) {
    logger.error({ err }, 'Close breakout rooms error');
    res.status(500).json({ error: 'Failed to close breakout rooms' });
  }
});

// Delete breakout rooms
router.delete('/:meetingId/breakout-rooms', requireAuth, async (req: Request, res: Response) => {
  try {
    const meeting = await resolveAccess(req, res, req.params.meetingId, true);
    if (!meeting) return;
    await breakoutService.deleteBreakoutRooms(meeting.id);
    await pushRooms(meeting.id, 'breakout-rooms-updated');
    res.json({ message: 'Breakout rooms deleted' });
  } catch (err) {
    logger.error({ err }, 'Delete breakout rooms error');
    res.status(500).json({ error: 'Failed to delete breakout rooms' });
  }
});

export default router;
