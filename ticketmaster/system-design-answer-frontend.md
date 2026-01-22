# Ticketmaster - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing an event ticketing platform like Ticketmaster, with a focus on the frontend experience. The key challenges are building an interactive seat selection map, handling real-time availability updates, creating a stress-free waiting room experience, and managing the countdown-driven checkout flow. Let me clarify requirements."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Event Discovery** - Browse, search, and filter events by location, date, and artist
2. **Interactive Seat Map** - Visual venue layout with clickable seats showing availability and pricing
3. **Virtual Waiting Room UI** - Queue position display with estimated wait time
4. **Checkout Flow** - Countdown timer, seat summary, payment form
5. **Order Management** - View purchase history, ticket details, and digital tickets

### Non-Functional Requirements

- **Responsiveness**: Seat map must work on mobile devices
- **Performance**: Seat map with 10,000+ seats must render smoothly
- **Real-Time Feel**: Availability updates should feel instant
- **Accessibility**: Full keyboard navigation and screen reader support
- **Resilience**: Handle network issues gracefully during checkout

### Frontend Focus Areas

- Canvas/SVG rendering for large seat maps
- State management for seat selection and availability
- Polling strategies for queue position and seat updates
- Countdown timer with visual urgency indicators
- Optimistic UI updates with conflict resolution
- Mobile-first responsive design

---

## 2. Component Architecture (8 minutes)

### Application Structure

```
src/
├── routes/
│   ├── __root.tsx           # Layout with header/navigation
│   ├── index.tsx            # Event discovery page
│   ├── events.$eventId.tsx  # Event detail with seat map
│   ├── queue.$eventId.tsx   # Waiting room
│   ├── checkout.tsx         # Checkout flow
│   ├── orders.tsx           # Order history
│   └── orders.$orderId.tsx  # Order detail / digital ticket
├── components/
│   ├── events/
│   │   ├── EventCard.tsx
│   │   ├── EventFilters.tsx
│   │   └── EventList.tsx
│   ├── seats/
│   │   ├── SeatMap.tsx          # Main seat map component
│   │   ├── SeatMapCanvas.tsx    # Canvas-based rendering
│   │   ├── SeatMapSVG.tsx       # SVG-based rendering (fallback)
│   │   ├── SectionView.tsx      # Zoomed section view
│   │   ├── SeatTooltip.tsx      # Hover tooltip
│   │   └── SeatLegend.tsx       # Color legend
│   ├── queue/
│   │   ├── QueueStatus.tsx      # Position and wait time
│   │   ├── QueueProgress.tsx    # Visual progress indicator
│   │   └── QueueAnimation.tsx   # Animated waiting graphic
│   ├── checkout/
│   │   ├── CheckoutTimer.tsx    # Countdown timer
│   │   ├── SeatSummary.tsx      # Selected seats review
│   │   ├── PaymentForm.tsx      # Payment entry
│   │   └── OrderConfirmation.tsx
│   └── common/
│       ├── LoadingSpinner.tsx
│       ├── ErrorBoundary.tsx
│       └── Toast.tsx
├── stores/
│   ├── authStore.ts
│   ├── eventStore.ts
│   ├── seatSelectionStore.ts
│   └── checkoutStore.ts
├── hooks/
│   ├── useSeatMap.ts
│   ├── useQueuePolling.ts
│   ├── useCheckoutTimer.ts
│   └── useAvailabilityPolling.ts
└── services/
    └── api.ts
```

### Page Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Header: Logo | Search | Events | My Tickets | Profile      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│                     Main Content Area                        │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    Dynamic Routes                        ││
│  │                                                          ││
│  │  /              → Event Discovery Grid                   ││
│  │  /events/:id    → Seat Map + Selection                  ││
│  │  /queue/:id     → Waiting Room                          ││
│  │  /checkout      → Timer + Payment                       ││
│  │  /orders        → Order History                         ││
│  │  /orders/:id    → Digital Ticket                        ││
│  │                                                          ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  Footer: Help | Terms | Privacy                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Deep Dive: Interactive Seat Map (12 minutes)

### Rendering Strategy

For venues with 10,000+ seats, we need efficient rendering:

```typescript
// Use Canvas for performance, SVG for accessibility fallback
interface SeatMapProps {
  eventId: string;
  venueConfig: VenueConfig;
  availability: SeatAvailability;
  selectedSeats: string[];
  onSeatSelect: (seatId: string) => void;
  renderMode?: 'canvas' | 'svg';
}

function SeatMap({
  eventId,
  venueConfig,
  availability,
  selectedSeats,
  onSeatSelect,
  renderMode = 'canvas',
}: SeatMapProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [activeSection, setActiveSection] = useState<string | null>(null);

  // Virtual rendering for large seat counts
  const visibleSeats = useMemo(() => {
    return calculateVisibleSeats(venueConfig, zoom, pan);
  }, [venueConfig, zoom, pan]);

  return (
    <div className="seat-map-container relative">
      {/* Overview at low zoom */}
      {zoom < 2 && (
        <VenueOverview
          config={venueConfig}
          availability={availability}
          onSectionClick={setActiveSection}
        />
      )}

      {/* Detailed view at high zoom or section selected */}
      {(zoom >= 2 || activeSection) && (
        renderMode === 'canvas' ? (
          <SeatMapCanvas
            seats={visibleSeats}
            availability={availability}
            selectedSeats={selectedSeats}
            onSeatClick={onSeatSelect}
            zoom={zoom}
            pan={pan}
          />
        ) : (
          <SeatMapSVG
            seats={visibleSeats}
            availability={availability}
            selectedSeats={selectedSeats}
            onSeatClick={onSeatSelect}
          />
        )
      )}

      {/* Controls */}
      <ZoomControls zoom={zoom} onZoomChange={setZoom} />
      <SeatLegend />
    </div>
  );
}
```

### Canvas-Based Rendering

```typescript
function SeatMapCanvas({
  seats,
  availability,
  selectedSeats,
  onSeatClick,
  zoom,
  pan,
}: SeatMapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredSeat, setHoveredSeat] = useState<Seat | null>(null);

  // Render seats to canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(pan.x, pan.y);

    // Draw all seats
    for (const seat of seats) {
      const status = availability[seat.id];
      const isSelected = selectedSeats.includes(seat.id);

      // Determine color
      let color = SEAT_COLORS.available;
      if (status === 'sold') color = SEAT_COLORS.sold;
      else if (status === 'held') color = SEAT_COLORS.held;
      if (isSelected) color = SEAT_COLORS.selected;

      // Draw seat circle
      ctx.beginPath();
      ctx.arc(seat.x, seat.y, SEAT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Draw border for selected
      if (isSelected) {
        ctx.strokeStyle = SEAT_COLORS.selectedBorder;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    ctx.restore();
  }, [seats, availability, selectedSeats, zoom, pan]);

  // Handle click detection
  const handleClick = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - pan.x) / zoom;
    const y = (e.clientY - rect.top - pan.y) / zoom;

    // Find clicked seat
    const clickedSeat = seats.find((seat) => {
      const dx = seat.x - x;
      const dy = seat.y - y;
      return Math.sqrt(dx * dx + dy * dy) <= SEAT_RADIUS;
    });

    if (clickedSeat && availability[clickedSeat.id] === 'available') {
      onSeatClick(clickedSeat.id);
    }
  };

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        className="cursor-pointer"
      />
      {hoveredSeat && (
        <SeatTooltip
          seat={hoveredSeat}
          availability={availability[hoveredSeat.id]}
        />
      )}
    </div>
  );
}

const SEAT_COLORS = {
  available: '#4CAF50',   // Green
  held: '#FFC107',        // Yellow/amber
  sold: '#9E9E9E',        // Gray
  selected: '#2196F3',    // Blue
  selectedBorder: '#1565C0',
};
```

### Seat Selection State Management

```typescript
interface SeatSelectionState {
  eventId: string | null;
  selectedSeats: string[];
  maxSeats: number;
  reservation: Reservation | null;
  addSeat: (seatId: string) => void;
  removeSeat: (seatId: string) => void;
  clearSelection: () => void;
  reserveSeats: () => Promise<Reservation>;
}

const useSeatSelectionStore = create<SeatSelectionState>((set, get) => ({
  eventId: null,
  selectedSeats: [],
  maxSeats: 6,
  reservation: null,

  addSeat: (seatId: string) => {
    const { selectedSeats, maxSeats } = get();
    if (selectedSeats.length >= maxSeats) {
      toast.error(`Maximum ${maxSeats} seats allowed`);
      return;
    }
    set({ selectedSeats: [...selectedSeats, seatId] });
  },

  removeSeat: (seatId: string) => {
    set((state) => ({
      selectedSeats: state.selectedSeats.filter((id) => id !== seatId),
    }));
  },

  clearSelection: () => {
    set({ selectedSeats: [], reservation: null });
  },

  reserveSeats: async () => {
    const { eventId, selectedSeats } = get();
    if (!eventId || selectedSeats.length === 0) {
      throw new Error('No seats selected');
    }

    const reservation = await api.reserveSeats(eventId, selectedSeats);
    set({ reservation });
    return reservation;
  },
}));
```

### Real-Time Availability Polling

```typescript
function useAvailabilityPolling(eventId: string, isOnSale: boolean) {
  const [availability, setAvailability] = useState<SeatAvailability>({});
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    let isMounted = true;

    const fetchAvailability = async () => {
      try {
        const data = await api.getSeatAvailability(eventId);
        if (isMounted) {
          setAvailability(data);
          setLastUpdate(new Date());
        }
      } catch (error) {
        console.error('Failed to fetch availability:', error);
      }
    };

    // Initial fetch
    fetchAvailability();

    // Poll more frequently during active sales
    const interval = isOnSale ? 5000 : 30000;
    const pollId = setInterval(fetchAvailability, interval);

    return () => {
      isMounted = false;
      clearInterval(pollId);
    };
  }, [eventId, isOnSale]);

  return { availability, lastUpdate };
}
```

### Optimistic Selection with Conflict Resolution

```typescript
async function handleSeatClick(seatId: string) {
  const { selectedSeats, addSeat, removeSeat } = useSeatSelectionStore();

  if (selectedSeats.includes(seatId)) {
    removeSeat(seatId);
    return;
  }

  // Optimistic update
  addSeat(seatId);

  // Verify seat is still available
  try {
    const isAvailable = await api.checkSeatAvailability(eventId, seatId);
    if (!isAvailable) {
      removeSeat(seatId);
      toast.error('Sorry, this seat was just taken');
      // Refresh availability
      refreshAvailability();
    }
  } catch (error) {
    // On error, keep optimistic state but show warning
    toast.warning('Could not verify seat - please try again');
  }
}
```

---

## 4. Deep Dive: Virtual Waiting Room UI (8 minutes)

### Waiting Room Page

```typescript
function QueuePage() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const { position, estimatedWait, status, isAdmitted } = useQueuePolling(eventId);

  useEffect(() => {
    if (isAdmitted) {
      toast.success("You're in! Redirecting to seat selection...");
      navigate(`/events/${eventId}`);
    }
  }, [isAdmitted, eventId, navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-purple-900 to-indigo-900 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4">
        <QueueAnimation />

        <h1 className="text-2xl font-bold text-center mb-2">
          You're in the Queue
        </h1>

        <QueuePosition position={position} />

        <QueueProgress
          position={position}
          totalAhead={position}
          estimatedWait={estimatedWait}
        />

        <div className="mt-6 text-center text-gray-600">
          <p>Don't refresh this page.</p>
          <p>We'll let you in automatically.</p>
        </div>

        <QueueTips />
      </div>
    </div>
  );
}
```

### Queue Position Display

```typescript
function QueuePosition({ position }: { position: number }) {
  const [displayPosition, setDisplayPosition] = useState(position);

  // Animate position changes
  useEffect(() => {
    if (position === displayPosition) return;

    const step = position < displayPosition ? -1 : 1;
    const interval = setInterval(() => {
      setDisplayPosition((prev) => {
        if (prev === position) {
          clearInterval(interval);
          return prev;
        }
        return prev + step;
      });
    }, 50);

    return () => clearInterval(interval);
  }, [position, displayPosition]);

  return (
    <div className="text-center my-8">
      <div className="text-6xl font-bold text-indigo-600 tabular-nums">
        {displayPosition.toLocaleString()}
      </div>
      <div className="text-gray-500 mt-2">people ahead of you</div>
    </div>
  );
}
```

### Estimated Wait Time

```typescript
function QueueProgress({
  position,
  estimatedWait,
}: {
  position: number;
  estimatedWait: number;
}) {
  const formatWait = (seconds: number): string => {
    if (seconds < 60) return 'Less than a minute';
    const minutes = Math.ceil(seconds / 60);
    if (minutes === 1) return 'About 1 minute';
    if (minutes < 60) return `About ${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `About ${hours}h ${remainingMinutes}m`;
  };

  return (
    <div className="bg-gray-100 rounded-lg p-4">
      <div className="flex justify-between items-center">
        <span className="text-gray-600">Estimated wait:</span>
        <span className="font-semibold text-indigo-600">
          {formatWait(estimatedWait)}
        </span>
      </div>

      {/* Visual progress bar */}
      <div className="mt-3 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-indigo-600 rounded-full transition-all duration-1000"
          style={{ width: `${Math.max(5, 100 - position / 100)}%` }}
        />
      </div>
    </div>
  );
}
```

### Queue Polling Hook

```typescript
function useQueuePolling(eventId: string) {
  const [queueState, setQueueState] = useState({
    position: 0,
    estimatedWait: 0,
    status: 'loading' as 'loading' | 'queued' | 'active' | 'error',
  });

  useEffect(() => {
    let isMounted = true;
    let pollInterval: number;

    const joinQueue = async () => {
      try {
        const result = await api.joinQueue(eventId);
        if (!isMounted) return;

        if (result.status === 'active') {
          setQueueState({ ...result, status: 'active' });
          return;
        }

        setQueueState({ ...result, status: 'queued' });

        // Start polling for position updates
        pollInterval = setInterval(async () => {
          try {
            const updated = await api.getQueuePosition(eventId);
            if (!isMounted) return;

            if (updated.status === 'active') {
              clearInterval(pollInterval);
            }

            setQueueState({ ...updated });
          } catch (error) {
            console.error('Queue poll failed:', error);
          }
        }, 3000); // Poll every 3 seconds
      } catch (error) {
        if (isMounted) {
          setQueueState((prev) => ({ ...prev, status: 'error' }));
        }
      }
    };

    joinQueue();

    return () => {
      isMounted = false;
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [eventId]);

  return {
    ...queueState,
    isAdmitted: queueState.status === 'active',
  };
}
```

### Animated Waiting Graphic

```typescript
function QueueAnimation() {
  return (
    <div className="flex justify-center mb-6">
      <div className="relative w-24 h-24">
        {/* Spinning outer ring */}
        <div className="absolute inset-0 border-4 border-indigo-200 rounded-full" />
        <div
          className="absolute inset-0 border-4 border-transparent border-t-indigo-600 rounded-full animate-spin"
          style={{ animationDuration: '1.5s' }}
        />

        {/* Pulsing center icon */}
        <div className="absolute inset-0 flex items-center justify-center">
          <TicketIcon className="w-10 h-10 text-indigo-600 animate-pulse" />
        </div>
      </div>
    </div>
  );
}
```

---

## 5. Deep Dive: Checkout with Countdown Timer (8 minutes)

### Checkout Page Layout

```typescript
function CheckoutPage() {
  const { reservation, clearSelection } = useSeatSelectionStore();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { timeRemaining, isExpired } = useCheckoutTimer(reservation?.expiresAt);

  if (!reservation) {
    return <Navigate to="/" replace />;
  }

  if (isExpired) {
    return <ReservationExpired onStartOver={clearSelection} />;
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* Sticky timer at top */}
      <div className="sticky top-0 z-10 bg-white shadow-md rounded-lg p-4 mb-6">
        <CheckoutTimer
          timeRemaining={timeRemaining}
          isUrgent={timeRemaining < 120}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Order summary */}
        <div>
          <SeatSummary reservation={reservation} />
          <PriceSummary reservation={reservation} />
        </div>

        {/* Right: Payment form */}
        <div>
          <PaymentForm
            amount={reservation.totalAmount}
            onSubmit={handleCheckout}
            isSubmitting={isSubmitting}
          />
        </div>
      </div>
    </div>
  );
}
```

### Countdown Timer Component

```typescript
function CheckoutTimer({
  timeRemaining,
  isUrgent,
}: {
  timeRemaining: number;
  isUrgent: boolean;
}) {
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div
      className={`flex items-center justify-between p-4 rounded-lg transition-colors ${
        isUrgent
          ? 'bg-red-50 border border-red-200'
          : 'bg-blue-50 border border-blue-200'
      }`}
    >
      <div className="flex items-center gap-2">
        <ClockIcon
          className={`w-5 h-5 ${isUrgent ? 'text-red-600' : 'text-blue-600'}`}
        />
        <span className={isUrgent ? 'text-red-700' : 'text-blue-700'}>
          Complete your purchase within:
        </span>
      </div>

      <div
        className={`text-2xl font-bold tabular-nums ${
          isUrgent ? 'text-red-600 animate-pulse' : 'text-blue-600'
        }`}
      >
        {formatTime(timeRemaining)}
      </div>
    </div>
  );
}
```

### Checkout Timer Hook

```typescript
function useCheckoutTimer(expiresAt: Date | undefined) {
  const [timeRemaining, setTimeRemaining] = useState<number>(0);

  useEffect(() => {
    if (!expiresAt) return;

    const calculateRemaining = () => {
      const now = new Date();
      const remaining = Math.max(
        0,
        Math.floor((expiresAt.getTime() - now.getTime()) / 1000)
      );
      return remaining;
    };

    setTimeRemaining(calculateRemaining());

    const interval = setInterval(() => {
      const remaining = calculateRemaining();
      setTimeRemaining(remaining);

      if (remaining === 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  return {
    timeRemaining,
    isExpired: timeRemaining === 0,
    isUrgent: timeRemaining > 0 && timeRemaining < 120, // Last 2 minutes
  };
}
```

### Payment Form with Validation

```typescript
function PaymentForm({
  amount,
  onSubmit,
  isSubmitting,
}: PaymentFormProps) {
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const formatCardNumber = (value: string): string => {
    const digits = value.replace(/\D/g, '').slice(0, 16);
    return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
  };

  const formatExpiry = (value: string): string => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    if (digits.length >= 2) {
      return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    }
    return digits;
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    const cardDigits = cardNumber.replace(/\s/g, '');
    if (cardDigits.length !== 16) {
      newErrors.cardNumber = 'Card number must be 16 digits';
    }

    const [month, year] = expiry.split('/');
    if (!month || !year || parseInt(month) > 12) {
      newErrors.expiry = 'Invalid expiry date';
    }

    if (cvc.length < 3) {
      newErrors.cvc = 'CVC must be 3-4 digits';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    await onSubmit({
      cardNumber: cardNumber.replace(/\s/g, ''),
      expiry,
      cvc,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Card Number
        </label>
        <input
          type="text"
          value={cardNumber}
          onChange={(e) => setCardNumber(formatCardNumber(e.target.value))}
          placeholder="1234 5678 9012 3456"
          className={`w-full px-4 py-3 border rounded-lg ${
            errors.cardNumber ? 'border-red-500' : 'border-gray-300'
          }`}
          autoComplete="cc-number"
        />
        {errors.cardNumber && (
          <p className="text-red-500 text-sm mt-1">{errors.cardNumber}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Expiry
          </label>
          <input
            type="text"
            value={expiry}
            onChange={(e) => setExpiry(formatExpiry(e.target.value))}
            placeholder="MM/YY"
            className={`w-full px-4 py-3 border rounded-lg ${
              errors.expiry ? 'border-red-500' : 'border-gray-300'
            }`}
            autoComplete="cc-exp"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            CVC
          </label>
          <input
            type="text"
            value={cvc}
            onChange={(e) => setCvc(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="123"
            className={`w-full px-4 py-3 border rounded-lg ${
              errors.cvc ? 'border-red-500' : 'border-gray-300'
            }`}
            autoComplete="cc-csc"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full py-4 bg-indigo-600 text-white rounded-lg font-semibold
                   hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed
                   transition-colors"
      >
        {isSubmitting ? (
          <span className="flex items-center justify-center gap-2">
            <LoadingSpinner size="sm" />
            Processing...
          </span>
        ) : (
          `Pay $${amount.toFixed(2)}`
        )}
      </button>
    </form>
  );
}
```

---

## 6. Mobile Responsive Design (4 minutes)

### Seat Map on Mobile

```typescript
function SeatMapMobile({ eventId, availability }: SeatMapMobileProps) {
  const [selectedSection, setSelectedSection] = useState<string | null>(null);

  // On mobile, show section overview first, then drill down
  return (
    <div className="h-[60vh]">
      {!selectedSection ? (
        // Section overview with tap targets
        <div className="grid grid-cols-3 gap-2 p-4">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setSelectedSection(section.id)}
              className={`p-4 rounded-lg text-center ${
                getAvailableCount(section) > 0
                  ? 'bg-green-100 text-green-800'
                  : 'bg-gray-100 text-gray-400'
              }`}
            >
              <div className="font-semibold">{section.name}</div>
              <div className="text-sm">
                {getAvailableCount(section)} available
              </div>
              <div className="text-xs">from ${section.minPrice}</div>
            </button>
          ))}
        </div>
      ) : (
        // Section detail with pinch-zoom
        <div className="relative h-full">
          <button
            onClick={() => setSelectedSection(null)}
            className="absolute top-2 left-2 z-10 bg-white px-3 py-1 rounded-full shadow"
          >
            ← Back
          </button>
          <PinchZoomContainer>
            <SeatMapCanvas
              seats={getSectionSeats(selectedSection)}
              availability={availability}
              /* ... other props ... */
            />
          </PinchZoomContainer>
        </div>
      )}
    </div>
  );
}
```

### Responsive Breakpoints

```css
/* Tailwind responsive utilities */

/* Seat map sizing */
.seat-map-container {
  @apply h-[400px] md:h-[500px] lg:h-[600px];
}

/* Checkout layout */
.checkout-grid {
  @apply grid grid-cols-1 lg:grid-cols-2 gap-4;
}

/* Timer positioning */
.checkout-timer {
  @apply fixed bottom-0 left-0 right-0 lg:static lg:sticky lg:top-0;
  @apply z-50 bg-white shadow-lg lg:shadow-md;
}

/* Touch targets for mobile */
.seat-button {
  @apply min-w-[44px] min-h-[44px]; /* Apple HIG minimum */
}
```

---

## 7. Accessibility (3 minutes)

### Keyboard Navigation for Seat Map

```typescript
function AccessibleSeatMap({ seats, availability, onSelect }: SeatMapProps) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const availableSeats = seats.filter((s) => availability[s.id] === 'available');

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowRight':
        setFocusedIndex((i) => Math.min(i + 1, availableSeats.length - 1));
        break;
      case 'ArrowLeft':
        setFocusedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'ArrowDown':
        // Move to next row
        setFocusedIndex((i) => Math.min(i + seatsPerRow, availableSeats.length - 1));
        break;
      case 'ArrowUp':
        setFocusedIndex((i) => Math.max(i - seatsPerRow, 0));
        break;
      case 'Enter':
      case ' ':
        onSelect(availableSeats[focusedIndex].id);
        e.preventDefault();
        break;
    }
  };

  return (
    <div
      role="application"
      aria-label="Seat selection map"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Screen reader summary */}
      <div className="sr-only" aria-live="polite">
        {`${availableSeats.length} seats available. Use arrow keys to navigate, Enter to select.`}
      </div>

      {/* Visual map with focus indicator */}
      <SeatMapCanvas
        seats={seats}
        availability={availability}
        focusedSeat={availableSeats[focusedIndex]}
        /* ... */
      />
    </div>
  );
}
```

### Queue Announcements

```typescript
function QueueStatus({ position }: { position: number }) {
  const prevPosition = useRef(position);

  useEffect(() => {
    if (position < prevPosition.current) {
      // Announce progress to screen readers
      const announcement = `Queue position updated. ${position} people ahead of you.`;
      announceToScreenReader(announcement);
    }
    prevPosition.current = position;
  }, [position]);

  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Your position in queue:</span>
      <span className="text-4xl font-bold">{position.toLocaleString()}</span>
    </div>
  );
}
```

---

## 8. Error Handling and Edge Cases (2 minutes)

### Reservation Expired State

```typescript
function ReservationExpired({ onStartOver }: { onStartOver: () => void }) {
  return (
    <div className="text-center py-12">
      <ClockIcon className="w-16 h-16 text-gray-400 mx-auto mb-4" />
      <h2 className="text-2xl font-bold text-gray-800 mb-2">
        Time's Up
      </h2>
      <p className="text-gray-600 mb-6">
        Your seat reservation has expired. The seats have been released
        for other customers.
      </p>
      <button
        onClick={onStartOver}
        className="px-6 py-3 bg-indigo-600 text-white rounded-lg"
      >
        Start Over
      </button>
    </div>
  );
}
```

### Network Error Recovery

```typescript
function CheckoutErrorBoundary({ children }: { children: React.ReactNode }) {
  const [error, setError] = useState<Error | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h3 className="text-red-800 font-semibold mb-2">
          Payment Error
        </h3>
        <p className="text-red-600 mb-4">{error.message}</p>
        <button
          onClick={() => {
            setError(null);
            setRetryCount((c) => c + 1);
          }}
          className="px-4 py-2 bg-red-600 text-white rounded"
        >
          Try Again
        </button>
        {retryCount >= 3 && (
          <p className="mt-4 text-sm text-gray-600">
            Having trouble? Contact support or try a different payment method.
          </p>
        )}
      </div>
    );
  }

  return <ErrorBoundary onError={setError}>{children}</ErrorBoundary>;
}
```

---

## Summary

"I've designed a frontend for an event ticketing platform with:

1. **Canvas-based seat map** with virtual rendering for 10,000+ seat venues, zoom/pan controls, and optimistic seat selection
2. **Virtual waiting room UI** with animated queue position, estimated wait time, and automatic admission detection
3. **Countdown-driven checkout** with visual urgency indicators and robust form validation
4. **Mobile-first responsive design** with section drill-down for seat selection on small screens
5. **Full accessibility support** including keyboard navigation for seat maps and screen reader announcements

The key insight is managing user anxiety during high-stakes ticket purchases through clear visual feedback, optimistic updates, and graceful error handling when seats become unavailable."
