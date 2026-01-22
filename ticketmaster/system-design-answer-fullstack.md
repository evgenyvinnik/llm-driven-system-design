# Ticketmaster - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing an event ticketing platform like Ticketmaster, covering both the backend systems for handling traffic spikes and preventing overselling, and the frontend experience for seat selection and checkout. The key is designing the end-to-end flow where fast Redis locks enable responsive seat selection while PostgreSQL transactions ensure no double-selling."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Event Browsing** - Search and discover events with filtering
2. **Interactive Seat Selection** - Visual seat map with real-time availability
3. **Virtual Waiting Room** - Fair queue system for high-demand events
4. **Ticket Purchase** - Reserve seats, checkout with countdown, payment processing
5. **Order Management** - View tickets and order history

### Non-Functional Requirements

- **Scalability**: Handle 100x traffic spikes during on-sales
- **Consistency**: Zero overselling - each seat sold exactly once
- **Latency**: Seat reservation < 100ms, seat map load < 200ms
- **Availability**: 99.9% uptime, no downtime during high-profile events

### Full-Stack Focus Areas

- Shared TypeScript types between frontend and backend
- End-to-end seat reservation flow with optimistic UI
- Queue position polling with automatic admission
- Checkout flow with synchronized timer
- Real-time availability synchronization

---

## 2. High-Level Architecture (5 minutes)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React + TypeScript)                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ Event        │  │ Seat Map     │  │ Waiting      │  │ Checkout  │ │
│  │ Discovery    │  │ (Canvas)     │  │ Room         │  │ Timer     │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘ │
└─────────┼─────────────────┼─────────────────┼────────────────┼───────┘
          │                 │                 │                │
          └─────────────────┼─────────────────┼────────────────┘
                            │                 │
                     ┌──────▼─────────────────▼──────┐
                     │    API (Express + TypeScript)  │
                     │                                │
                     │  /events    - Event browsing   │
                     │  /seats     - Availability     │
                     │  /reserve   - Seat locking     │
                     │  /queue     - Waiting room     │
                     │  /checkout  - Payment          │
                     └────────────┬───────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
       ┌────────────┐     ┌─────────────┐    ┌─────────────┐
       │   Redis    │     │ PostgreSQL  │    │  (Future)   │
       │            │     │             │    │  RabbitMQ   │
       │ - Locks    │     │ - Events    │    │             │
       │ - Sessions │     │ - Seats     │    │ - Notifs    │
       │ - Queue    │     │ - Orders    │    │ - Cleanup   │
       │ - Cache    │     │ - Users     │    │             │
       └────────────┘     └─────────────┘    └─────────────┘
```

---

## 3. Shared Type Definitions (5 minutes)

### Core Types (shared/types.ts)

```typescript
// Event and venue types
export interface Venue {
  id: string;
  name: string;
  address: string;
  city: string;
  capacity: number;
  sectionConfig: SectionConfig[];
}

export interface SectionConfig {
  name: string;
  rows: number;
  seatsPerRow: number;
  priceCategory: 'premium' | 'standard' | 'economy';
}

export interface Event {
  id: string;
  name: string;
  venueId: string;
  venue?: Venue;
  eventDate: Date;
  onSaleDate: Date;
  status: 'upcoming' | 'on_sale' | 'sold_out' | 'completed' | 'cancelled';
  highDemand: boolean;
}

// Seat types with status state machine
export type SeatStatus = 'available' | 'held' | 'sold';

export interface Seat {
  id: string;
  eventId: string;
  section: string;
  row: string;
  seatNumber: string;
  price: number;
  status: SeatStatus;
}

export interface SeatAvailability {
  [seatId: string]: SeatStatus;
}

// Reservation types
export interface Reservation {
  sessionId: string;
  eventId: string;
  seatIds: string[];
  totalAmount: number;
  expiresAt: Date;
  status: 'active' | 'expired' | 'completed';
}

// Queue types
export interface QueuePosition {
  position: number;
  estimatedWait: number; // seconds
  status: 'queued' | 'active' | 'not_in_queue';
}

// Order types
export interface Order {
  id: string;
  userId: string;
  eventId: string;
  status: 'pending' | 'completed' | 'cancelled' | 'refunded';
  totalAmount: number;
  paymentId?: string;
  seats: Seat[];
  createdAt: Date;
  completedAt?: Date;
}

// API response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ReserveSeatsRequest {
  eventId: string;
  seatIds: string[];
}

export interface ReserveSeatsResponse {
  reservation: Reservation;
  unavailableSeats: string[];
}

export interface CheckoutRequest {
  idempotencyKey: string;
  paymentMethod: {
    type: 'card';
    cardNumber: string;
    expiry: string;
    cvc: string;
  };
}
```

---

## 4. End-to-End Seat Reservation Flow (12 minutes)

### Frontend: Seat Selection with Optimistic Updates

```typescript
// stores/seatSelectionStore.ts
interface SeatSelectionStore {
  eventId: string | null;
  selectedSeats: string[];
  reservation: Reservation | null;
  isReserving: boolean;
  addSeat: (seatId: string) => void;
  removeSeat: (seatId: string) => void;
  reserveSeats: () => Promise<ReserveSeatsResponse>;
}

const useSeatSelectionStore = create<SeatSelectionStore>((set, get) => ({
  eventId: null,
  selectedSeats: [],
  reservation: null,
  isReserving: false,

  addSeat: (seatId: string) => {
    const { selectedSeats } = get();
    if (selectedSeats.length >= 6) {
      toast.error('Maximum 6 seats per transaction');
      return;
    }
    set({ selectedSeats: [...selectedSeats, seatId] });
  },

  removeSeat: (seatId: string) => {
    set((state) => ({
      selectedSeats: state.selectedSeats.filter((id) => id !== seatId),
    }));
  },

  reserveSeats: async () => {
    const { eventId, selectedSeats } = get();
    if (!eventId || selectedSeats.length === 0) {
      throw new Error('No seats selected');
    }

    set({ isReserving: true });

    try {
      const response = await api.post<ReserveSeatsResponse>('/api/seats/reserve', {
        eventId,
        seatIds: selectedSeats,
      });

      if (response.unavailableSeats.length > 0) {
        // Some seats were taken - remove them from selection
        set((state) => ({
          selectedSeats: state.selectedSeats.filter(
            (id) => !response.unavailableSeats.includes(id)
          ),
        }));
        toast.warning(`${response.unavailableSeats.length} seats were just taken`);
      }

      if (response.reservation) {
        set({ reservation: response.reservation });
      }

      return response;
    } finally {
      set({ isReserving: false });
    }
  },
}));
```

### Backend: Two-Phase Reservation

```typescript
// routes/seats.ts
router.post('/reserve', requireAuth, async (req, res) => {
  const { eventId, seatIds } = req.body as ReserveSeatsRequest;
  const sessionId = req.session.id;

  const HOLD_DURATION = 600; // 10 minutes

  try {
    // Phase 1: Acquire Redis locks
    const lockResults = await acquireMultipleSeatLocks(
      eventId,
      seatIds,
      sessionId,
      HOLD_DURATION
    );

    const acquiredSeats = lockResults.filter((r) => r.acquired).map((r) => r.seatId);
    const unavailableSeats = lockResults.filter((r) => !r.acquired).map((r) => r.seatId);

    if (acquiredSeats.length === 0) {
      return res.status(409).json({
        success: false,
        error: 'All selected seats are unavailable',
        unavailableSeats,
      });
    }

    // Phase 2: Database transaction
    const holdUntil = new Date(Date.now() + HOLD_DURATION * 1000);

    await pool.query('BEGIN');
    try {
      // Lock and verify seats
      const { rows: seats } = await pool.query(`
        SELECT id, status, price
        FROM seats
        WHERE event_id = $1 AND id = ANY($2)
        FOR UPDATE NOWAIT
      `, [eventId, acquiredSeats]);

      // Double-check availability at DB level
      const availableInDb = seats.filter((s) => s.status === 'available');
      const unavailableInDb = seats.filter((s) => s.status !== 'available');

      if (unavailableInDb.length > 0) {
        // Release Redis locks for unavailable seats
        for (const seat of unavailableInDb) {
          await releaseSeatLock(eventId, seat.id, lockResults.find((r) => r.seatId === seat.id)?.token);
        }
        unavailableSeats.push(...unavailableInDb.map((s) => s.id));
      }

      if (availableInDb.length === 0) {
        await pool.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: 'All selected seats are unavailable',
          unavailableSeats,
        });
      }

      // Update seats to held
      const availableIds = availableInDb.map((s) => s.id);
      await pool.query(`
        UPDATE seats
        SET status = 'held',
            held_by_session = $1,
            held_until = $2
        WHERE id = ANY($3)
      `, [sessionId, holdUntil, availableIds]);

      await pool.query('COMMIT');

      // Calculate total
      const totalAmount = availableInDb.reduce((sum, s) => sum + parseFloat(s.price), 0);

      // Store reservation in Redis for quick lookup
      const reservation: Reservation = {
        sessionId,
        eventId,
        seatIds: availableIds,
        totalAmount,
        expiresAt: holdUntil,
        status: 'active',
      };

      await redis.setex(
        `reservation:${sessionId}`,
        HOLD_DURATION,
        JSON.stringify(reservation)
      );

      // Invalidate availability cache
      await redis.del(`availability:${eventId}`);

      res.json({
        success: true,
        data: {
          reservation,
          unavailableSeats,
        },
      });
    } catch (error) {
      await pool.query('ROLLBACK');
      // Release all acquired locks
      for (const result of lockResults.filter((r) => r.acquired)) {
        await releaseSeatLock(eventId, result.seatId, result.token);
      }
      throw error;
    }
  } catch (error) {
    logger.error('Reservation failed', { error, eventId, seatIds });
    res.status(500).json({ success: false, error: 'Reservation failed' });
  }
});

// Redis lock helpers
async function acquireMultipleSeatLocks(
  eventId: string,
  seatIds: string[],
  sessionId: string,
  ttl: number
): Promise<{ seatId: string; acquired: boolean; token?: string }[]> {
  const results = [];

  for (const seatId of seatIds) {
    const lockKey = `lock:seat:${eventId}:${seatId}`;
    const token = crypto.randomUUID();

    const acquired = await redis.set(lockKey, token, {
      NX: true,
      EX: ttl,
    });

    results.push({
      seatId,
      acquired: acquired === 'OK',
      token: acquired === 'OK' ? token : undefined,
    });
  }

  return results;
}
```

### Frontend: Reservation Countdown

```typescript
// components/checkout/ReservationTimer.tsx
function ReservationTimer({ expiresAt }: { expiresAt: Date }) {
  const [timeRemaining, setTimeRemaining] = useState<number>(0);
  const navigate = useNavigate();
  const { clearSelection } = useSeatSelectionStore();

  useEffect(() => {
    const calculateRemaining = () => {
      const now = new Date();
      return Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
    };

    setTimeRemaining(calculateRemaining());

    const interval = setInterval(() => {
      const remaining = calculateRemaining();
      setTimeRemaining(remaining);

      if (remaining === 0) {
        clearInterval(interval);
        toast.error('Your reservation has expired');
        clearSelection();
        navigate('/');
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt, navigate, clearSelection]);

  const isUrgent = timeRemaining < 120; // Last 2 minutes
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = timeRemaining % 60;

  return (
    <div
      className={`p-4 rounded-lg ${
        isUrgent ? 'bg-red-100 border-red-300' : 'bg-blue-100 border-blue-300'
      } border`}
    >
      <div className="flex items-center justify-between">
        <span className={isUrgent ? 'text-red-700' : 'text-blue-700'}>
          Complete purchase within:
        </span>
        <span
          className={`text-2xl font-bold tabular-nums ${
            isUrgent ? 'text-red-600 animate-pulse' : 'text-blue-600'
          }`}
        >
          {minutes}:{seconds.toString().padStart(2, '0')}
        </span>
      </div>
    </div>
  );
}
```

---

## 5. Virtual Waiting Room Flow (8 minutes)

### Backend: Queue Management

```typescript
// routes/queue.ts
const MAX_CONCURRENT_SHOPPERS = 5000;
const SHOPPING_WINDOW = 900; // 15 minutes

router.post('/:eventId/join', requireAuth, async (req, res) => {
  const { eventId } = req.params;
  const sessionId = req.session.id;

  const queueKey = `queue:${eventId}`;
  const activeKey = `active:${eventId}`;

  // Check if already active
  const isActive = await redis.exists(`active_session:${eventId}:${sessionId}`);
  if (isActive) {
    return res.json({
      success: true,
      data: { position: 0, estimatedWait: 0, status: 'active' },
    });
  }

  // Check if already in queue
  const existingRank = await redis.zrank(queueKey, sessionId);
  if (existingRank !== null) {
    const position = existingRank + 1;
    return res.json({
      success: true,
      data: {
        position,
        estimatedWait: estimateWait(position),
        status: 'queued',
      },
    });
  }

  // Add to queue
  const timestamp = Date.now() / 1000;
  await redis.zadd(queueKey, timestamp, sessionId);

  const rank = await redis.zrank(queueKey, sessionId);
  const position = (rank ?? 0) + 1;

  res.json({
    success: true,
    data: {
      position,
      estimatedWait: estimateWait(position),
      status: 'queued',
    },
  });
});

router.get('/:eventId/position', requireAuth, async (req, res) => {
  const { eventId } = req.params;
  const sessionId = req.session.id;

  // Check if admitted
  const isActive = await redis.exists(`active_session:${eventId}:${sessionId}`);
  if (isActive) {
    return res.json({
      success: true,
      data: { position: 0, status: 'active' },
    });
  }

  // Check queue position
  const rank = await redis.zrank(`queue:${eventId}`, sessionId);
  if (rank === null) {
    return res.json({
      success: true,
      data: { position: -1, status: 'not_in_queue' },
    });
  }

  const position = rank + 1;
  res.json({
    success: true,
    data: {
      position,
      estimatedWait: estimateWait(position),
      status: 'queued',
    },
  });
});

// Background worker to admit users
async function admitFromQueue(eventId: string): Promise<number> {
  const activeKey = `active:${eventId}`;
  const queueKey = `queue:${eventId}`;

  const activeCount = await redis.scard(activeKey);
  const slotsAvailable = MAX_CONCURRENT_SHOPPERS - activeCount;

  if (slotsAvailable <= 0) return 0;

  const nextUsers = await redis.zrange(queueKey, 0, slotsAvailable - 1);
  if (nextUsers.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const sessionId of nextUsers) {
    pipeline.sadd(activeKey, sessionId);
    pipeline.setex(`active_session:${eventId}:${sessionId}`, SHOPPING_WINDOW, '1');
  }
  pipeline.zrem(queueKey, ...nextUsers);
  await pipeline.exec();

  return nextUsers.length;
}

function estimateWait(position: number): number {
  // Assume 500 users processed per minute
  return Math.ceil(position / 500) * 60;
}
```

### Frontend: Queue Polling and Auto-Redirect

```typescript
// hooks/useQueuePolling.ts
function useQueuePolling(eventId: string) {
  const [queueState, setQueueState] = useState<QueuePosition>({
    position: 0,
    estimatedWait: 0,
    status: 'queued',
  });
  const navigate = useNavigate();

  useEffect(() => {
    let isMounted = true;
    let pollInterval: number;

    const joinAndPoll = async () => {
      try {
        // Join queue
        const joinResult = await api.post<QueuePosition>(`/api/queue/${eventId}/join`);

        if (!isMounted) return;

        if (joinResult.status === 'active') {
          setQueueState(joinResult);
          navigate(`/events/${eventId}`);
          return;
        }

        setQueueState(joinResult);

        // Start polling
        pollInterval = setInterval(async () => {
          try {
            const position = await api.get<QueuePosition>(`/api/queue/${eventId}/position`);

            if (!isMounted) return;

            setQueueState(position);

            if (position.status === 'active') {
              clearInterval(pollInterval);
              toast.success("You're in! Redirecting to seat selection...");
              navigate(`/events/${eventId}`);
            }
          } catch (error) {
            console.error('Queue poll error:', error);
          }
        }, 3000);
      } catch (error) {
        console.error('Queue join error:', error);
      }
    };

    joinAndPoll();

    return () => {
      isMounted = false;
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [eventId, navigate]);

  return queueState;
}

// pages/QueuePage.tsx
function QueuePage() {
  const { eventId } = useParams();
  const queueState = useQueuePolling(eventId!);

  return (
    <div className="min-h-screen bg-gradient-to-b from-purple-900 to-indigo-900 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 text-center">
        <QueueAnimation />

        <h1 className="text-2xl font-bold mb-2">You're in the Queue</h1>

        <div className="text-6xl font-bold text-indigo-600 my-8 tabular-nums">
          {queueState.position.toLocaleString()}
        </div>
        <p className="text-gray-500">people ahead of you</p>

        <div className="mt-6 bg-gray-100 rounded-lg p-4">
          <div className="flex justify-between">
            <span className="text-gray-600">Estimated wait:</span>
            <span className="font-semibold">
              {formatWaitTime(queueState.estimatedWait)}
            </span>
          </div>
        </div>

        <p className="mt-6 text-gray-500 text-sm">
          Don't refresh - we'll redirect you automatically
        </p>
      </div>
    </div>
  );
}
```

---

## 6. Checkout with Idempotency (8 minutes)

### Backend: Idempotent Checkout

```typescript
// routes/checkout.ts
router.post('/', requireAuth, async (req, res) => {
  const { idempotencyKey, paymentMethod } = req.body as CheckoutRequest;
  const sessionId = req.session.id;
  const userId = req.user.id;

  // 1. Check for existing result (idempotency)
  const existingResult = await redis.get(`idem:${idempotencyKey}`);
  if (existingResult) {
    return res.json(JSON.parse(existingResult));
  }

  const existingOrder = await pool.query(
    'SELECT * FROM orders WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  if (existingOrder.rows[0]) {
    const response = { success: true, data: { order: existingOrder.rows[0] } };
    await redis.setex(`idem:${idempotencyKey}`, 86400, JSON.stringify(response));
    return res.json(response);
  }

  // 2. Get reservation
  const reservationJson = await redis.get(`reservation:${sessionId}`);
  if (!reservationJson) {
    return res.status(400).json({
      success: false,
      error: 'No active reservation',
    });
  }

  const reservation: Reservation = JSON.parse(reservationJson);

  if (new Date() > new Date(reservation.expiresAt)) {
    return res.status(400).json({
      success: false,
      error: 'Reservation expired',
    });
  }

  // 3. Process payment (with circuit breaker)
  let paymentResult;
  try {
    paymentResult = await paymentCircuitBreaker.execute(async () => {
      return processPayment(userId, reservation.totalAmount, paymentMethod);
    });
  } catch (error) {
    logger.error('Payment failed', { error, userId, amount: reservation.totalAmount });
    return res.status(402).json({
      success: false,
      error: 'Payment failed',
    });
  }

  // 4. Complete order in transaction
  await pool.query('BEGIN');
  try {
    const { rows: [order] } = await pool.query(`
      INSERT INTO orders (user_id, event_id, status, total_amount, payment_id, idempotency_key, completed_at)
      VALUES ($1, $2, 'completed', $3, $4, $5, NOW())
      RETURNING *
    `, [userId, reservation.eventId, reservation.totalAmount, paymentResult.id, idempotencyKey]);

    // Update seats to sold
    await pool.query(`
      UPDATE seats
      SET status = 'sold',
          order_id = $1,
          held_by_session = NULL,
          held_until = NULL
      WHERE id = ANY($2)
        AND status = 'held'
        AND held_by_session = $3
    `, [order.id, reservation.seatIds, sessionId]);

    // Insert order items
    for (const seatId of reservation.seatIds) {
      await pool.query(`
        INSERT INTO order_items (order_id, seat_id, price)
        SELECT $1, id, price FROM seats WHERE id = $2
      `, [order.id, seatId]);
    }

    await pool.query('COMMIT');

    // Cleanup
    await redis.del(`reservation:${sessionId}`);
    for (const seatId of reservation.seatIds) {
      await redis.del(`lock:seat:${reservation.eventId}:${seatId}`);
    }
    await redis.del(`availability:${reservation.eventId}`);

    // Cache successful response for idempotency
    const response = { success: true, data: { order } };
    await redis.setex(`idem:${idempotencyKey}`, 86400, JSON.stringify(response));

    res.json(response);
  } catch (error) {
    await pool.query('ROLLBACK');
    logger.error('Checkout transaction failed', { error, userId, reservationId: sessionId });
    res.status(500).json({ success: false, error: 'Checkout failed' });
  }
});
```

### Frontend: Checkout Form with Idempotency Key

```typescript
// pages/CheckoutPage.tsx
function CheckoutPage() {
  const { reservation, clearSelection } = useSeatSelectionStore();
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  if (!reservation) {
    return <Navigate to="/" replace />;
  }

  const handleCheckout = async (paymentData: PaymentData) => {
    setIsSubmitting(true);

    try {
      const result = await api.post<{ order: Order }>('/api/checkout', {
        idempotencyKey: idempotencyKeyRef.current,
        paymentMethod: {
          type: 'card',
          ...paymentData,
        },
      });

      toast.success('Purchase complete!');
      clearSelection();
      navigate(`/orders/${result.order.id}`);
    } catch (error: any) {
      if (error.status === 402) {
        toast.error('Payment declined. Please try a different card.');
      } else {
        toast.error('Checkout failed. Please try again.');
      }
      // Keep same idempotency key for retry
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <ReservationTimer expiresAt={new Date(reservation.expiresAt)} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        <div>
          <h2 className="text-xl font-bold mb-4">Order Summary</h2>
          <SeatSummary seats={reservation.seatIds} eventId={reservation.eventId} />
          <PriceSummary total={reservation.totalAmount} />
        </div>

        <div>
          <h2 className="text-xl font-bold mb-4">Payment</h2>
          <PaymentForm onSubmit={handleCheckout} isSubmitting={isSubmitting} />
        </div>
      </div>
    </div>
  );
}
```

---

## 7. Real-Time Availability Sync (5 minutes)

### Backend: Availability Endpoint with Caching

```typescript
// routes/events.ts
router.get('/:eventId/seats', async (req, res) => {
  const { eventId } = req.params;

  // Try cache first
  const cached = await redis.get(`availability:${eventId}`);
  if (cached) {
    return res.json({ success: true, data: JSON.parse(cached) });
  }

  // Query database
  const { rows: seats } = await pool.query(`
    SELECT id, section, row, seat_number, price, status
    FROM seats
    WHERE event_id = $1
    ORDER BY section, row, seat_number
  `, [eventId]);

  // Get event status for TTL decision
  const { rows: [event] } = await pool.query(
    'SELECT status FROM events WHERE id = $1',
    [eventId]
  );

  const availability: SeatAvailability = {};
  seats.forEach((seat) => {
    availability[seat.id] = seat.status;
  });

  const response = {
    seats: seats.map((s) => ({
      id: s.id,
      section: s.section,
      row: s.row,
      seatNumber: s.seat_number,
      price: parseFloat(s.price),
    })),
    availability,
  };

  // Cache with dynamic TTL
  const ttl = event?.status === 'on_sale' ? 5 : 30;
  await redis.setex(`availability:${eventId}`, ttl, JSON.stringify(response));

  res.json({ success: true, data: response });
});
```

### Frontend: Availability Polling with Diff Detection

```typescript
// hooks/useAvailabilityPolling.ts
function useAvailabilityPolling(eventId: string, isOnSale: boolean) {
  const [seats, setSeats] = useState<Seat[]>([]);
  const [availability, setAvailability] = useState<SeatAvailability>({});
  const prevAvailabilityRef = useRef<SeatAvailability>({});
  const { selectedSeats, removeSeat } = useSeatSelectionStore();

  useEffect(() => {
    let isMounted = true;

    const fetchAvailability = async () => {
      try {
        const data = await api.get<{
          seats: Seat[];
          availability: SeatAvailability;
        }>(`/api/events/${eventId}/seats`);

        if (!isMounted) return;

        setSeats(data.seats);
        setAvailability(data.availability);

        // Check if any selected seats became unavailable
        const prevAvail = prevAvailabilityRef.current;
        for (const seatId of selectedSeats) {
          const wasAvailable = prevAvail[seatId] === 'available';
          const nowUnavailable = data.availability[seatId] !== 'available';

          if (wasAvailable && nowUnavailable) {
            removeSeat(seatId);
            toast.warning('A selected seat was just taken');
          }
        }

        prevAvailabilityRef.current = data.availability;
      } catch (error) {
        console.error('Failed to fetch availability:', error);
      }
    };

    fetchAvailability();

    const pollInterval = isOnSale ? 5000 : 30000;
    const intervalId = setInterval(fetchAvailability, pollInterval);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [eventId, isOnSale, selectedSeats, removeSeat]);

  return { seats, availability };
}
```

---

## 8. Background Cleanup (3 minutes)

### Expired Hold Cleanup Worker

```typescript
// workers/cleanup.ts
async function cleanupExpiredHolds(): Promise<void> {
  const { rows: expired } = await pool.query(`
    UPDATE seats
    SET status = 'available',
        held_by_session = NULL,
        held_until = NULL
    WHERE status = 'held'
      AND held_until < NOW()
    RETURNING id, event_id, held_by_session
  `);

  if (expired.length === 0) return;

  // Clean up Redis locks
  for (const seat of expired) {
    await redis.del(`lock:seat:${seat.event_id}:${seat.id}`);
  }

  // Invalidate caches for affected events
  const eventIds = [...new Set(expired.map((s) => s.event_id))];
  for (const eventId of eventIds) {
    await redis.del(`availability:${eventId}`);
  }

  logger.info('Cleaned up expired holds', {
    count: expired.length,
    events: eventIds.length,
  });
}

// Run every minute
setInterval(cleanupExpiredHolds, 60000);
```

---

## Summary

"I've designed a full-stack event ticketing platform with:

1. **Shared TypeScript types** ensuring consistency between frontend and backend for seats, reservations, and orders
2. **Two-phase seat reservation** with Redis locks (1ms) and PostgreSQL transactions (ACID), with optimistic UI updates on the frontend
3. **Virtual waiting room** with Redis sorted sets for fair queue management and frontend polling with auto-redirect
4. **Idempotent checkout** preventing double-charges through idempotency keys cached in both Redis and PostgreSQL
5. **Real-time availability sync** with dynamic cache TTLs (5s during sales, 30s otherwise) and conflict detection for selected seats

The key full-stack insight is that the frontend optimistically updates seat selections while the backend uses two-phase locking to guarantee consistency - when they diverge, the frontend gracefully handles the conflict by removing unavailable seats and notifying the user."
