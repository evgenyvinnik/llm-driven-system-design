import { Router, Response } from 'express';
import { waitingRoomService } from '../services/waiting-room.service.js';
import { eventService } from '../services/event.service.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';

const router = Router();

// Join waiting room queue
router.post('/:eventId/join', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const eventId = req.params.eventId;

    // Check if event exists and has waiting room enabled
    const event = await eventService.getEventById(eventId);
    if (!event) {
      res.status(404).json({ success: false, error: 'Event not found' });
      return;
    }

    if (!event.waiting_room_enabled) {
      // No waiting room needed, automatically active
      res.json({
        success: true,
        data: {
          position: 0,
          status: 'active',
          estimated_wait_seconds: 0,
        },
      });
      return;
    }

    const status = await waitingRoomService.joinQueue(eventId, req.sessionId!);

    res.json({ success: true, data: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to join queue';
    res.status(500).json({ success: false, error: message });
  }
});

// Get queue status
router.get('/:eventId/status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const eventId = req.params.eventId;

    // Check if event exists and has waiting room enabled
    const event = await eventService.getEventById(eventId);
    if (!event) {
      res.status(404).json({ success: false, error: 'Event not found' });
      return;
    }

    if (!event.waiting_room_enabled) {
      res.json({
        success: true,
        data: {
          position: 0,
          status: 'active',
          estimated_wait_seconds: 0,
        },
      });
      return;
    }

    const status = await waitingRoomService.getQueueStatus(eventId, req.sessionId!);

    res.json({ success: true, data: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get queue status';
    res.status(500).json({ success: false, error: message });
  }
});

// Leave queue
router.post('/:eventId/leave', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await waitingRoomService.leaveQueue(req.params.eventId, req.sessionId!);
    res.json({ success: true, data: { message: 'Left queue' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to leave queue';
    res.status(500).json({ success: false, error: message });
  }
});

// Get queue stats (for display purposes)
router.get('/:eventId/stats', async (req, res: Response) => {
  try {
    const stats = await waitingRoomService.getQueueStats(req.params.eventId);
    res.json({ success: true, data: stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get queue stats';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
