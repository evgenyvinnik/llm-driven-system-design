import { Router, type Request, type Response } from 'express';
import { query, transaction } from '../db.js';
import { authenticate, requireHost } from '../middleware/auth.js';
import { invalidateAvailabilityCache } from '../shared/cache.js';
import { metrics } from '../shared/metrics.js';
import { auditBooking, AUDIT_EVENTS, OUTCOMES } from '../shared/audit.js';
import { publishBookingCreated, publishBookingConfirmed, publishBookingCancelled, publishHostAlert } from '../shared/queue.js';
import { createModuleLogger } from '../shared/logger.js';

const router = Router();
const log = createModuleLogger('bookings');

// Type definitions
interface ListingRow {
  id: number;
  host_id: number;
  title: string;
  city: string | null;
  property_type: string | null;
  price_per_night: string | number;
  cleaning_fee: string | number | null;
  service_fee_percent: string | number | null;
  minimum_nights: number;
  maximum_nights: number;
  max_guests: number;
  instant_book: boolean;
}

interface BookingPricing {
  nights: number;
  pricePerNight: number;
  subtotal: number;
  cleaningFee: number;
  serviceFee: number;
  total: number;
}

interface BookingRow {
  id: number;
  listing_id: number;
  guest_id: number;
  check_in: string;
  check_out: string;
  guests: number;
  nights: number;
  price_per_night: number;
  cleaning_fee: number;
  service_fee: number;
  total_price: number;
  status: string;
  guest_message?: string;
  host_response?: string;
  cancelled_by?: string;
  cancelled_at?: string;
  created_at: string;
  updated_at: string;
}

// Calculate booking price
const calculateBookingPrice = (listing: ListingRow, checkIn: string, checkOut: string): BookingPricing => {
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const nights = Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));

  const pricePerNight = parseFloat(String(listing.price_per_night));
  const cleaningFee = parseFloat(String(listing.cleaning_fee || 0));
  const subtotal = pricePerNight * nights;
  const serviceFee = subtotal * (parseFloat(String(listing.service_fee_percent || 10)) / 100);
  const total = subtotal + cleaningFee + serviceFee;

  return {
    nights,
    pricePerNight,
    subtotal,
    cleaningFee,
    serviceFee,
    total,
  };
};

// Check availability
router.get('/check-availability', async (req: Request, res: Response) => {
  const { listing_id, check_in, check_out } = req.query;
  const startTime = process.hrtime.bigint();

  if (!listing_id || !check_in || !check_out) {
    return res.status(400).json({ error: 'listing_id, check_in, and check_out are required' });
  }

  try {
    // Get listing details
    const listingResult = await query<ListingRow>(
      'SELECT * FROM listings WHERE id = $1 AND is_active = TRUE',
      [listing_id]
    );

    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const listing = listingResult.rows[0];

    // Check for conflicts
    const conflictResult = await query<{ conflicts: string }>(
      `SELECT COUNT(*) as conflicts
      FROM availability_blocks
      WHERE listing_id = $1
        AND status IN ('booked', 'blocked')
        AND (start_date, end_date) OVERLAPS ($2::date, $3::date)`,
      [listing_id, check_in, check_out]
    );

    const available = parseInt(conflictResult.rows[0].conflicts) === 0;

    // Track metrics
    const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
    metrics.availabilityCheckLatency.observe(durationSeconds);
    metrics.availabilityChecksTotal.inc({ available: available.toString() });

    // Calculate price if available
    let pricing: BookingPricing | null = null;
    if (available) {
      pricing = calculateBookingPrice(listing, String(check_in), String(check_out));
    }

    res.json({
      available,
      pricing,
      instant_book: listing.instant_book,
      minimum_nights: listing.minimum_nights,
      maximum_nights: listing.maximum_nights,
    });
  } catch (error) {
    log.error({ error, listingId: listing_id }, 'Check availability error');
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

// Create booking (with double-booking prevention)
router.post('/', authenticate, async (req, res) => {
  const { listing_id, check_in, check_out, guests, message } = req.body;
  const startTime = process.hrtime.bigint();

  if (!listing_id || !check_in || !check_out) {
    return res.status(400).json({ error: 'listing_id, check_in, and check_out are required' });
  }

  try {
    const result = await transaction(async (client) => {
      // Lock the listing row to prevent concurrent bookings
      const listingResult = await client.query(
        'SELECT * FROM listings WHERE id = $1 FOR UPDATE',
        [listing_id]
      );

      if (listingResult.rows.length === 0) {
        throw new Error('Listing not found');
      }

      const listing = listingResult.rows[0];

      // Verify guest is not the host
      if (listing.host_id === req.user!.id) {
        throw new Error('Cannot book your own listing');
      }

      // Check minimum/maximum nights
      const checkInDate = new Date(check_in);
      const checkOutDate = new Date(check_out);
      const nights = Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));

      if (nights < listing.minimum_nights) {
        throw new Error(`Minimum stay is ${listing.minimum_nights} nights`);
      }

      if (nights > listing.maximum_nights) {
        throw new Error(`Maximum stay is ${listing.maximum_nights} nights`);
      }

      // Check guest count
      if (guests && guests > listing.max_guests) {
        throw new Error(`Maximum guests is ${listing.max_guests}`);
      }

      // Check for conflicts within the transaction
      const conflictResult = await client.query(
        `SELECT COUNT(*) as conflicts
        FROM availability_blocks
        WHERE listing_id = $1
          AND status IN ('booked', 'blocked')
          AND (start_date, end_date) OVERLAPS ($2::date, $3::date)`,
        [listing_id, check_in, check_out]
      );

      if (parseInt(conflictResult.rows[0].conflicts) > 0) {
        throw new Error('Dates are no longer available');
      }

      // Calculate pricing
      const pricing = calculateBookingPrice(listing, check_in, check_out);

      // Create the booking
      const status = listing.instant_book ? 'confirmed' : 'pending';

      const bookingResult = await client.query(
        `INSERT INTO bookings (
          listing_id, guest_id, check_in, check_out, guests,
          nights, price_per_night, cleaning_fee, service_fee, total_price,
          status, guest_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
        [
          listing_id, req.user!.id, check_in, check_out, guests || 1,
          pricing.nights, pricing.pricePerNight, pricing.cleaningFee,
          pricing.serviceFee, pricing.total, status, message,
        ]
      );

      const newBooking = bookingResult.rows[0];

      // Block the dates
      await client.query(
        `INSERT INTO availability_blocks (listing_id, start_date, end_date, status, booking_id)
        VALUES ($1, $2, $3, 'booked', $4)`,
        [listing_id, check_in, check_out, newBooking.id]
      );

      return { booking: newBooking, listing };
    });

    const { booking, listing } = result;

    // Track metrics
    const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
    metrics.bookingLatency.observe({ instant_book: listing.instant_book.toString() }, durationSeconds);
    metrics.bookingsTotal.inc({ status: booking.status, instant_book: listing.instant_book.toString() });
    metrics.bookingRevenue.inc({ property_type: listing.property_type || 'unknown', city: listing.city || 'unknown' }, Math.round(booking.total_price * 100));
    metrics.bookingNights.inc({ property_type: listing.property_type || 'unknown' }, booking.nights);

    // Invalidate availability cache
    await invalidateAvailabilityCache(listing_id);

    // Audit log
    await auditBooking(AUDIT_EVENTS.BOOKING_CREATED, booking, req, {
      metadata: { hostId: listing.host_id },
    });

    // Publish event to queue for async processing (notifications, etc.)
    try {
      await publishBookingCreated(booking, listing);

      // Alert host about new booking
      await publishHostAlert(listing.host_id, 'new_booking', {
        bookingId: booking.id,
        guestName: req.user!.name,
        checkIn: check_in,
        checkOut: check_out,
        listingTitle: listing.title,
      });
    } catch (queueError) {
      // Don't fail the booking if queue publishing fails
      log.error({ error: queueError }, 'Failed to publish booking event to queue');
    }

    log.info({ bookingId: booking.id, listingId: listing_id, guestId: req.user!.id }, 'Booking created');

    res.status(201).json({ booking });
  } catch (error) {
    log.error({ error, listingId: listing_id }, 'Create booking error');
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to create booking' });
  }
});

// Get guest's bookings
router.get('/my-trips', authenticate, async (req, res) => {
  const { status } = req.query;

  try {
    let sql = `
      SELECT b.*,
        l.title as listing_title,
        l.city as listing_city,
        l.state as listing_state,
        l.country as listing_country,
        (SELECT url FROM listing_photos WHERE listing_id = l.id ORDER BY display_order LIMIT 1) as listing_photo,
        u.name as host_name,
        u.avatar_url as host_avatar
      FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      JOIN users u ON l.host_id = u.id
      WHERE b.guest_id = $1
    `;

    const params: (number | string)[] = [req.user!.id];

    if (status) {
      params.push(String(status));
      sql += ` AND b.status = $2`;
    }

    sql += ' ORDER BY b.check_in DESC';

    const result = await query(sql, params);
    res.json({ bookings: result.rows });
  } catch (error) {
    log.error({ error }, 'Get trips error');
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// Get host's booking requests
router.get('/host-reservations', authenticate, requireHost, async (req, res) => {
  const { status } = req.query;

  try {
    let sql = `
      SELECT b.*,
        l.title as listing_title,
        l.id as listing_id,
        (SELECT url FROM listing_photos WHERE listing_id = l.id ORDER BY display_order LIMIT 1) as listing_photo,
        u.name as guest_name,
        u.email as guest_email,
        u.avatar_url as guest_avatar
      FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      JOIN users u ON b.guest_id = u.id
      WHERE l.host_id = $1
    `;

    const params: (number | string)[] = [req.user!.id];

    if (status) {
      params.push(String(status));
      sql += ` AND b.status = $2`;
    }

    sql += ' ORDER BY b.created_at DESC';

    const result = await query(sql, params);
    res.json({ bookings: result.rows });
  } catch (error) {
    log.error({ error }, 'Get host reservations error');
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
});

// Get single booking
router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await query(
      `SELECT b.*,
        l.title as listing_title,
        l.city as listing_city,
        l.state as listing_state,
        l.country as listing_country,
        l.address_line1,
        l.house_rules,
        l.host_id,
        ST_X(l.location::geometry) as longitude,
        ST_Y(l.location::geometry) as latitude,
        (SELECT array_agg(url ORDER BY display_order) FROM listing_photos WHERE listing_id = l.id) as listing_photos,
        h.name as host_name,
        h.avatar_url as host_avatar,
        h.phone as host_phone,
        g.name as guest_name,
        g.avatar_url as guest_avatar,
        g.phone as guest_phone
      FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      JOIN users h ON l.host_id = h.id
      JOIN users g ON b.guest_id = g.id
      WHERE b.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = result.rows[0];

    // Verify access (guest or host)
    if (booking.guest_id !== req.user!.id && booking.host_id !== req.user!.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    res.json({ booking });
  } catch (error) {
    log.error({ error, bookingId: id }, 'Get booking error');
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// Host: Confirm or decline booking
router.put('/:id/respond', authenticate, requireHost, async (req, res) => {
  const { id } = req.params;
  const { action, message } = req.body;

  if (!['confirm', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'Action must be confirm or decline' });
  }

  try {
    // Verify host ownership
    const bookingResult = await query<BookingRow & { host_id: number; listing_title: string }>(
      `SELECT b.*, l.host_id, l.title as listing_title FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      WHERE b.id = $1 AND l.host_id = $2 AND b.status = 'pending'`,
      [id, req.user!.id]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found or not pending' });
    }

    const beforeState = bookingResult.rows[0];

    if (action === 'confirm') {
      await query(
        `UPDATE bookings SET status = 'confirmed', host_response = $2 WHERE id = $1`,
        [id, message]
      );

      // Track confirmed booking
      metrics.bookingsTotal.inc({ status: 'confirmed', instant_book: 'false' });

      // Audit log
      await auditBooking(AUDIT_EVENTS.BOOKING_CONFIRMED, { ...beforeState, status: 'confirmed' }, req, {
        before: { status: beforeState.status },
        after: { status: 'confirmed' },
      });

      // Publish confirmation event
      try {
        await publishBookingConfirmed({ ...beforeState, status: 'confirmed' });
      } catch (queueError) {
        log.error({ error: queueError }, 'Failed to publish booking confirmed event');
      }
    } else {
      // Decline: also unblock the dates
      await transaction(async (client) => {
        await client.query(
          `UPDATE bookings SET status = 'declined', host_response = $2 WHERE id = $1`,
          [id, message]
        );

        await client.query(
          'DELETE FROM availability_blocks WHERE booking_id = $1',
          [id]
        );
      });

      // Invalidate availability cache
      await invalidateAvailabilityCache(beforeState.listing_id);

      // Track declined booking
      metrics.bookingsTotal.inc({ status: 'declined', instant_book: 'false' });

      // Audit log
      await auditBooking(AUDIT_EVENTS.BOOKING_DECLINED, { ...beforeState, status: 'declined' }, req, {
        before: { status: beforeState.status },
        after: { status: 'declined' },
      });
    }

    log.info({ bookingId: id, action }, 'Booking response');
    res.json({ message: `Booking ${action}ed` });
  } catch (error) {
    log.error({ error, bookingId: id }, 'Respond to booking error');
    res.status(500).json({ error: 'Failed to respond to booking' });
  }
});

// Cancel booking
router.put('/:id/cancel', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    // Get booking with listing info
    const bookingResult = await query<BookingRow & { host_id: number; listing_title: string }>(
      `SELECT b.*, l.host_id, l.title as listing_title FROM bookings b
      JOIN listings l ON b.listing_id = l.id
      WHERE b.id = $1 AND b.status IN ('pending', 'confirmed')`,
      [id]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found or not cancellable' });
    }

    const booking = bookingResult.rows[0];

    // Verify access
    const isGuest = booking.guest_id === req.user!.id;
    const isHost = booking.host_id === req.user!.id;

    if (!isGuest && !isHost) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const cancelledBy = isGuest ? 'guest' : 'host';

    await transaction(async (client) => {
      await client.query(
        `UPDATE bookings SET
          status = 'cancelled',
          cancelled_by = $2,
          cancelled_at = NOW()
        WHERE id = $1`,
        [id, cancelledBy]
      );

      await client.query(
        'DELETE FROM availability_blocks WHERE booking_id = $1',
        [id]
      );
    });

    // Invalidate availability cache
    await invalidateAvailabilityCache(booking.listing_id);

    // Track cancelled booking
    metrics.bookingsTotal.inc({ status: 'cancelled', instant_book: 'false' });

    // Audit log
    await auditBooking(AUDIT_EVENTS.BOOKING_CANCELLED, { ...booking, status: 'cancelled' }, req, {
      before: { status: booking.status },
      after: { status: 'cancelled', cancelledBy },
      metadata: { cancelledBy },
    });

    // Publish cancellation event
    try {
      await publishBookingCancelled({ ...booking, status: 'cancelled' }, cancelledBy);

      // Alert the other party
      const alertRecipient = isGuest ? booking.host_id : booking.guest_id;
      await publishHostAlert(alertRecipient, 'booking_cancelled', {
        bookingId: booking.id,
        cancelledBy,
        listingTitle: booking.listing_title,
        checkIn: booking.check_in,
        checkOut: booking.check_out,
      });
    } catch (queueError) {
      log.error({ error: queueError }, 'Failed to publish booking cancelled event');
    }

    log.info({ bookingId: id, cancelledBy }, 'Booking cancelled');
    res.json({ message: 'Booking cancelled' });
  } catch (error) {
    log.error({ error, bookingId: id }, 'Cancel booking error');
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

// Complete booking (after checkout)
router.put('/:id/complete', authenticate, requireHost, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await query<BookingRow>(
      `UPDATE bookings b
      SET status = 'completed'
      FROM listings l
      WHERE b.listing_id = l.id
        AND b.id = $1
        AND l.host_id = $2
        AND b.status = 'confirmed'
        AND b.check_out <= CURRENT_DATE
      RETURNING b.*`,
      [id, req.user!.id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Booking not found or cannot be completed' });
    }

    const booking = result.rows[0];

    // Audit log
    await auditBooking(AUDIT_EVENTS.BOOKING_COMPLETED, booking, req);

    log.info({ bookingId: id }, 'Booking completed');
    res.json({ booking });
  } catch (error) {
    log.error({ error, bookingId: id }, 'Complete booking error');
    res.status(500).json({ error: 'Failed to complete booking' });
  }
});

export default router;
