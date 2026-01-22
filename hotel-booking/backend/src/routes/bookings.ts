import { Router, Request, Response } from 'express';
import bookingService from '../services/booking/index.js';
import reviewService from '../services/reviewService.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

interface AvailabilityQuery {
  hotelId?: string;
  roomTypeId?: string;
  checkIn?: string;
  checkOut?: string;
  rooms?: string;
}

interface CalendarQuery {
  hotelId?: string;
  roomTypeId?: string;
  year?: string;
  month?: string;
}

interface _BookingParams {
  bookingId: string;
}

interface _HotelParams {
  hotelId: string;
}

interface ConfirmBody {
  paymentId: string;
}

interface ReviewBody {
  rating: number;
  title: string;
  content: string;
}

interface BookingsQuery {
  status?: string;
}

interface HotelBookingsQuery {
  status?: string;
  startDate?: string;
  endDate?: string;
}

// Check availability
router.get('/availability', async (req: Request<object, unknown, unknown, AvailabilityQuery>, res: Response): Promise<void> => {
  try {
    const { hotelId, roomTypeId, checkIn, checkOut, rooms } = req.query;

    if (!hotelId || !roomTypeId || !checkIn || !checkOut) {
      res.status(400).json({ error: 'hotelId, roomTypeId, checkIn, and checkOut are required' });
      return;
    }

    const availability = await bookingService.checkAvailability(
      hotelId,
      roomTypeId,
      checkIn,
      checkOut,
      rooms ? parseInt(rooms, 10) : 1
    );

    res.json(availability);
  } catch (error) {
    console.error('Check availability error:', error);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

// Get availability calendar
router.get('/availability/calendar', async (req: Request<object, unknown, unknown, CalendarQuery>, res: Response): Promise<void> => {
  try {
    const { hotelId, roomTypeId, year, month } = req.query;

    if (!hotelId || !roomTypeId || !year || !month) {
      res.status(400).json({ error: 'hotelId, roomTypeId, year, and month are required' });
      return;
    }

    const calendar = await bookingService.getAvailabilityCalendar(
      hotelId,
      roomTypeId,
      parseInt(year, 10),
      parseInt(month, 10)
    );

    res.json(calendar);
  } catch (error) {
    console.error('Get availability calendar error:', error);
    res.status(500).json({ error: 'Failed to get availability calendar' });
  }
});

// Create booking
router.post('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const booking = await bookingService.createBooking(req.body, req.user.id);
    res.status(201).json(booking);
  } catch (error) {
    console.error('Create booking error:', error);
    if (error instanceof Error && error.message.includes('available')) {
      res.status(409).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// Confirm booking (after payment)
router.post('/:bookingId/confirm', authenticate, async (req: Request<{ bookingId: string }, unknown, ConfirmBody>, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { paymentId } = req.body;
    const booking = await bookingService.confirmBooking(req.params.bookingId, req.user.id, paymentId);
    res.json(booking);
  } catch (error) {
    console.error('Confirm booking error:', error);
    if (error instanceof Error && (error.message.includes('not found') || error.message.includes('cannot be confirmed'))) {
      res.status(404).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});

// Cancel booking
router.post('/:bookingId/cancel', authenticate, async (req: Request<{ bookingId: string }>, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const booking = await bookingService.cancelBooking(req.params.bookingId, req.user.id);
    res.json(booking);
  } catch (error) {
    console.error('Cancel booking error:', error);
    if (error instanceof Error && (error.message.includes('not found') || error.message.includes('cannot be cancelled'))) {
      res.status(404).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

// Get booking by ID
router.get('/:bookingId', authenticate, async (req: Request<{ bookingId: string }>, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const booking = await bookingService.getBookingById(req.params.bookingId, req.user.id);

    if (!booking) {
      res.status(404).json({ error: 'Booking not found' });
      return;
    }

    res.json(booking);
  } catch (error) {
    console.error('Get booking error:', error);
    res.status(500).json({ error: 'Failed to get booking' });
  }
});

// Get my bookings
router.get('/', authenticate, async (req: Request<object, unknown, unknown, BookingsQuery>, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { status } = req.query;
    const bookings = await bookingService.getBookingsByUser(req.user.id, status);
    res.json(bookings);
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Failed to get bookings' });
  }
});

// Submit review for a booking
router.post('/:bookingId/review', authenticate, async (req: Request<{ bookingId: string }, unknown, ReviewBody>, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { rating, title, content } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      res.status(400).json({ error: 'Rating must be between 1 and 5' });
      return;
    }

    const review = await reviewService.createReview(
      {
        bookingId: req.params.bookingId,
        rating,
        title,
        content,
      },
      req.user.id
    );

    res.status(201).json(review);
  } catch (error) {
    console.error('Create review error:', error);
    if (error instanceof Error && (error.message.includes('not found') || error.message.includes('not eligible'))) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes('already submitted')) {
      res.status(409).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to create review' });
  }
});

// Hotel admin: Get bookings for a hotel
router.get('/hotel/:hotelId', authenticate, requireRole('hotel_admin', 'admin'), async (req: Request<{ hotelId: string }, unknown, unknown, HotelBookingsQuery>, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { status, startDate, endDate } = req.query;
    const bookings = await bookingService.getBookingsByHotel(
      req.params.hotelId,
      req.user.id,
      status,
      startDate,
      endDate
    );
    res.json(bookings);
  } catch (error) {
    console.error('Get hotel bookings error:', error);
    if (error instanceof Error && (error.message.includes('not found') || error.message.includes('access denied'))) {
      res.status(403).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to get bookings' });
  }
});

export default router;
