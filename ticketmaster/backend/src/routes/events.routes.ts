import { Router, Request, Response } from 'express';
import { eventService } from '../services/event.service.js';
import { authMiddleware, adminMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';

const router = Router();

// Get all events
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, status, search, page, limit } = req.query;

    const result = await eventService.getEvents({
      category: category as string,
      status: status as string,
      search: search as string,
      page: page ? parseInt(page as string) : 1,
      limit: limit ? parseInt(limit as string) : 10,
    });

    res.json({
      success: true,
      data: result.events,
      total: result.total,
      page: page ? parseInt(page as string) : 1,
      limit: limit ? parseInt(limit as string) : 10,
      totalPages: Math.ceil(result.total / (limit ? parseInt(limit as string) : 10)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get events';
    res.status(500).json({ success: false, error: message });
  }
});

// Get single event
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const event = await eventService.getEventById(req.params.id);

    if (!event) {
      res.status(404).json({ success: false, error: 'Event not found' });
      return;
    }

    res.json({ success: true, data: event });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get event';
    res.status(500).json({ success: false, error: message });
  }
});

// Generate seats for an event (admin only)
router.post(
  '/:id/generate-seats',
  authMiddleware,
  adminMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const eventId = req.params.id;

      const event = await eventService.getEventById(eventId);
      if (!event) {
        res.status(404).json({ success: false, error: 'Event not found' });
        return;
      }

      const seatCount = await eventService.generateEventSeats(eventId);

      res.json({
        success: true,
        data: { message: `Generated ${seatCount} seats for event` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate seats';
      res.status(500).json({ success: false, error: message });
    }
  }
);

// Update event status (admin only)
router.patch(
  '/:id/status',
  authMiddleware,
  adminMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { status } = req.body;

      if (!['upcoming', 'on_sale', 'sold_out', 'cancelled', 'completed'].includes(status)) {
        res.status(400).json({ success: false, error: 'Invalid status' });
        return;
      }

      await eventService.updateEventStatus(req.params.id, status);

      res.json({ success: true, data: { message: 'Status updated' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update status';
      res.status(500).json({ success: false, error: message });
    }
  }
);

export default router;
