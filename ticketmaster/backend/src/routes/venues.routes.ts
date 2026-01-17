import { Router, Request, Response } from 'express';
import { eventService } from '../services/event.service.js';

const router = Router();

// Get all venues
router.get('/', async (_req: Request, res: Response) => {
  try {
    const venues = await eventService.getVenues();
    res.json({ success: true, data: venues });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get venues';
    res.status(500).json({ success: false, error: message });
  }
});

// Get single venue
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const venue = await eventService.getVenueById(req.params.id);

    if (!venue) {
      res.status(404).json({ success: false, error: 'Venue not found' });
      return;
    }

    res.json({ success: true, data: venue });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get venue';
    res.status(500).json({ success: false, error: message });
  }
});

// Get venue sections
router.get('/:id/sections', async (req: Request, res: Response) => {
  try {
    const sections = await eventService.getVenueSections(req.params.id);
    res.json({ success: true, data: sections });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get venue sections';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
