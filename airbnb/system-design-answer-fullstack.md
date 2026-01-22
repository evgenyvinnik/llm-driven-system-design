# Airbnb - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

Design a property rental marketplace like Airbnb. Key fullstack challenges include:
- End-to-end booking flow from search to confirmation
- Availability calendar with complex UI interactions and backend consistency
- Geographic search with map-based UI and PostGIS backend
- Two-sided review system with hidden-until-both-submit logic
- Real-time messaging between hosts and guests

## Requirements Clarification

### Functional Requirements
1. **List**: Hosts create property listings with photos, amenities, pricing
2. **Search**: Guests find properties by location, dates, and filters
3. **Book**: Reserve properties with payment processing
4. **Review**: Two-way rating system after stays
5. **Message**: Host-guest communication

### Non-Functional Requirements
- **Availability**: 99.9% for search functionality
- **Consistency**: Strong consistency for bookings (no double-booking)
- **Latency**: < 200ms for search results
- **Scale**: 10M listings, 1M bookings/day

## High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React + TypeScript)                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │  SearchPage  │  │ ListingPage  │  │  BookingFlow │  │ HostDashboard│            │
│  │  - SearchBar │  │ - PhotoGrid  │  │ - Calendar   │  │ - Calendar   │            │
│  │  - MapView   │  │ - BookWidget │  │ - Payment    │  │ - Listings   │            │
│  │  - Results   │  │ - Reviews    │  │ - Confirm    │  │ - Reservations│           │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘            │
└────────────────────────────────────────────────────────────────────────────────────┘
                                       │
                              API Gateway (nginx)
                                       │
┌────────────────────────────────────────────────────────────────────────────────────┐
│                        BACKEND (Node.js + Express)                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                     │
│  │ Listing Service │  │ Booking Service │  │ Search Service  │                     │
│  │ - CRUD listings │  │ - Create booking│  │ - Geo search    │                     │
│  │ - Photo upload  │  │ - Prevent double│  │ - Availability  │                     │
│  │ - Calendar mgmt │  │ - Cancellation  │  │ - Ranking       │                     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘                     │
└────────────────────────────────────────────────────────────────────────────────────┘
                                       │
┌────────────────────────────────────────────────────────────────────────────────────┐
│                              DATA LAYER                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                     │
│  │   PostgreSQL    │  │   Valkey/Redis  │  │    RabbitMQ     │                     │
│  │   + PostGIS     │  │   - Session     │  │   - Notifications│                    │
│  │   - Listings    │  │   - Cache       │  │   - Email       │                     │
│  │   - Bookings    │  │   - Rate limit  │  │   - Analytics   │                     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘                     │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive 1: End-to-End Booking Flow

The booking flow demonstrates fullstack integration across all layers.

### Frontend: Booking Widget Component

```tsx
interface BookingWidgetProps {
  listing: Listing;
  onBook: (booking: BookingRequest) => void;
}

function BookingWidget({ listing, onBook }: BookingWidgetProps) {
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [guests, setGuests] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [availability, setAvailability] = useState<AvailabilityBlock[]>([]);

  // Fetch availability when component mounts or dates change
  useEffect(() => {
    async function fetchAvailability() {
      const response = await api.getAvailability(listing.id, {
        start: startOfMonth(new Date()),
        end: addMonths(new Date(), 3)
      });
      setAvailability(response.blocks);
    }
    fetchAvailability();
  }, [listing.id]);

  // Calculate pricing
  const pricing = useMemo(() => {
    if (!dateRange) return null;

    const nights = differenceInDays(dateRange.end, dateRange.start);
    const subtotal = listing.pricePerNight * nights;
    const cleaningFee = listing.cleaningFee;
    const serviceFee = subtotal * 0.10; // 10% service fee

    return {
      nights,
      subtotal,
      cleaningFee,
      serviceFee,
      total: subtotal + cleaningFee + serviceFee
    };
  }, [dateRange, listing]);

  async function handleBook() {
    if (!dateRange || !pricing) return;

    setIsLoading(true);
    try {
      // Optimistic UI: Show loading state
      const booking = await api.createBooking({
        listingId: listing.id,
        checkIn: dateRange.start,
        checkOut: dateRange.end,
        guests,
        totalPrice: pricing.total
      });

      onBook(booking);
    } catch (error) {
      if (error.code === 'DATES_UNAVAILABLE') {
        // Refresh availability and show error
        await fetchAvailability();
        toast.error('These dates are no longer available');
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="booking-widget p-6 border rounded-lg shadow-lg">
      <div className="price-header text-2xl font-bold">
        ${listing.pricePerNight} <span className="text-sm font-normal">/ night</span>
      </div>

      <Calendar
        selectedRange={dateRange}
        onRangeSelect={setDateRange}
        blockedDates={availability.filter(b => b.status !== 'available')}
        minimumNights={listing.minimumNights}
      />

      <GuestSelector
        value={guests}
        onChange={setGuests}
        max={listing.maxGuests}
      />

      {pricing && (
        <PriceBreakdown
          nights={pricing.nights}
          pricePerNight={listing.pricePerNight}
          cleaningFee={pricing.cleaningFee}
          serviceFee={pricing.serviceFee}
          total={pricing.total}
        />
      )}

      <button
        onClick={handleBook}
        disabled={!dateRange || isLoading}
        className="w-full bg-rose-500 text-white py-3 rounded-lg"
      >
        {listing.instantBook ? 'Reserve' : 'Request to Book'}
      </button>
    </div>
  );
}
```

### Backend: Booking API with Double-Booking Prevention

```typescript
// POST /api/v1/bookings
router.post('/bookings', authenticate, async (req, res) => {
  const { listingId, checkIn, checkOut, guests, guestMessage } = req.body;
  const guestId = req.user.id;

  try {
    const booking = await db.transaction(async (trx) => {
      // 1. Lock the listing row to prevent concurrent bookings
      const [listing] = await trx.raw(
        'SELECT * FROM listings WHERE id = ? FOR UPDATE',
        [listingId]
      ).then(r => r.rows);

      if (!listing) {
        throw new ApiError(404, 'LISTING_NOT_FOUND', 'Listing not found');
      }

      // 2. Check for conflicting bookings
      const conflicts = await trx('availability_blocks')
        .where('listing_id', listingId)
        .where('status', 'booked')
        .whereRaw('(start_date, end_date) OVERLAPS (?, ?)', [checkIn, checkOut]);

      if (conflicts.length > 0) {
        throw new ApiError(409, 'DATES_UNAVAILABLE', 'Selected dates are no longer available');
      }

      // 3. Calculate pricing
      const nights = differenceInDays(new Date(checkOut), new Date(checkIn));
      const subtotal = listing.price_per_night * nights;
      const serviceFee = subtotal * (listing.service_fee_percent / 100);
      const totalPrice = subtotal + listing.cleaning_fee + serviceFee;

      // 4. Create booking record
      const [booking] = await trx('bookings')
        .insert({
          listing_id: listingId,
          guest_id: guestId,
          check_in: checkIn,
          check_out: checkOut,
          guests,
          nights,
          price_per_night: listing.price_per_night,
          cleaning_fee: listing.cleaning_fee,
          service_fee: serviceFee,
          total_price: totalPrice,
          status: listing.instant_book ? 'confirmed' : 'pending',
          guest_message: guestMessage
        })
        .returning('*');

      // 5. Create availability block
      await trx('availability_blocks').insert({
        listing_id: listingId,
        start_date: checkIn,
        end_date: checkOut,
        status: 'booked',
        booking_id: booking.id
      });

      // 6. Create conversation for host-guest messaging
      await trx('conversations').insert({
        listing_id: listingId,
        booking_id: booking.id,
        host_id: listing.host_id,
        guest_id: guestId
      });

      return booking;
    });

    // Publish event for async processing (notifications, analytics)
    await publishEvent('booking.created', {
      bookingId: booking.id,
      listingId,
      hostId: listing.host_id,
      guestId,
      checkIn,
      checkOut
    });

    // Audit log
    await logAuditEvent({
      type: 'booking.created',
      userId: guestId,
      resourceType: 'booking',
      resourceId: booking.id,
      action: 'create',
      outcome: 'success',
      ip: req.ip,
      metadata: { checkIn, checkOut, totalPrice: booking.total_price }
    });

    // Invalidate cache
    await redis.del(`availability:${listingId}`);

    res.status(201).json(booking);
  } catch (error) {
    if (error instanceof ApiError) {
      res.status(error.status).json({ code: error.code, message: error.message });
    } else {
      console.error('Booking error:', error);
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to create booking' });
    }
  }
});
```

### Data Flow Diagram

```
User clicks "Reserve"
         │
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ BookingWidget   │────▶│ api.createBooking│────▶│  POST /bookings │
│ (React)         │     │ (API Client)    │     │  (Express)      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                         │
                                                         ▼
                                               ┌─────────────────┐
                                               │  BEGIN          │
                                               │  TRANSACTION    │
                                               └────────┬────────┘
         ┌───────────────────────────────────────────────┼───────────────────────────┐
         │                                               │                           │
         ▼                                               ▼                           ▼
┌─────────────────┐                          ┌─────────────────┐          ┌─────────────────┐
│ SELECT listing  │                          │ Check conflicts │          │ INSERT booking  │
│ FOR UPDATE      │                          │ OVERLAPS query  │          │ INSERT avail    │
│ (row lock)      │                          │                 │          │ INSERT convo    │
└─────────────────┘                          └─────────────────┘          └─────────────────┘
         │                                               │                           │
         └───────────────────────────────────────────────┴───────────────────────────┘
                                               │
                                               ▼
                                    ┌─────────────────┐
                                    │     COMMIT      │
                                    └────────┬────────┘
                                             │
         ┌───────────────────────────────────┼───────────────────────────┐
         │                                   │                           │
         ▼                                   ▼                           ▼
┌─────────────────┐                ┌─────────────────┐          ┌─────────────────┐
│ Publish event   │                │ Invalidate      │          │ Return booking  │
│ to RabbitMQ     │                │ Redis cache     │          │ to frontend     │
└─────────────────┘                └─────────────────┘          └─────────────────┘
         │                                                               │
         ▼                                                               ▼
┌─────────────────┐                                            ┌─────────────────┐
│ Notification    │                                            │ Show success    │
│ Worker sends    │                                            │ Redirect to     │
│ email/push      │                                            │ trips page      │
└─────────────────┘                                            └─────────────────┘
```

## Deep Dive 2: Geographic Search Pipeline

### Frontend: Search Page with Map

```tsx
function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [listings, setListings] = useState<Listing[]>([]);
  const [mapBounds, setMapBounds] = useState<Bounds | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Parse search params from URL
  const searchState = useMemo(() => ({
    location: searchParams.get('location') || '',
    lat: parseFloat(searchParams.get('lat') || '0'),
    lon: parseFloat(searchParams.get('lon') || '0'),
    checkIn: searchParams.get('checkIn'),
    checkOut: searchParams.get('checkOut'),
    guests: parseInt(searchParams.get('guests') || '1'),
    priceMin: parseInt(searchParams.get('priceMin') || '0'),
    priceMax: parseInt(searchParams.get('priceMax') || '1000'),
    propertyType: searchParams.get('propertyType')?.split(',') || []
  }), [searchParams]);

  // Fetch listings when search params change
  useEffect(() => {
    async function fetchListings() {
      setIsLoading(true);
      try {
        const response = await api.searchListings({
          lat: searchState.lat,
          lon: searchState.lon,
          radius: 25000, // 25km
          checkIn: searchState.checkIn,
          checkOut: searchState.checkOut,
          guests: searchState.guests,
          priceMin: searchState.priceMin,
          priceMax: searchState.priceMax,
          propertyTypes: searchState.propertyType
        });
        setListings(response.listings);
      } finally {
        setIsLoading(false);
      }
    }

    if (searchState.lat && searchState.lon) {
      fetchListings();
    }
  }, [searchState]);

  // Update URL when filters change
  function handleFilterChange(updates: Partial<SearchState>) {
    const newParams = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([key, value]) => {
      if (value) newParams.set(key, String(value));
      else newParams.delete(key);
    });
    setSearchParams(newParams);
  }

  return (
    <div className="flex h-screen">
      {/* Left: Results List */}
      <div className="w-1/2 overflow-y-auto p-4">
        <SearchFilters
          filters={searchState}
          onChange={handleFilterChange}
        />

        {isLoading ? (
          <ListingSkeleton count={6} />
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {listings.map(listing => (
              <ListingCard
                key={listing.id}
                listing={listing}
                onHover={() => setHighlightedMarker(listing.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Right: Map */}
      <div className="w-1/2 sticky top-0 h-screen">
        <MapView
          center={{ lat: searchState.lat, lon: searchState.lon }}
          listings={listings}
          onBoundsChange={setMapBounds}
          highlightedMarker={highlightedMarker}
        />
      </div>
    </div>
  );
}
```

### Backend: Combined Geo + Availability Search

```typescript
// GET /api/v1/search
router.get('/search', async (req, res) => {
  const {
    lat, lon, radius = 25000,
    checkIn, checkOut,
    guests = 1,
    priceMin = 0, priceMax = 10000,
    propertyTypes,
    amenities,
    sort = 'relevance',
    page = 1, limit = 20
  } = req.query;

  // Build the search query
  const offset = (page - 1) * limit;

  // Step 1: Geographic + basic filter query
  let query = db('listings')
    .select([
      'listings.*',
      db.raw(`ST_Distance(location, ST_MakePoint(?, ?)::geography) as distance`, [lon, lat])
    ])
    .whereRaw(`ST_DWithin(location, ST_MakePoint(?, ?)::geography, ?)`, [lon, lat, radius])
    .where('is_active', true)
    .where('max_guests', '>=', guests)
    .whereBetween('price_per_night', [priceMin, priceMax]);

  // Property type filter
  if (propertyTypes?.length) {
    query = query.whereIn('property_type', propertyTypes);
  }

  // Amenities filter (array overlap)
  if (amenities?.length) {
    query = query.whereRaw('amenities && ?', [amenities]);
  }

  // Step 2: Availability filter (if dates provided)
  if (checkIn && checkOut) {
    query = query.whereNotIn('id', function() {
      this.select('listing_id')
        .from('availability_blocks')
        .where('status', '!=', 'available')
        .whereRaw(`(start_date, end_date) OVERLAPS (?, ?)`, [checkIn, checkOut]);
    });
  }

  // Step 3: Sorting
  switch (sort) {
    case 'price_low':
      query = query.orderBy('price_per_night', 'asc');
      break;
    case 'price_high':
      query = query.orderBy('price_per_night', 'desc');
      break;
    case 'rating':
      query = query.orderBy('rating', 'desc').orderBy('review_count', 'desc');
      break;
    case 'distance':
      query = query.orderBy('distance', 'asc');
      break;
    case 'relevance':
    default:
      // Composite score: rating * 0.4 + review_count_log * 0.3 + inverse_distance * 0.3
      query = query.orderByRaw(`
        COALESCE(rating, 3) * 0.4 +
        LOG(review_count + 1) * 0.3 +
        (1 - distance / ?) * 0.3 DESC
      `, [radius]);
  }

  // Pagination
  const [{ count }] = await db('listings')
    .count()
    .whereRaw(`ST_DWithin(location, ST_MakePoint(?, ?)::geography, ?)`, [lon, lat, radius]);

  const listings = await query.limit(limit).offset(offset);

  // Fetch primary photos for each listing
  const listingIds = listings.map(l => l.id);
  const photos = await db('listing_photos')
    .whereIn('listing_id', listingIds)
    .where('display_order', 0);

  const photoMap = new Map(photos.map(p => [p.listing_id, p.url]));

  res.json({
    listings: listings.map(l => ({
      ...l,
      primaryPhoto: photoMap.get(l.id) || null,
      distance: Math.round(l.distance) // meters
    })),
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: parseInt(count),
      totalPages: Math.ceil(count / limit)
    }
  });
});
```

### Database: PostGIS Spatial Index

```sql
-- listings table with PostGIS
CREATE TABLE listings (
  id SERIAL PRIMARY KEY,
  host_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  location GEOGRAPHY(POINT, 4326),  -- WGS84 lat/lon
  city VARCHAR(100),
  country VARCHAR(100),
  property_type VARCHAR(50),
  max_guests INTEGER NOT NULL DEFAULT 1,
  price_per_night DECIMAL(10, 2) NOT NULL,
  cleaning_fee DECIMAL(10, 2) DEFAULT 0,
  rating DECIMAL(2, 1),
  review_count INTEGER DEFAULT 0,
  amenities TEXT[],
  instant_book BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Spatial index for efficient geo queries
CREATE INDEX idx_listings_location ON listings USING GIST(location);

-- Composite indexes for common filter combinations
CREATE INDEX idx_listings_active_price ON listings(is_active, price_per_night);
CREATE INDEX idx_listings_property_type ON listings(property_type) WHERE is_active = TRUE;
```

## Deep Dive 3: Availability Calendar System

### Frontend: Calendar Component

```tsx
interface CalendarProps {
  listingId: number;
  selectedRange: DateRange | null;
  onRangeSelect: (range: DateRange | null) => void;
  blockedDates: AvailabilityBlock[];
  minimumNights: number;
}

function Calendar({
  listingId,
  selectedRange,
  onRangeSelect,
  blockedDates,
  minimumNights
}: CalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()));
  const [hoverDate, setHoverDate] = useState<Date | null>(null);

  // Build set of blocked dates for O(1) lookup
  const blockedSet = useMemo(() => {
    const set = new Set<string>();
    blockedDates.forEach(block => {
      let current = new Date(block.startDate);
      const end = new Date(block.endDate);
      while (current < end) {
        set.add(format(current, 'yyyy-MM-dd'));
        current = addDays(current, 1);
      }
    });
    return set;
  }, [blockedDates]);

  // Check if date is selectable
  const isBlocked = (date: Date) => blockedSet.has(format(date, 'yyyy-MM-dd'));
  const isPast = (date: Date) => isBefore(date, startOfDay(new Date()));

  // Handle date click for range selection
  function handleDateClick(date: Date) {
    if (isBlocked(date) || isPast(date)) return;

    if (!selectedRange || selectedRange.end) {
      // Start new range
      onRangeSelect({ start: date, end: null });
    } else {
      // Complete range
      if (isBefore(date, selectedRange.start)) {
        onRangeSelect({ start: date, end: selectedRange.start });
      } else {
        // Validate minimum nights
        const nights = differenceInDays(date, selectedRange.start);
        if (nights < minimumNights) {
          toast.error(`Minimum stay is ${minimumNights} nights`);
          return;
        }

        // Check for blocked dates within range
        const hasBlockedInRange = eachDayOfInterval({
          start: selectedRange.start,
          end: date
        }).some(d => isBlocked(d));

        if (hasBlockedInRange) {
          toast.error('Selected range includes unavailable dates');
          return;
        }

        onRangeSelect({ start: selectedRange.start, end: date });
      }
    }
  }

  // Render calendar grid
  const days = eachDayOfInterval({
    start: startOfMonth(currentMonth),
    end: endOfMonth(currentMonth)
  });

  return (
    <div className="calendar">
      <div className="flex justify-between mb-4">
        <button onClick={() => setCurrentMonth(addMonths(currentMonth, -1))}>
          <ChevronLeft />
        </button>
        <span className="font-semibold">
          {format(currentMonth, 'MMMM yyyy')}
        </span>
        <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}>
          <ChevronRight />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
          <div key={day} className="text-center text-sm text-gray-500">
            {day}
          </div>
        ))}

        {days.map(day => {
          const dateStr = format(day, 'yyyy-MM-dd');
          const blocked = isBlocked(day);
          const past = isPast(day);
          const isStart = selectedRange?.start && isSameDay(day, selectedRange.start);
          const isEnd = selectedRange?.end && isSameDay(day, selectedRange.end);
          const inRange = selectedRange?.start && selectedRange?.end &&
            isWithinInterval(day, { start: selectedRange.start, end: selectedRange.end });

          return (
            <button
              key={dateStr}
              onClick={() => handleDateClick(day)}
              onMouseEnter={() => setHoverDate(day)}
              disabled={blocked || past}
              className={cn(
                'p-2 rounded-full text-sm',
                blocked && 'line-through text-gray-300 cursor-not-allowed',
                past && 'text-gray-300 cursor-not-allowed',
                isStart && 'bg-rose-500 text-white',
                isEnd && 'bg-rose-500 text-white',
                inRange && !isStart && !isEnd && 'bg-rose-100',
                !blocked && !past && 'hover:bg-gray-100'
              )}
            >
              {format(day, 'd')}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

### Backend: Calendar Update with Overlap Handling

```typescript
// PUT /api/v1/listings/:id/calendar
router.put('/listings/:id/calendar', authenticate, async (req, res) => {
  const listingId = parseInt(req.params.id);
  const { startDate, endDate, status, pricePerNight } = req.body;
  const userId = req.user.id;

  // Verify ownership
  const listing = await db('listings').where({ id: listingId, host_id: userId }).first();
  if (!listing) {
    return res.status(404).json({ error: 'Listing not found' });
  }

  // Cannot modify dates that are already booked
  if (status !== 'booked') {
    const bookedConflicts = await db('availability_blocks')
      .where('listing_id', listingId)
      .where('status', 'booked')
      .whereRaw('(start_date, end_date) OVERLAPS (?, ?)', [startDate, endDate]);

    if (bookedConflicts.length > 0) {
      return res.status(409).json({ error: 'Cannot modify dates with existing bookings' });
    }
  }

  await db.transaction(async (trx) => {
    // Find overlapping blocks
    const overlaps = await trx('availability_blocks')
      .where('listing_id', listingId)
      .where('status', '!=', 'booked')
      .whereRaw('(start_date, end_date) OVERLAPS (?, ?)', [startDate, endDate]);

    // Process each overlapping block: split into before/after segments
    for (const block of overlaps) {
      // Create segment before the new block (if exists)
      if (block.start_date < startDate) {
        await trx('availability_blocks').insert({
          listing_id: listingId,
          start_date: block.start_date,
          end_date: startDate,
          status: block.status,
          price_per_night: block.price_per_night
        });
      }

      // Create segment after the new block (if exists)
      if (block.end_date > endDate) {
        await trx('availability_blocks').insert({
          listing_id: listingId,
          start_date: endDate,
          end_date: block.end_date,
          status: block.status,
          price_per_night: block.price_per_night
        });
      }

      // Delete the original overlapping block
      await trx('availability_blocks').where('id', block.id).delete();
    }

    // Insert the new block
    await trx('availability_blocks').insert({
      listing_id: listingId,
      start_date: startDate,
      end_date: endDate,
      status,
      price_per_night: pricePerNight || listing.price_per_night
    });
  });

  // Invalidate cache
  await redis.del(`availability:${listingId}`);

  res.json({ success: true });
});
```

## Deep Dive 4: Two-Sided Review System

### Frontend: Review Submission Flow

```tsx
function ReviewSubmission({ booking, userRole }: ReviewProps) {
  const [rating, setRating] = useState(5);
  const [content, setContent] = useState('');
  const [categoryRatings, setCategoryRatings] = useState({
    cleanliness: 5,
    communication: 5,
    location: 5,
    value: 5
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    setIsSubmitting(true);
    try {
      await api.submitReview({
        bookingId: booking.id,
        authorType: userRole, // 'host' or 'guest'
        rating,
        content,
        ...(userRole === 'guest' && { categoryRatings })
      });

      toast.success(
        'Review submitted! It will be visible once both parties have reviewed.'
      );
    } catch (error) {
      toast.error('Failed to submit review');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="review-form max-w-lg mx-auto">
      <h2 className="text-xl font-bold mb-4">
        {userRole === 'guest'
          ? `How was your stay at ${booking.listing.title}?`
          : `How was ${booking.guest.name} as a guest?`
        }
      </h2>

      <StarRating value={rating} onChange={setRating} label="Overall Rating" />

      {userRole === 'guest' && (
        <>
          <StarRating
            value={categoryRatings.cleanliness}
            onChange={(v) => setCategoryRatings(r => ({ ...r, cleanliness: v }))}
            label="Cleanliness"
          />
          <StarRating
            value={categoryRatings.communication}
            onChange={(v) => setCategoryRatings(r => ({ ...r, communication: v }))}
            label="Communication"
          />
          <StarRating
            value={categoryRatings.location}
            onChange={(v) => setCategoryRatings(r => ({ ...r, location: v }))}
            label="Location"
          />
          <StarRating
            value={categoryRatings.value}
            onChange={(v) => setCategoryRatings(r => ({ ...r, value: v }))}
            label="Value"
          />
        </>
      )}

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Share your experience..."
        className="w-full p-3 border rounded-lg"
        rows={5}
      />

      <p className="text-sm text-gray-500 mt-2">
        Your review will remain private until both parties submit their reviews.
        This ensures fair and honest feedback.
      </p>

      <button
        onClick={handleSubmit}
        disabled={isSubmitting || !content.trim()}
        className="w-full bg-rose-500 text-white py-3 rounded-lg mt-4"
      >
        {isSubmitting ? 'Submitting...' : 'Submit Review'}
      </button>
    </div>
  );
}
```

### Backend: Review with Triggers

```sql
-- Reviews table with hidden-until-both pattern
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_type VARCHAR(10) NOT NULL CHECK (author_type IN ('host', 'guest')),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  cleanliness_rating INTEGER CHECK (cleanliness_rating >= 1 AND cleanliness_rating <= 5),
  communication_rating INTEGER CHECK (communication_rating >= 1 AND communication_rating <= 5),
  location_rating INTEGER CHECK (location_rating >= 1 AND location_rating <= 5),
  value_rating INTEGER CHECK (value_rating >= 1 AND value_rating <= 5),
  content TEXT,
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(booking_id, author_type)
);

-- Trigger: Check if both parties reviewed, then publish both
CREATE OR REPLACE FUNCTION check_and_publish_reviews()
RETURNS TRIGGER AS $$
DECLARE
  other_review RECORD;
BEGIN
  -- Find the other party's review for this booking
  SELECT * INTO other_review
  FROM reviews
  WHERE booking_id = NEW.booking_id
    AND author_type != NEW.author_type;

  -- If both exist and neither is public yet, publish both
  IF FOUND AND NOT other_review.is_public THEN
    UPDATE reviews
    SET is_public = TRUE
    WHERE booking_id = NEW.booking_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_publish_reviews_trigger
  AFTER INSERT ON reviews
  FOR EACH ROW
  EXECUTE FUNCTION check_and_publish_reviews();

-- Trigger: Update listing rating when guest review becomes public
CREATE OR REPLACE FUNCTION update_listing_rating()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_public = TRUE AND NEW.author_type = 'guest' AND OLD.is_public = FALSE THEN
    UPDATE listings
    SET rating = (
      SELECT AVG(rating)::DECIMAL(2,1)
      FROM reviews r
      JOIN bookings b ON r.booking_id = b.id
      WHERE b.listing_id = (
        SELECT listing_id FROM bookings WHERE id = NEW.booking_id
      )
      AND r.author_type = 'guest'
      AND r.is_public = TRUE
    ),
    review_count = (
      SELECT COUNT(*)
      FROM reviews r
      JOIN bookings b ON r.booking_id = b.id
      WHERE b.listing_id = (
        SELECT listing_id FROM bookings WHERE id = NEW.booking_id
      )
      AND r.author_type = 'guest'
      AND r.is_public = TRUE
    )
    WHERE id = (SELECT listing_id FROM bookings WHERE id = NEW.booking_id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_listing_rating_trigger
  AFTER UPDATE OF is_public ON reviews
  FOR EACH ROW
  EXECUTE FUNCTION update_listing_rating();
```

### Review API Endpoint

```typescript
// POST /api/v1/reviews
router.post('/reviews', authenticate, async (req, res) => {
  const { bookingId, rating, content, categoryRatings } = req.body;
  const userId = req.user.id;

  // Get booking details
  const booking = await db('bookings')
    .join('listings', 'bookings.listing_id', 'listings.id')
    .where('bookings.id', bookingId)
    .select('bookings.*', 'listings.host_id')
    .first();

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // Determine author type
  let authorType: 'host' | 'guest';
  if (userId === booking.guest_id) {
    authorType = 'guest';
  } else if (userId === booking.host_id) {
    authorType = 'host';
  } else {
    return res.status(403).json({ error: 'Not authorized to review this booking' });
  }

  // Verify booking is completed
  if (booking.status !== 'completed') {
    return res.status(400).json({ error: 'Can only review completed bookings' });
  }

  // Check if already reviewed
  const existingReview = await db('reviews')
    .where({ booking_id: bookingId, author_type: authorType })
    .first();

  if (existingReview) {
    return res.status(409).json({ error: 'Already reviewed this booking' });
  }

  // Insert review (trigger handles publication logic)
  const [review] = await db('reviews')
    .insert({
      booking_id: bookingId,
      author_id: userId,
      author_type: authorType,
      rating,
      content,
      cleanliness_rating: categoryRatings?.cleanliness,
      communication_rating: categoryRatings?.communication,
      location_rating: categoryRatings?.location,
      value_rating: categoryRatings?.value
    })
    .returning('*');

  // Invalidate listing cache if published
  if (review.is_public) {
    await redis.del(`listing:${booking.listing_id}`);
  }

  res.status(201).json(review);
});
```

## Deep Dive 5: Host Dashboard Calendar Management

### Frontend: Host Calendar View

```tsx
function HostCalendarPage() {
  const { listingId } = useParams();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [availability, setAvailability] = useState<AvailabilityBlock[]>([]);
  const [selectedDates, setSelectedDates] = useState<Date[]>([]);
  const [bulkAction, setBulkAction] = useState<'block' | 'unblock' | 'price'>('block');
  const [customPrice, setCustomPrice] = useState<number | null>(null);

  // Fetch availability for 3-month view
  useEffect(() => {
    async function fetchAvailability() {
      const response = await api.getHostAvailability(listingId, {
        start: startOfMonth(addMonths(currentMonth, -1)),
        end: endOfMonth(addMonths(currentMonth, 1))
      });
      setAvailability(response.blocks);
    }
    fetchAvailability();
  }, [listingId, currentMonth]);

  // Build date status map
  const dateStatus = useMemo(() => {
    const map = new Map<string, { status: string; price: number; bookingId?: number }>();
    availability.forEach(block => {
      let current = new Date(block.startDate);
      const end = new Date(block.endDate);
      while (current < end) {
        map.set(format(current, 'yyyy-MM-dd'), {
          status: block.status,
          price: block.pricePerNight,
          bookingId: block.bookingId
        });
        current = addDays(current, 1);
      }
    });
    return map;
  }, [availability]);

  // Apply bulk action to selected dates
  async function handleBulkAction() {
    if (selectedDates.length === 0) return;

    // Group consecutive dates into ranges
    const ranges = groupConsecutiveDates(selectedDates);

    for (const range of ranges) {
      await api.updateCalendar(listingId, {
        startDate: range.start,
        endDate: range.end,
        status: bulkAction === 'block' ? 'blocked' : 'available',
        pricePerNight: bulkAction === 'price' ? customPrice : undefined
      });
    }

    // Refresh availability
    const response = await api.getHostAvailability(listingId, {
      start: startOfMonth(addMonths(currentMonth, -1)),
      end: endOfMonth(addMonths(currentMonth, 1))
    });
    setAvailability(response.blocks);
    setSelectedDates([]);
    toast.success('Calendar updated');
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Manage Availability</h1>

      {/* Bulk action toolbar */}
      {selectedDates.length > 0 && (
        <div className="bg-gray-100 p-4 rounded-lg mb-4 flex items-center gap-4">
          <span>{selectedDates.length} dates selected</span>

          <select
            value={bulkAction}
            onChange={(e) => setBulkAction(e.target.value as any)}
            className="border rounded px-3 py-2"
          >
            <option value="block">Block dates</option>
            <option value="unblock">Unblock dates</option>
            <option value="price">Set custom price</option>
          </select>

          {bulkAction === 'price' && (
            <input
              type="number"
              value={customPrice || ''}
              onChange={(e) => setCustomPrice(parseFloat(e.target.value))}
              placeholder="Price per night"
              className="border rounded px-3 py-2 w-32"
            />
          )}

          <button
            onClick={handleBulkAction}
            className="bg-rose-500 text-white px-4 py-2 rounded"
          >
            Apply
          </button>

          <button
            onClick={() => setSelectedDates([])}
            className="text-gray-600"
          >
            Clear
          </button>
        </div>
      )}

      {/* Calendar grid */}
      <HostCalendarGrid
        month={currentMonth}
        dateStatus={dateStatus}
        selectedDates={selectedDates}
        onDateToggle={(date) => {
          const status = dateStatus.get(format(date, 'yyyy-MM-dd'));
          // Cannot modify booked dates
          if (status?.status === 'booked') return;

          setSelectedDates(prev => {
            const dateStr = format(date, 'yyyy-MM-dd');
            const exists = prev.some(d => format(d, 'yyyy-MM-dd') === dateStr);
            if (exists) {
              return prev.filter(d => format(d, 'yyyy-MM-dd') !== dateStr);
            }
            return [...prev, date];
          });
        }}
        onMonthChange={setCurrentMonth}
      />

      {/* Legend */}
      <div className="flex gap-6 mt-4 text-sm">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-green-100 rounded"></div>
          <span>Available</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-gray-300 rounded"></div>
          <span>Blocked</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-rose-200 rounded"></div>
          <span>Booked</span>
        </div>
      </div>
    </div>
  );
}
```

## State Management Architecture

### Zustand Stores

```typescript
// stores/authStore.ts
interface AuthState {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,

  login: async (email, password) => {
    const response = await api.login({ email, password });
    set({ user: response.user });
  },

  logout: async () => {
    await api.logout();
    set({ user: null });
  },

  checkAuth: async () => {
    try {
      const response = await api.getMe();
      set({ user: response.user, isLoading: false });
    } catch {
      set({ user: null, isLoading: false });
    }
  }
}));

// stores/searchStore.ts
interface SearchState {
  location: string;
  coordinates: { lat: number; lon: number } | null;
  dateRange: { checkIn: Date; checkOut: Date } | null;
  guests: number;
  filters: SearchFilters;
  setLocation: (location: string, coords: { lat: number; lon: number }) => void;
  setDateRange: (range: { checkIn: Date; checkOut: Date } | null) => void;
  setGuests: (guests: number) => void;
  setFilters: (filters: Partial<SearchFilters>) => void;
  clear: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  location: '',
  coordinates: null,
  dateRange: null,
  guests: 1,
  filters: {
    priceMin: 0,
    priceMax: 1000,
    propertyTypes: [],
    amenities: [],
    instantBook: false
  },

  setLocation: (location, coordinates) => set({ location, coordinates }),
  setDateRange: (dateRange) => set({ dateRange }),
  setGuests: (guests) => set({ guests }),
  setFilters: (filters) => set((state) => ({
    filters: { ...state.filters, ...filters }
  })),
  clear: () => set({
    location: '',
    coordinates: null,
    dateRange: null,
    guests: 1,
    filters: { priceMin: 0, priceMax: 1000, propertyTypes: [], amenities: [], instantBook: false }
  })
}));
```

## API Client Architecture

```typescript
// services/api.ts
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

class ApiClient {
  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: 'include', // Send cookies for session auth
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new ApiError(response.status, error.code, error.message);
    }

    return response.json();
  }

  // Auth
  login = (data: LoginRequest) =>
    this.request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(data) });

  logout = () =>
    this.request('/auth/logout', { method: 'POST' });

  getMe = () =>
    this.request<{ user: User }>('/auth/me');

  // Search
  searchListings = (params: SearchParams) =>
    this.request<SearchResponse>(`/search?${new URLSearchParams(params as any)}`);

  // Listings
  getListing = (id: number) =>
    this.request<Listing>(`/listings/${id}`);

  getAvailability = (listingId: number, params: { start: string; end: string }) =>
    this.request<{ blocks: AvailabilityBlock[] }>(
      `/listings/${listingId}/availability?${new URLSearchParams(params)}`
    );

  updateCalendar = (listingId: number, data: CalendarUpdate) =>
    this.request(`/listings/${listingId}/calendar`, { method: 'PUT', body: JSON.stringify(data) });

  // Bookings
  createBooking = (data: BookingRequest) =>
    this.request<Booking>('/bookings', { method: 'POST', body: JSON.stringify(data) });

  getMyTrips = () =>
    this.request<{ bookings: Booking[] }>('/bookings/trips');

  getHostReservations = () =>
    this.request<{ reservations: Booking[] }>('/bookings/reservations');

  // Reviews
  submitReview = (data: ReviewRequest) =>
    this.request<Review>('/reviews', { method: 'POST', body: JSON.stringify(data) });

  getListingReviews = (listingId: number) =>
    this.request<{ reviews: Review[] }>(`/listings/${listingId}/reviews`);
}

export const api = new ApiClient();
```

## Caching Strategy Integration

### Backend Cache Layer

```typescript
// shared/cache.ts
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const TTL = {
  LISTING: 900,      // 15 minutes
  AVAILABILITY: 60,  // 1 minute
  SEARCH: 300,       // 5 minutes
  SESSION: 86400     // 24 hours
};

export async function getCached<T>(key: string): Promise<T | null> {
  const cached = await redis.get(key);
  return cached ? JSON.parse(cached) : null;
}

export async function setCache(key: string, value: any, ttl: number): Promise<void> {
  await redis.setex(key, ttl, JSON.stringify(value));
}

export async function invalidate(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// Cache-aside pattern for listings
export async function getListingCached(listingId: number): Promise<Listing | null> {
  const cacheKey = `listing:${listingId}`;

  let listing = await getCached<Listing>(cacheKey);
  if (listing) return listing;

  listing = await db('listings').where('id', listingId).first();
  if (listing) {
    await setCache(cacheKey, listing, TTL.LISTING);
  }

  return listing;
}
```

### Frontend Query Caching

```tsx
// Using React Query for server state caching
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

function useListingQuery(listingId: number) {
  return useQuery({
    queryKey: ['listing', listingId],
    queryFn: () => api.getListing(listingId),
    staleTime: 15 * 60 * 1000, // 15 minutes
    cacheTime: 30 * 60 * 1000  // 30 minutes
  });
}

function useCreateBooking() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.createBooking,
    onSuccess: (booking) => {
      // Invalidate availability cache for this listing
      queryClient.invalidateQueries(['availability', booking.listingId]);
      // Invalidate trips list
      queryClient.invalidateQueries(['trips']);
    }
  });
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Fullstack Rationale |
|----------|--------|-------------|---------------------|
| Calendar storage | Date ranges | Day-by-day | 18x fewer rows; frontend handles range display; backend handles split/merge |
| Geo search | PostGIS | Elasticsearch | Single DB simplifies stack; API returns distance for map markers |
| Double-booking | Transaction lock | Distributed lock | Single DB is simpler; frontend shows optimistic UI with error handling |
| Reviews | Hidden until both | Immediate | Trigger-based automation; frontend shows clear status messaging |
| State management | Zustand | Redux | Simpler API; sufficient for search/auth state |
| API caching | React Query | Manual useState | Automatic stale/refetch; reduces boilerplate |
| Session auth | Cookies | JWT | HttpOnly cookies secure; automatic credential sending |
| Form state | Custom hooks | Form library | Multi-step wizard needs custom navigation logic |

## Future Fullstack Enhancements

1. **Real-time updates** - WebSocket notifications for booking confirmations and messages
2. **Optimistic UI** - Show booking success immediately, handle conflicts gracefully
3. **Map clustering** - Frontend clustering for dense listing areas
4. **Smart pricing** - ML-based price suggestions with host override UI
5. **Image optimization** - CDN integration with responsive srcset
6. **Offline support** - Service worker for browsing cached listings
7. **A/B testing** - Feature flags for search ranking experiments
8. **Analytics dashboard** - Host metrics with charts (bookings, views, conversion)
