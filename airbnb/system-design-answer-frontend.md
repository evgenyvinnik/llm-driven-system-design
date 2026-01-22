# Airbnb - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the frontend architecture for a property rental marketplace like Airbnb. Key challenges include:
- Complex search interface with maps, filters, and date pickers
- Responsive listing gallery with image optimization
- Multi-step booking wizard with real-time availability
- Interactive calendar components for availability management
- Two-sided user experience (guest and host dashboards)

## Requirements Clarification

### Functional Requirements
1. **Search**: Location search with map integration, date pickers, and filters
2. **Listing View**: Photo galleries, amenity details, reviews, and booking widget
3. **Booking Flow**: Date selection, guest count, pricing breakdown, payment
4. **Host Dashboard**: Listing management, calendar management, reservation handling
5. **Messaging**: Real-time host-guest communication

### Non-Functional Requirements
1. **Performance**: First Contentful Paint < 1.5s, interactive < 3s
2. **Responsiveness**: Mobile-first with desktop optimization
3. **Accessibility**: WCAG 2.1 AA compliance
4. **Offline**: Service worker for saved listings and offline browsing

### Scale Estimates
- Unique monthly visitors: 50M
- Peak concurrent users: 200K
- Average session duration: 8 minutes
- Mobile traffic: 60%

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    React Application                             │
│              TanStack Router + Zustand + TailwindCSS             │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│    Routes     │    │   Components  │    │    Stores     │
│               │    │               │    │               │
│ - Search      │    │ - SearchBar   │    │ - authStore   │
│ - Listing     │    │ - Calendar    │    │ - searchStore │
│ - Host/*      │    │ - ListingCard │    │ - bookingStore│
│ - Trips       │    │ - BookingWidget│   │               │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Services Layer                              │
│              API Client + WebSocket + LocalStorage               │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Component Architecture

### Directory Structure

```
frontend/src/
├── components/                    # Reusable UI components
│   ├── BookingWidget.tsx          # Booking form with calendar
│   ├── Calendar.tsx               # Date selection calendar
│   ├── Header.tsx                 # Site navigation header
│   ├── ListingCard.tsx            # Listing preview card
│   ├── SearchBar.tsx              # Search input with filters
│   ├── PhotoGallery.tsx           # Listing image carousel
│   ├── AmenityIcon.tsx            # Amenity badge with icon
│   ├── ReviewCard.tsx             # Individual review display
│   ├── Map.tsx                    # Mapbox/Google Maps wrapper
│   └── listing-form/              # Multi-step listing creation wizard
│       ├── index.ts               # Barrel export for all components
│       ├── types.ts               # Shared types and constants
│       ├── useListingForm.ts      # Form state management hook
│       ├── ProgressIndicator.tsx  # Step progress visualization
│       ├── StepBasicInfo.tsx      # Step 1: Property type, title
│       ├── StepLocation.tsx       # Step 2: Address, coordinates
│       ├── StepDetails.tsx        # Step 3: Capacity, amenities
│       └── StepPricing.tsx        # Step 4: Price, booking settings
├── hooks/                         # Custom React hooks
│   ├── useListings.ts             # Listing data fetching
│   ├── useBooking.ts              # Booking operations
│   ├── useCalendar.ts             # Calendar state
│   └── useDebounce.ts             # Input debouncing
├── routes/                        # Page components (TanStack Router)
│   ├── __root.tsx                 # Root layout with Header
│   ├── index.tsx                  # Home page
│   ├── search.tsx                 # Search results
│   ├── listing.$id.tsx            # Listing detail page
│   ├── trips.tsx                  # Guest trip history
│   ├── messages.tsx               # Conversations
│   └── host/                      # Host-specific pages
│       ├── listings.tsx           # Manage listings
│       ├── listings.new.tsx       # Create new listing (wizard)
│       ├── listing.$id.calendar.tsx # Calendar management
│       └── reservations.tsx       # Manage reservations
├── services/                      # API client functions
│   └── api.ts                     # Centralized API calls
├── stores/                        # Zustand state stores
│   ├── authStore.ts               # Authentication state
│   ├── searchStore.ts             # Search filters and results
│   └── bookingStore.ts            # Booking draft state
├── types/                         # TypeScript type definitions
│   └── index.ts                   # Shared types
└── utils/                         # Helper functions
    ├── formatters.ts              # Date, currency formatters
    ├── validators.ts              # Form validation
    └── mapUtils.ts                # Map coordinate helpers
```

### Component Organization Principles

**1. Feature-Based Grouping**

```typescript
// Import from feature directory
import {
  StepBasicInfo,
  StepLocation,
  useListingForm,
  PROPERTY_TYPES,
} from '../components/listing-form';
```

**2. Custom Hooks for State Logic**

```typescript
// useListingForm.ts
export function useListingForm() {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState<ListingFormData>(initialData);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = <K extends keyof ListingFormData>(
    field: K,
    value: ListingFormData[K]
  ) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const nextStep = () => setStep(prev => Math.min(prev + 1, 4));
  const prevStep = () => setStep(prev => Math.max(prev - 1, 1));

  const submitForm = async () => {
    setIsSubmitting(true);
    try {
      const listing = await api.createListing(formData);
      return listing;
    } finally {
      setIsSubmitting(false);
    }
  };

  return { step, formData, updateField, nextStep, prevStep, submitForm, isSubmitting };
}
```

**3. Props Interfaces with JSDoc**

```typescript
interface StepBasicInfoProps extends StepNavigationProps {
  /** Current form data */
  formData: ListingFormData;
  /** Callback to update form fields */
  onUpdate: <K extends keyof ListingFormData>(field: K, value: ListingFormData[K]) => void;
}

export function StepBasicInfo({ formData, onUpdate, onNext }: StepBasicInfoProps) {
  // ...
}
```

## Deep Dive: Search Interface

### SearchBar Component

```typescript
interface SearchBarProps {
  onSearch: (params: SearchParams) => void;
  initialParams?: Partial<SearchParams>;
}

export function SearchBar({ onSearch, initialParams }: SearchBarProps) {
  const [location, setLocation] = useState(initialParams?.location || '');
  const [checkIn, setCheckIn] = useState<Date | null>(initialParams?.checkIn || null);
  const [checkOut, setCheckOut] = useState<Date | null>(initialParams?.checkOut || null);
  const [guests, setGuests] = useState(initialParams?.guests || 1);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showGuestPicker, setShowGuestPicker] = useState(false);

  // Location autocomplete with debounce
  const debouncedLocation = useDebounce(location, 300);
  const { suggestions, isLoading } = useLocationSuggestions(debouncedLocation);

  const handleSearch = () => {
    onSearch({
      location: selectedLocation,
      checkIn,
      checkOut,
      guests
    });
  };

  return (
    <div className="flex items-center bg-white rounded-full shadow-lg p-2">
      {/* Location Input */}
      <div className="relative flex-1 px-4">
        <label className="text-xs font-semibold text-gray-800">Where</label>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Search destinations"
          className="w-full text-sm text-gray-600 focus:outline-none"
        />
        {suggestions.length > 0 && (
          <LocationSuggestions
            suggestions={suggestions}
            onSelect={handleSelectLocation}
          />
        )}
      </div>

      <Divider />

      {/* Date Picker */}
      <div className="relative px-4 cursor-pointer" onClick={() => setShowCalendar(true)}>
        <label className="text-xs font-semibold text-gray-800">Check in</label>
        <div className="text-sm text-gray-600">
          {checkIn ? formatDate(checkIn) : 'Add dates'}
        </div>
      </div>

      <Divider />

      <div className="relative px-4 cursor-pointer" onClick={() => setShowCalendar(true)}>
        <label className="text-xs font-semibold text-gray-800">Check out</label>
        <div className="text-sm text-gray-600">
          {checkOut ? formatDate(checkOut) : 'Add dates'}
        </div>
      </div>

      <Divider />

      {/* Guest Picker */}
      <div className="relative px-4 cursor-pointer" onClick={() => setShowGuestPicker(true)}>
        <label className="text-xs font-semibold text-gray-800">Who</label>
        <div className="text-sm text-gray-600">
          {guests > 0 ? `${guests} guest${guests > 1 ? 's' : ''}` : 'Add guests'}
        </div>
      </div>

      {/* Search Button */}
      <button
        onClick={handleSearch}
        className="p-3 bg-rose-500 hover:bg-rose-600 text-white rounded-full"
      >
        <SearchIcon className="w-4 h-4" />
      </button>

      {/* Modals */}
      {showCalendar && (
        <CalendarModal
          checkIn={checkIn}
          checkOut={checkOut}
          onSelect={handleDateSelect}
          onClose={() => setShowCalendar(false)}
        />
      )}

      {showGuestPicker && (
        <GuestPicker
          value={guests}
          onChange={setGuests}
          onClose={() => setShowGuestPicker(false)}
        />
      )}
    </div>
  );
}
```

### Search Results with Map

```typescript
export function SearchPage() {
  const search = useSearch();
  const { listings, isLoading, pagination } = useListings(search);
  const [hoveredListing, setHoveredListing] = useState<number | null>(null);
  const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);

  return (
    <div className="flex h-screen">
      {/* Listing Grid */}
      <div className="w-1/2 overflow-y-auto p-6">
        <FilterBar />

        {isLoading ? (
          <ListingSkeleton count={6} />
        ) : (
          <div className="grid grid-cols-2 gap-6">
            {listings.map(listing => (
              <ListingCard
                key={listing.id}
                listing={listing}
                onHover={() => setHoveredListing(listing.id)}
                onLeave={() => setHoveredListing(null)}
              />
            ))}
          </div>
        )}

        <Pagination {...pagination} />
      </div>

      {/* Map */}
      <div className="w-1/2 sticky top-0 h-screen">
        <Map
          listings={listings}
          highlightedId={hoveredListing}
          onBoundsChange={setMapBounds}
          onMarkerClick={(id) => navigate({ to: `/listing/${id}` })}
        />
      </div>
    </div>
  );
}
```

## Deep Dive: Calendar Component

### Interactive Date Range Picker

```typescript
interface CalendarProps {
  checkIn: Date | null;
  checkOut: Date | null;
  blockedDates?: Date[];
  minNights?: number;
  maxNights?: number;
  onSelect: (checkIn: Date | null, checkOut: Date | null) => void;
}

export function Calendar({
  checkIn,
  checkOut,
  blockedDates = [],
  minNights = 1,
  maxNights = 365,
  onSelect
}: CalendarProps) {
  const [viewMonth, setViewMonth] = useState(new Date());
  const [selectionStart, setSelectionStart] = useState<Date | null>(checkIn);

  const isBlocked = (date: Date) => {
    return blockedDates.some(blocked =>
      isSameDay(blocked, date)
    );
  };

  const isInRange = (date: Date) => {
    if (!checkIn || !checkOut) return false;
    return date >= checkIn && date <= checkOut;
  };

  const handleDateClick = (date: Date) => {
    if (isBlocked(date)) return;

    if (!selectionStart || checkOut) {
      // Start new selection
      setSelectionStart(date);
      onSelect(date, null);
    } else {
      // Complete selection
      if (date < selectionStart) {
        onSelect(date, selectionStart);
      } else {
        // Check for blocked dates in range
        const hasBlockedInRange = blockedDates.some(
          blocked => blocked > selectionStart && blocked < date
        );

        if (hasBlockedInRange) {
          // Cannot select range with blocked dates
          setSelectionStart(date);
          onSelect(date, null);
        } else {
          const nights = differenceInDays(date, selectionStart);
          if (nights >= minNights && nights <= maxNights) {
            onSelect(selectionStart, date);
          }
        }
      }
    }
  };

  const renderMonth = (monthDate: Date) => {
    const days = getDaysInMonth(monthDate);

    return (
      <div className="month">
        <h3 className="text-center font-semibold mb-4">
          {format(monthDate, 'MMMM yyyy')}
        </h3>

        <div className="grid grid-cols-7 gap-1">
          {/* Day headers */}
          {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => (
            <div key={day} className="text-center text-xs text-gray-500 py-2">
              {day}
            </div>
          ))}

          {/* Empty cells for first week offset */}
          {Array.from({ length: getDay(startOfMonth(monthDate)) }).map((_, i) => (
            <div key={`empty-${i}`} />
          ))}

          {/* Date cells */}
          {days.map(date => {
            const blocked = isBlocked(date);
            const inRange = isInRange(date);
            const isStart = checkIn && isSameDay(date, checkIn);
            const isEnd = checkOut && isSameDay(date, checkOut);
            const isPast = date < startOfDay(new Date());

            return (
              <button
                key={date.toISOString()}
                onClick={() => handleDateClick(date)}
                disabled={blocked || isPast}
                className={cn(
                  'p-2 text-center rounded-full transition-colors',
                  blocked && 'text-gray-300 line-through cursor-not-allowed',
                  isPast && 'text-gray-300 cursor-not-allowed',
                  inRange && 'bg-gray-100',
                  isStart && 'bg-gray-900 text-white rounded-r-none',
                  isEnd && 'bg-gray-900 text-white rounded-l-none',
                  !blocked && !isPast && 'hover:border hover:border-gray-900'
                )}
              >
                {format(date, 'd')}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white rounded-xl shadow-xl p-6">
      <div className="flex justify-between items-center mb-6">
        <button onClick={() => setViewMonth(subMonths(viewMonth, 1))}>
          <ChevronLeftIcon className="w-5 h-5" />
        </button>
        <button onClick={() => setViewMonth(addMonths(viewMonth, 1))}>
          <ChevronRightIcon className="w-5 h-5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-8">
        {renderMonth(viewMonth)}
        {renderMonth(addMonths(viewMonth, 1))}
      </div>

      {checkIn && checkOut && (
        <div className="mt-4 text-center text-gray-600">
          {differenceInDays(checkOut, checkIn)} nights
        </div>
      )}
    </div>
  );
}
```

## Deep Dive: Booking Widget

### Sticky Booking Widget

```typescript
interface BookingWidgetProps {
  listing: Listing;
  availability: AvailabilityBlock[];
}

export function BookingWidget({ listing, availability }: BookingWidgetProps) {
  const [checkIn, setCheckIn] = useState<Date | null>(null);
  const [checkOut, setCheckOut] = useState<Date | null>(null);
  const [guests, setGuests] = useState(1);
  const [showCalendar, setShowCalendar] = useState(false);
  const [isBooking, setIsBooking] = useState(false);

  const navigate = useNavigate();
  const { user } = useAuthStore();

  // Calculate pricing
  const pricing = useMemo(() => {
    if (!checkIn || !checkOut) return null;

    const nights = differenceInDays(checkOut, checkIn);
    const nightlyTotal = listing.price_per_night * nights;
    const cleaningFee = listing.cleaning_fee || 0;
    const serviceFee = Math.round(nightlyTotal * (listing.service_fee_percent / 100));
    const total = nightlyTotal + cleaningFee + serviceFee;

    return { nights, nightlyTotal, cleaningFee, serviceFee, total };
  }, [checkIn, checkOut, listing]);

  // Get blocked dates from availability
  const blockedDates = useMemo(() => {
    return availability
      .filter(block => block.status !== 'available')
      .flatMap(block => getDatesInRange(block.start_date, block.end_date));
  }, [availability]);

  const handleReserve = async () => {
    if (!user) {
      navigate({ to: '/login', search: { redirect: window.location.pathname } });
      return;
    }

    if (!checkIn || !checkOut) return;

    setIsBooking(true);
    try {
      const booking = await api.createBooking({
        listing_id: listing.id,
        check_in: checkIn,
        check_out: checkOut,
        guests
      });

      if (listing.instant_book) {
        navigate({ to: `/trips/${booking.id}/confirmation` });
      } else {
        navigate({ to: `/trips/${booking.id}/pending` });
      }
    } catch (error) {
      toast.error(error.message || 'Booking failed. Please try again.');
    } finally {
      setIsBooking(false);
    }
  };

  return (
    <div className="sticky top-24 border rounded-xl shadow-lg p-6">
      {/* Price Header */}
      <div className="flex items-baseline gap-1 mb-6">
        <span className="text-2xl font-semibold">
          ${listing.price_per_night}
        </span>
        <span className="text-gray-500">night</span>

        {listing.rating && (
          <div className="ml-auto flex items-center gap-1">
            <StarIcon className="w-4 h-4" />
            <span>{listing.rating}</span>
            <span className="text-gray-500">
              ({listing.review_count} reviews)
            </span>
          </div>
        )}
      </div>

      {/* Date Selection */}
      <div
        className="border rounded-xl cursor-pointer"
        onClick={() => setShowCalendar(true)}
      >
        <div className="grid grid-cols-2 divide-x">
          <div className="p-3">
            <label className="text-xs font-semibold uppercase">Check-in</label>
            <div className="text-sm">
              {checkIn ? format(checkIn, 'MM/dd/yyyy') : 'Add date'}
            </div>
          </div>
          <div className="p-3">
            <label className="text-xs font-semibold uppercase">Checkout</label>
            <div className="text-sm">
              {checkOut ? format(checkOut, 'MM/dd/yyyy') : 'Add date'}
            </div>
          </div>
        </div>

        <div className="border-t p-3">
          <label className="text-xs font-semibold uppercase">Guests</label>
          <GuestSelector
            value={guests}
            max={listing.max_guests}
            onChange={setGuests}
          />
        </div>
      </div>

      {/* Reserve Button */}
      <button
        onClick={handleReserve}
        disabled={!checkIn || !checkOut || isBooking}
        className={cn(
          'w-full mt-4 py-3 rounded-lg text-white font-semibold',
          'bg-gradient-to-r from-rose-500 to-pink-600',
          'hover:from-rose-600 hover:to-pink-700',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        {isBooking ? (
          <Spinner className="w-5 h-5 mx-auto" />
        ) : listing.instant_book ? (
          'Reserve'
        ) : (
          'Request to book'
        )}
      </button>

      {!listing.instant_book && (
        <p className="text-center text-sm text-gray-500 mt-2">
          You won't be charged yet
        </p>
      )}

      {/* Price Breakdown */}
      {pricing && (
        <div className="mt-4 space-y-3 pt-4 border-t">
          <div className="flex justify-between text-gray-600">
            <span className="underline">
              ${listing.price_per_night} x {pricing.nights} nights
            </span>
            <span>${pricing.nightlyTotal}</span>
          </div>

          {pricing.cleaningFee > 0 && (
            <div className="flex justify-between text-gray-600">
              <span className="underline">Cleaning fee</span>
              <span>${pricing.cleaningFee}</span>
            </div>
          )}

          <div className="flex justify-between text-gray-600">
            <span className="underline">Service fee</span>
            <span>${pricing.serviceFee}</span>
          </div>

          <div className="flex justify-between font-semibold pt-3 border-t">
            <span>Total</span>
            <span>${pricing.total}</span>
          </div>
        </div>
      )}

      {/* Calendar Modal */}
      {showCalendar && (
        <Modal onClose={() => setShowCalendar(false)}>
          <Calendar
            checkIn={checkIn}
            checkOut={checkOut}
            blockedDates={blockedDates}
            minNights={listing.minimum_nights}
            maxNights={listing.maximum_nights}
            onSelect={(start, end) => {
              setCheckIn(start);
              setCheckOut(end);
              if (start && end) setShowCalendar(false);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
```

## Deep Dive: Photo Gallery

### Image Gallery with Lightbox

```typescript
interface PhotoGalleryProps {
  photos: ListingPhoto[];
  listingTitle: string;
}

export function PhotoGallery({ photos, listingTitle }: PhotoGalleryProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  const primaryPhoto = photos[0];
  const secondaryPhotos = photos.slice(1, 5);

  return (
    <>
      <div className="grid grid-cols-4 grid-rows-2 gap-2 rounded-xl overflow-hidden">
        {/* Primary Image */}
        <div
          className="col-span-2 row-span-2 cursor-pointer"
          onClick={() => {
            setCurrentIndex(0);
            setLightboxOpen(true);
          }}
        >
          <img
            src={primaryPhoto.url}
            alt={listingTitle}
            className="w-full h-full object-cover hover:opacity-90 transition-opacity"
            loading="eager"
          />
        </div>

        {/* Secondary Images */}
        {secondaryPhotos.map((photo, index) => (
          <div
            key={photo.id}
            className="cursor-pointer"
            onClick={() => {
              setCurrentIndex(index + 1);
              setLightboxOpen(true);
            }}
          >
            <img
              src={photo.url}
              alt={`${listingTitle} - Photo ${index + 2}`}
              className="w-full h-full object-cover hover:opacity-90 transition-opacity"
              loading="lazy"
            />
          </div>
        ))}

        {/* Show All Button */}
        {photos.length > 5 && (
          <button
            onClick={() => {
              setCurrentIndex(0);
              setLightboxOpen(true);
            }}
            className="absolute bottom-4 right-4 bg-white px-4 py-2 rounded-lg
                       text-sm font-semibold shadow-md hover:bg-gray-100"
          >
            Show all photos
          </button>
        )}
      </div>

      {/* Lightbox */}
      {lightboxOpen && (
        <Lightbox
          photos={photos}
          currentIndex={currentIndex}
          onIndexChange={setCurrentIndex}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  );
}

function Lightbox({ photos, currentIndex, onIndexChange, onClose }: LightboxProps) {
  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onIndexChange(Math.max(0, currentIndex - 1));
      if (e.key === 'ArrowRight') onIndexChange(Math.min(photos.length - 1, currentIndex + 1));
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, photos.length, onClose, onIndexChange]);

  return (
    <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
      {/* Close Button */}
      <button
        onClick={onClose}
        className="absolute top-4 left-4 text-white p-2 hover:bg-white/10 rounded-full"
      >
        <XIcon className="w-6 h-6" />
      </button>

      {/* Counter */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 text-white">
        {currentIndex + 1} / {photos.length}
      </div>

      {/* Navigation */}
      <button
        onClick={() => onIndexChange(currentIndex - 1)}
        disabled={currentIndex === 0}
        className="absolute left-4 text-white p-2 hover:bg-white/10 rounded-full
                   disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <ChevronLeftIcon className="w-8 h-8" />
      </button>

      {/* Image */}
      <img
        src={photos[currentIndex].url}
        alt={photos[currentIndex].caption || `Photo ${currentIndex + 1}`}
        className="max-w-full max-h-full object-contain"
      />

      <button
        onClick={() => onIndexChange(currentIndex + 1)}
        disabled={currentIndex === photos.length - 1}
        className="absolute right-4 text-white p-2 hover:bg-white/10 rounded-full
                   disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <ChevronRightIcon className="w-8 h-8" />
      </button>

      {/* Thumbnail Strip */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 overflow-x-auto max-w-[80vw]">
        {photos.map((photo, index) => (
          <button
            key={photo.id}
            onClick={() => onIndexChange(index)}
            className={cn(
              'w-16 h-12 rounded overflow-hidden flex-shrink-0',
              index === currentIndex && 'ring-2 ring-white'
            )}
          >
            <img
              src={photo.url}
              alt=""
              className="w-full h-full object-cover"
            />
          </button>
        ))}
      </div>
    </div>
  );
}
```

## Deep Dive: Host Calendar Management

### Availability Calendar Editor

```typescript
export function HostCalendarPage() {
  const { id } = useParams({ from: '/host/listing/$id/calendar' });
  const { listing, availability, refetch } = useListing(id);
  const [selectedDates, setSelectedDates] = useState<Date[]>([]);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);

  const handleBulkUpdate = async (action: 'block' | 'unblock' | 'price') => {
    if (selectedDates.length === 0) return;

    const sortedDates = [...selectedDates].sort((a, b) => a.getTime() - b.getTime());
    const ranges = groupConsecutiveDates(sortedDates);

    for (const range of ranges) {
      await api.updateAvailability(id, {
        start_date: range.start,
        end_date: range.end,
        status: action === 'block' ? 'blocked' : 'available',
        price_per_night: action === 'price' ? bulkAction.price : undefined
      });
    }

    setSelectedDates([]);
    refetch();
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-6">Manage Availability</h1>

      <div className="grid grid-cols-3 gap-6">
        {/* Calendar */}
        <div className="col-span-2">
          <AvailabilityCalendar
            availability={availability}
            selectedDates={selectedDates}
            onDateClick={handleDateClick}
            onDateRangeSelect={handleRangeSelect}
          />
        </div>

        {/* Side Panel */}
        <div className="space-y-6">
          {/* Selection Info */}
          {selectedDates.length > 0 && (
            <div className="border rounded-lg p-4">
              <h3 className="font-semibold mb-2">
                {selectedDates.length} date{selectedDates.length > 1 ? 's' : ''} selected
              </h3>

              <div className="space-y-2">
                <button
                  onClick={() => handleBulkUpdate('block')}
                  className="w-full py-2 border rounded-lg hover:bg-gray-50"
                >
                  Block dates
                </button>

                <button
                  onClick={() => handleBulkUpdate('unblock')}
                  className="w-full py-2 border rounded-lg hover:bg-gray-50"
                >
                  Unblock dates
                </button>

                <div className="pt-2 border-t">
                  <label className="text-sm text-gray-600">Custom price</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      placeholder={`$${listing.price_per_night}`}
                      onChange={(e) => setBulkAction({ type: 'price', price: Number(e.target.value) })}
                      className="flex-1 border rounded-lg px-3 py-2"
                    />
                    <button
                      onClick={() => handleBulkUpdate('price')}
                      className="px-4 py-2 bg-gray-900 text-white rounded-lg"
                    >
                      Set
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Booking Settings */}
          <div className="border rounded-lg p-4">
            <h3 className="font-semibold mb-4">Booking settings</h3>

            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-600">Minimum nights</label>
                <input
                  type="number"
                  value={listing.minimum_nights}
                  onChange={(e) => updateSetting('minimum_nights', Number(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 mt-1"
                />
              </div>

              <div>
                <label className="text-sm text-gray-600">Maximum nights</label>
                <input
                  type="number"
                  value={listing.maximum_nights}
                  onChange={(e) => updateSetting('maximum_nights', Number(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 mt-1"
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="text-sm text-gray-600">Instant Book</label>
                <Toggle
                  checked={listing.instant_book}
                  onChange={(checked) => updateSetting('instant_book', checked)}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

## Deep Dive: State Management

### Search Store with Zustand

```typescript
interface SearchState {
  location: string | null;
  coordinates: { lat: number; lng: number } | null;
  checkIn: Date | null;
  checkOut: Date | null;
  guests: number;
  filters: SearchFilters;
  results: Listing[];
  isLoading: boolean;
  error: string | null;
}

interface SearchActions {
  setLocation: (location: string, coords?: { lat: number; lng: number }) => void;
  setDates: (checkIn: Date | null, checkOut: Date | null) => void;
  setGuests: (guests: number) => void;
  updateFilter: <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => void;
  clearFilters: () => void;
  search: () => Promise<void>;
}

export const useSearchStore = create<SearchState & SearchActions>((set, get) => ({
  // State
  location: null,
  coordinates: null,
  checkIn: null,
  checkOut: null,
  guests: 1,
  filters: {
    priceMin: null,
    priceMax: null,
    propertyType: null,
    roomType: null,
    amenities: [],
    instantBook: false
  },
  results: [],
  isLoading: false,
  error: null,

  // Actions
  setLocation: (location, coords) => set({ location, coordinates: coords || null }),

  setDates: (checkIn, checkOut) => set({ checkIn, checkOut }),

  setGuests: (guests) => set({ guests }),

  updateFilter: (key, value) => set(state => ({
    filters: { ...state.filters, [key]: value }
  })),

  clearFilters: () => set({
    filters: {
      priceMin: null,
      priceMax: null,
      propertyType: null,
      roomType: null,
      amenities: [],
      instantBook: false
    }
  }),

  search: async () => {
    const { coordinates, checkIn, checkOut, guests, filters } = get();

    if (!coordinates) return;

    set({ isLoading: true, error: null });

    try {
      const results = await api.searchListings({
        lat: coordinates.lat,
        lng: coordinates.lng,
        checkIn,
        checkOut,
        guests,
        ...filters
      });

      set({ results, isLoading: false });
    } catch (error) {
      set({ error: error.message, isLoading: false });
    }
  }
}));
```

### Booking Store

```typescript
interface BookingState {
  listingId: number | null;
  checkIn: Date | null;
  checkOut: Date | null;
  guests: number;
  guestMessage: string;
  pricing: PricingBreakdown | null;
  isSubmitting: boolean;
}

interface BookingActions {
  initBooking: (listingId: number) => void;
  setDates: (checkIn: Date | null, checkOut: Date | null) => void;
  setGuests: (guests: number) => void;
  setMessage: (message: string) => void;
  calculatePricing: (listing: Listing) => void;
  submitBooking: () => Promise<Booking>;
  reset: () => void;
}

export const useBookingStore = create<BookingState & BookingActions>((set, get) => ({
  listingId: null,
  checkIn: null,
  checkOut: null,
  guests: 1,
  guestMessage: '',
  pricing: null,
  isSubmitting: false,

  initBooking: (listingId) => set({
    listingId,
    checkIn: null,
    checkOut: null,
    guests: 1,
    guestMessage: '',
    pricing: null
  }),

  setDates: (checkIn, checkOut) => set({ checkIn, checkOut }),

  setGuests: (guests) => set({ guests }),

  setMessage: (guestMessage) => set({ guestMessage }),

  calculatePricing: (listing) => {
    const { checkIn, checkOut } = get();
    if (!checkIn || !checkOut) {
      set({ pricing: null });
      return;
    }

    const nights = differenceInDays(checkOut, checkIn);
    const nightlyTotal = listing.price_per_night * nights;
    const cleaningFee = listing.cleaning_fee || 0;
    const serviceFee = Math.round(nightlyTotal * (listing.service_fee_percent / 100));

    set({
      pricing: {
        nights,
        pricePerNight: listing.price_per_night,
        nightlyTotal,
        cleaningFee,
        serviceFee,
        total: nightlyTotal + cleaningFee + serviceFee
      }
    });
  },

  submitBooking: async () => {
    const { listingId, checkIn, checkOut, guests, guestMessage } = get();

    if (!listingId || !checkIn || !checkOut) {
      throw new Error('Missing booking details');
    }

    set({ isSubmitting: true });

    try {
      const booking = await api.createBooking({
        listing_id: listingId,
        check_in: checkIn,
        check_out: checkOut,
        guests,
        guest_message: guestMessage
      });

      return booking;
    } finally {
      set({ isSubmitting: false });
    }
  },

  reset: () => set({
    listingId: null,
    checkIn: null,
    checkOut: null,
    guests: 1,
    guestMessage: '',
    pricing: null,
    isSubmitting: false
  })
}));
```

## Deep Dive: Performance Optimizations

### Image Optimization

```typescript
interface OptimizedImageProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
}

export function OptimizedImage({ src, alt, width, height, priority }: OptimizedImageProps) {
  const [loaded, setLoaded] = useState(false);

  // Generate srcset for responsive images
  const srcset = [1, 2].map(scale =>
    `${src}?w=${width * scale}&h=${height * scale}&fit=crop ${scale}x`
  ).join(', ');

  return (
    <div className="relative overflow-hidden" style={{ aspectRatio: width / height }}>
      {/* Placeholder blur */}
      {!loaded && (
        <div className="absolute inset-0 bg-gray-200 animate-pulse" />
      )}

      <img
        src={`${src}?w=${width}&h=${height}&fit=crop`}
        srcSet={srcset}
        alt={alt}
        width={width}
        height={height}
        loading={priority ? 'eager' : 'lazy'}
        decoding={priority ? 'sync' : 'async'}
        onLoad={() => setLoaded(true)}
        className={cn(
          'w-full h-full object-cover transition-opacity duration-300',
          loaded ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  );
}
```

### Skeleton Loading

```typescript
export function ListingCardSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="aspect-square bg-gray-200 rounded-xl mb-3" />
      <div className="flex justify-between mb-1">
        <div className="h-4 bg-gray-200 rounded w-2/3" />
        <div className="h-4 bg-gray-200 rounded w-10" />
      </div>
      <div className="h-3 bg-gray-200 rounded w-1/2 mb-1" />
      <div className="h-3 bg-gray-200 rounded w-1/3" />
    </div>
  );
}

export function ListingSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
      {Array.from({ length: count }).map((_, i) => (
        <ListingCardSkeleton key={i} />
      ))}
    </div>
  );
}
```

### Debounced Search

```typescript
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// Usage in SearchBar
function SearchBar() {
  const [location, setLocation] = useState('');
  const debouncedLocation = useDebounce(location, 300);

  const { suggestions } = useLocationSuggestions(debouncedLocation);
  // ...
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Routing | TanStack Router | React Router | Type-safe routes, better DX |
| State management | Zustand | Redux | Simpler API, less boilerplate |
| Styling | TailwindCSS | styled-components | Faster development, smaller bundle |
| Date handling | date-fns | Moment.js | Tree-shakeable, smaller bundle |
| Maps | Mapbox GL | Google Maps | Better customization, pricing |
| Image loading | Native lazy load | Intersection Observer | Simpler, good browser support |
| Calendar | Custom component | react-dates | Full control, lighter weight |

## Accessibility Considerations

| Feature | Implementation |
|---------|----------------|
| Keyboard navigation | Arrow keys for calendar, Escape to close modals |
| Focus management | Focus trap in modals, return focus on close |
| Screen readers | ARIA labels on interactive elements |
| Color contrast | WCAG AA compliant colors |
| Reduced motion | Respects prefers-reduced-motion |
| Skip links | Skip to main content link |

## Future Frontend Enhancements

1. **Offline Support**: Service worker for saved listings and offline search
2. **Real-time Updates**: WebSocket for live availability and messages
3. **Virtual Scrolling**: Infinite scroll for large result sets
4. **Map Clustering**: Cluster markers for dense areas
5. **Animation Library**: Framer Motion for micro-interactions
6. **i18n Support**: Multi-language with react-i18next
