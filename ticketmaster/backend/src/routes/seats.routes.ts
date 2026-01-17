import { Router, Request, Response } from 'express';
import { seatService } from '../services/seat.service.js';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';

const router = Router();

// Get seat availability for an event
router.get('/:eventId/availability', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { section } = req.query;
    const availability = await seatService.getSeatAvailability(
      req.params.eventId,
      section as string
    );

    res.json({ success: true, data: availability });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get availability';
    res.status(500).json({ success: false, error: message });
  }
});

// Get seats for a specific section
router.get('/:eventId/sections/:section', async (req: Request, res: Response) => {
  try {
    const seats = await seatService.getSectionSeats(req.params.eventId, req.params.section);
    res.json({ success: true, data: seats });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get section seats';
    res.status(500).json({ success: false, error: message });
  }
});

// Reserve seats
router.post('/:eventId/reserve', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { seat_ids } = req.body;

    if (!seat_ids || !Array.isArray(seat_ids) || seat_ids.length === 0) {
      res.status(400).json({ success: false, error: 'seat_ids array is required' });
      return;
    }

    if (seat_ids.length > 10) {
      res.status(400).json({ success: false, error: 'Cannot reserve more than 10 seats at once' });
      return;
    }

    const result = await seatService.reserveSeats(
      req.sessionId!,
      req.params.eventId,
      seat_ids
    );

    res.json({
      success: true,
      data: {
        seats: result.seats,
        expiresAt: result.expiresAt,
        totalPrice: result.seats.reduce((sum, s) => sum + parseFloat(String(s.price)), 0),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reserve seats';
    res.status(400).json({ success: false, error: message });
  }
});

// Release seats
router.post('/:eventId/release', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { seat_ids } = req.body;

    if (!seat_ids || !Array.isArray(seat_ids) || seat_ids.length === 0) {
      res.status(400).json({ success: false, error: 'seat_ids array is required' });
      return;
    }

    await seatService.releaseSeats(req.sessionId!, req.params.eventId, seat_ids);

    res.json({ success: true, data: { message: 'Seats released' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to release seats';
    res.status(500).json({ success: false, error: message });
  }
});

// Get current reservation
router.get('/reservation', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reservation = await seatService.getReservation(req.sessionId!);

    if (!reservation) {
      res.json({ success: true, data: null });
      return;
    }

    res.json({
      success: true,
      data: {
        event_id: reservation.event_id,
        seats: reservation.seats,
        total_price: reservation.total_price,
        expires_at: reservation.expires_at,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get reservation';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
