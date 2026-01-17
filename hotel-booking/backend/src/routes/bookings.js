const express = require('express');
const bookingService = require('../services/bookingService');
const reviewService = require('../services/reviewService');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// Check availability
router.get('/availability', async (req, res) => {
  try {
    const { hotelId, roomTypeId, checkIn, checkOut, rooms } = req.query;

    if (!hotelId || !roomTypeId || !checkIn || !checkOut) {
      return res.status(400).json({ error: 'hotelId, roomTypeId, checkIn, and checkOut are required' });
    }

    const availability = await bookingService.checkAvailability(
      hotelId,
      roomTypeId,
      checkIn,
      checkOut,
      rooms ? parseInt(rooms) : 1
    );

    res.json(availability);
  } catch (error) {
    console.error('Check availability error:', error);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

// Get availability calendar
router.get('/availability/calendar', async (req, res) => {
  try {
    const { hotelId, roomTypeId, year, month } = req.query;

    if (!hotelId || !roomTypeId || !year || !month) {
      return res.status(400).json({ error: 'hotelId, roomTypeId, year, and month are required' });
    }

    const calendar = await bookingService.getAvailabilityCalendar(
      hotelId,
      roomTypeId,
      parseInt(year),
      parseInt(month)
    );

    res.json(calendar);
  } catch (error) {
    console.error('Get availability calendar error:', error);
    res.status(500).json({ error: 'Failed to get availability calendar' });
  }
});

// Create booking
router.post('/', authenticate, async (req, res) => {
  try {
    const booking = await bookingService.createBooking(req.body, req.user.id);
    res.status(201).json(booking);
  } catch (error) {
    console.error('Create booking error:', error);
    if (error.message.includes('available')) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// Confirm booking (after payment)
router.post('/:bookingId/confirm', authenticate, async (req, res) => {
  try {
    const { paymentId } = req.body;
    const booking = await bookingService.confirmBooking(req.params.bookingId, req.user.id, paymentId);
    res.json(booking);
  } catch (error) {
    console.error('Confirm booking error:', error);
    if (error.message.includes('not found') || error.message.includes('cannot be confirmed')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to confirm booking' });
  }
});

// Cancel booking
router.post('/:bookingId/cancel', authenticate, async (req, res) => {
  try {
    const booking = await bookingService.cancelBooking(req.params.bookingId, req.user.id);
    res.json(booking);
  } catch (error) {
    console.error('Cancel booking error:', error);
    if (error.message.includes('not found') || error.message.includes('cannot be cancelled')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

// Get booking by ID
router.get('/:bookingId', authenticate, async (req, res) => {
  try {
    const booking = await bookingService.getBookingById(req.params.bookingId, req.user.id);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    res.json(booking);
  } catch (error) {
    console.error('Get booking error:', error);
    res.status(500).json({ error: 'Failed to get booking' });
  }
});

// Get my bookings
router.get('/', authenticate, async (req, res) => {
  try {
    const { status } = req.query;
    const bookings = await bookingService.getBookingsByUser(req.user.id, status);
    res.json(bookings);
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Failed to get bookings' });
  }
});

// Submit review for a booking
router.post('/:bookingId/review', authenticate, async (req, res) => {
  try {
    const { rating, title, content } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
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
    if (error.message.includes('not found') || error.message.includes('not eligible')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('already submitted')) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create review' });
  }
});

// Hotel admin: Get bookings for a hotel
router.get('/hotel/:hotelId', authenticate, requireRole('hotel_admin', 'admin'), async (req, res) => {
  try {
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
    if (error.message.includes('not found') || error.message.includes('access denied')) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to get bookings' });
  }
});

module.exports = router;
