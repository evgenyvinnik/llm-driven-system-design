# Hotel Booking System - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement

"Today I'll design a hotel booking system like Booking.com or Expedia. The core frontend challenges are building a responsive search interface with real-time filtering, implementing an intuitive date-range picker with availability calendar, creating a smooth booking flow with guest details and payment, and managing complex state across search, cart, and user sessions. I'll focus on component architecture, state management with Zustand, and creating an admin dashboard for hotel owners."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Search interface** - Location autocomplete, date picker, guest count, real-time filtering
2. **Hotel browsing** - Card grid with photos, ratings, prices, amenities badges
3. **Hotel detail page** - Photo gallery, room type cards with availability calendar
4. **Booking flow** - Guest details form, price summary, confirmation
5. **User dashboard** - My bookings with status, cancellation, review submission
6. **Admin dashboard** - Hotel management, room types, pricing overrides, booking list

### Non-Functional Requirements

- **Performance**: First Contentful Paint < 1.5s, search results in < 500ms
- **Responsiveness**: Mobile-first design, tablet and desktop breakpoints
- **Accessibility**: WCAG 2.1 AA compliance, keyboard navigation, screen reader support
- **Offline**: Service worker for static assets, graceful degradation

### Frontend Focus Areas

- Component architecture with single responsibility principle
- Zustand stores for auth, search, and booking state
- TanStack Router for type-safe file-based routing
- Tailwind CSS for utility-first responsive design
- Form validation with optimistic UI updates

---

## Step 2: User Interface Design (5 minutes)

### Page Structure

```
/                           → Home page with search hero
/search                     → Search results with filters sidebar
/hotels/:hotelId            → Hotel detail with room types
/hotels/:hotelId/book       → Booking flow (guest details, payment)
/bookings                   → User's booking list
/bookings/:bookingId        → Booking detail with review option
/login                      → Authentication
/admin                      → Admin dashboard (hotel selector)
/admin/hotels/:hotelId      → Hotel management page
```

### Layout Components

```
┌─────────────────────────────────────────────────────────────────┐
│  Header (Logo, Search Bar, User Menu)                          │
├────────────────────────────────────┬────────────────────────────┤
│                                    │                            │
│  Filters Sidebar                   │  Hotel Cards Grid          │
│  ┌──────────────────┐              │  ┌───────┐  ┌───────┐      │
│  │ Price Range      │              │  │       │  │       │      │
│  │ [==========]     │              │  │ Hotel │  │ Hotel │      │
│  │                  │              │  │ Card  │  │ Card  │      │
│  │ Star Rating      │              │  │       │  │       │      │
│  │ ☆☆☆☆☆           │              │  └───────┘  └───────┘      │
│  │                  │              │  ┌───────┐  ┌───────┐      │
│  │ Amenities        │              │  │       │  │       │      │
│  │ ☐ WiFi           │              │  │ Hotel │  │ Hotel │      │
│  │ ☐ Pool           │              │  │ Card  │  │ Card  │      │
│  │ ☐ Parking        │              │  │       │  │       │      │
│  └──────────────────┘              │  └───────┘  └───────┘      │
│                                    │                            │
├────────────────────────────────────┴────────────────────────────┤
│  Footer                                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 3: Component Architecture (10 minutes)

### Directory Structure

```
frontend/src/
├── components/
│   ├── admin/                    # Admin-specific components
│   │   ├── index.ts              # Barrel export
│   │   ├── AdminRoomTypeCard.tsx
│   │   ├── BookingsTable.tsx
│   │   ├── CreateHotelModal.tsx
│   │   ├── HotelHeader.tsx
│   │   ├── HotelSelector.tsx
│   │   ├── PricingModal.tsx
│   │   ├── RoomTypeModal.tsx
│   │   └── StatsGrid.tsx
│   ├── booking/
│   │   ├── BookingCard.tsx
│   │   ├── BookingConfirmation.tsx
│   │   ├── GuestDetailsForm.tsx
│   │   └── PriceSummary.tsx
│   ├── hotel/
│   │   ├── HotelCard.tsx
│   │   ├── HotelGallery.tsx
│   │   ├── RoomTypeCard.tsx
│   │   └── AvailabilityCalendar.tsx
│   ├── search/
│   │   ├── SearchBar.tsx
│   │   ├── DateRangePicker.tsx
│   │   ├── GuestSelector.tsx
│   │   ├── FiltersPanel.tsx
│   │   └── LocationAutocomplete.tsx
│   ├── icons/
│   │   ├── index.ts
│   │   ├── StarIcon.tsx
│   │   ├── WifiIcon.tsx
│   │   └── ...
│   └── ui/
│       ├── Button.tsx
│       ├── Modal.tsx
│       ├── Card.tsx
│       └── Badge.tsx
├── hooks/
│   ├── useSearch.ts
│   ├── useBooking.ts
│   └── useDebounce.ts
├── routes/
├── services/
│   └── api.ts
├── stores/
│   ├── authStore.ts
│   ├── searchStore.ts
│   └── bookingStore.ts
├── types/
│   └── index.ts
└── utils/
    └── index.ts
```

### Core Component: SearchBar

```tsx
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSearchStore } from '@/stores/searchStore';
import { DateRangePicker } from './DateRangePicker';
import { GuestSelector } from './GuestSelector';
import { LocationAutocomplete } from './LocationAutocomplete';
import { SearchIcon } from '@/components/icons';

/**
 * Main search bar component for hotel search.
 * Handles location, date range, and guest count inputs.
 *
 * @example
 * <SearchBar variant="hero" onSearch={handleSearch} />
 */
export function SearchBar({ variant = 'default' }: SearchBarProps) {
  const navigate = useNavigate();
  const { searchParams, setSearchParams } = useSearchStore();
  const [isLoading, setIsLoading] = useState(false);

  const handleSearch = async () => {
    if (!searchParams.location) {
      // Show validation error
      return;
    }

    setIsLoading(true);
    navigate({
      to: '/search',
      search: {
        location: searchParams.location,
        checkIn: searchParams.checkIn,
        checkOut: searchParams.checkOut,
        guests: searchParams.guests,
      },
    });
  };

  const isHero = variant === 'hero';

  return (
    <div className={`
      ${isHero ? 'bg-white rounded-xl shadow-lg p-6' : 'bg-gray-50 rounded-lg p-4'}
      flex flex-col lg:flex-row gap-4
    `}>
      {/* Location Input */}
      <div className="flex-1">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Destination
        </label>
        <LocationAutocomplete
          value={searchParams.location}
          onChange={(location) => setSearchParams({ location })}
          placeholder="Where are you going?"
        />
      </div>

      {/* Date Range */}
      <div className={isHero ? 'flex-1' : 'w-64'}>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Check-in / Check-out
        </label>
        <DateRangePicker
          startDate={searchParams.checkIn}
          endDate={searchParams.checkOut}
          onChange={(checkIn, checkOut) => setSearchParams({ checkIn, checkOut })}
          minDate={new Date()}
        />
      </div>

      {/* Guests */}
      <div className="w-32">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Guests
        </label>
        <GuestSelector
          value={searchParams.guests}
          onChange={(guests) => setSearchParams({ guests })}
        />
      </div>

      {/* Search Button */}
      <div className="flex items-end">
        <button
          onClick={handleSearch}
          disabled={isLoading}
          className="
            w-full lg:w-auto px-8 py-3 bg-blue-600 text-white rounded-lg
            hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed
            flex items-center justify-center gap-2 font-medium
          "
        >
          <SearchIcon className="w-5 h-5" />
          Search
        </button>
      </div>
    </div>
  );
}
```

### Core Component: AvailabilityCalendar

```tsx
import { useState, useMemo } from 'react';
import {
  format, addMonths, startOfMonth, endOfMonth,
  eachDayOfInterval, isSameMonth, isAfter, isBefore, isSameDay
} from 'date-fns';
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/icons';

interface AvailabilityCalendarProps {
  /** Room availability data by date */
  availability: Record<string, { available: number; price: number }>;
  /** Currently selected check-in date */
  checkIn: Date | null;
  /** Currently selected check-out date */
  checkOut: Date | null;
  /** Callback when dates are selected */
  onDateSelect: (checkIn: Date | null, checkOut: Date | null) => void;
}

/**
 * Interactive calendar showing room availability and prices.
 * Supports check-in/check-out date range selection.
 */
export function AvailabilityCalendar({
  availability,
  checkIn,
  checkOut,
  onDateSelect,
}: AvailabilityCalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date());

  // Generate days for current month view
  const days = useMemo(() => {
    const start = startOfMonth(currentMonth);
    const end = endOfMonth(currentMonth);
    return eachDayOfInterval({ start, end });
  }, [currentMonth]);

  const handleDayClick = (day: Date) => {
    // Don't allow past dates
    if (isBefore(day, new Date())) return;

    // Check if day has availability
    const dateKey = format(day, 'yyyy-MM-dd');
    const dayAvailability = availability[dateKey];
    if (!dayAvailability || dayAvailability.available === 0) return;

    if (!checkIn || (checkIn && checkOut)) {
      // Start new selection
      onDateSelect(day, null);
    } else {
      // Complete selection
      if (isAfter(day, checkIn)) {
        onDateSelect(checkIn, day);
      } else {
        onDateSelect(day, checkIn);
      }
    }
  };

  const getDayClasses = (day: Date) => {
    const dateKey = format(day, 'yyyy-MM-dd');
    const dayAvailability = availability[dateKey];
    const isPast = isBefore(day, new Date());
    const isUnavailable = !dayAvailability || dayAvailability.available === 0;
    const isSelected = (checkIn && isSameDay(day, checkIn)) ||
                       (checkOut && isSameDay(day, checkOut));
    const isInRange = checkIn && checkOut &&
                      isAfter(day, checkIn) && isBefore(day, checkOut);

    return `
      relative h-16 flex flex-col items-center justify-center rounded-lg
      ${isPast ? 'text-gray-300 cursor-not-allowed' : ''}
      ${isUnavailable && !isPast ? 'text-gray-400 bg-gray-100 cursor-not-allowed' : ''}
      ${!isPast && !isUnavailable ? 'cursor-pointer hover:bg-blue-50' : ''}
      ${isSelected ? 'bg-blue-600 text-white hover:bg-blue-700' : ''}
      ${isInRange ? 'bg-blue-100' : ''}
    `;
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border p-4">
      {/* Month Navigation */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, -1))}
          className="p-2 hover:bg-gray-100 rounded-full"
          aria-label="Previous month"
        >
          <ChevronLeftIcon className="w-5 h-5" />
        </button>
        <h3 className="text-lg font-semibold">
          {format(currentMonth, 'MMMM yyyy')}
        </h3>
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
          className="p-2 hover:bg-gray-100 rounded-full"
          aria-label="Next month"
        >
          <ChevronRightIcon className="w-5 h-5" />
        </button>
      </div>

      {/* Day Headers */}
      <div className="grid grid-cols-7 gap-1 mb-2">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
          <div key={day} className="text-center text-sm font-medium text-gray-500">
            {day}
          </div>
        ))}
      </div>

      {/* Calendar Grid */}
      <div className="grid grid-cols-7 gap-1">
        {/* Padding for first week */}
        {Array.from({ length: days[0].getDay() }).map((_, i) => (
          <div key={`pad-${i}`} />
        ))}

        {/* Days */}
        {days.map((day) => {
          const dateKey = format(day, 'yyyy-MM-dd');
          const dayAvailability = availability[dateKey];

          return (
            <button
              key={dateKey}
              onClick={() => handleDayClick(day)}
              disabled={isBefore(day, new Date())}
              className={getDayClasses(day)}
            >
              <span className="text-sm font-medium">{format(day, 'd')}</span>
              {dayAvailability && dayAvailability.available > 0 && (
                <span className="text-xs text-green-600">
                  ${dayAvailability.price}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-4 text-sm text-gray-600">
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 bg-blue-600 rounded" />
          <span>Selected</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 bg-gray-100 rounded" />
          <span>Unavailable</span>
        </div>
      </div>
    </div>
  );
}
```

### Core Component: HotelCard

```tsx
import { Link } from '@tanstack/react-router';
import { StarIcon, MapPinIcon } from '@/components/icons';
import { formatCurrency } from '@/utils';
import type { Hotel } from '@/types';

interface HotelCardProps {
  hotel: Hotel;
  checkIn?: string;
  checkOut?: string;
}

/**
 * Display card for a hotel in search results.
 * Shows image, rating, price, and amenity highlights.
 */
export function HotelCard({ hotel, checkIn, checkOut }: HotelCardProps) {
  return (
    <Link
      to="/hotels/$hotelId"
      params={{ hotelId: hotel.id }}
      search={{ checkIn, checkOut }}
      className="
        group block bg-white rounded-xl shadow-sm border
        hover:shadow-md transition-shadow overflow-hidden
      "
    >
      {/* Image */}
      <div className="relative aspect-[4/3] overflow-hidden">
        <img
          src={hotel.images[0] || '/placeholder-hotel.jpg'}
          alt={hotel.name}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
          loading="lazy"
        />
        {hotel.lowestPrice && (
          <div className="
            absolute bottom-2 right-2 bg-white/90 backdrop-blur-sm
            px-3 py-1 rounded-full font-semibold text-blue-600
          ">
            From {formatCurrency(hotel.lowestPrice)}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 truncate group-hover:text-blue-600">
              {hotel.name}
            </h3>
            <div className="flex items-center gap-1 text-sm text-gray-500 mt-1">
              <MapPinIcon className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{hotel.city}, {hotel.country}</span>
            </div>
          </div>

          {/* Rating */}
          <div className="flex items-center gap-1 bg-blue-50 px-2 py-1 rounded">
            <StarIcon className="w-4 h-4 text-yellow-500" />
            <span className="text-sm font-medium">{hotel.rating?.toFixed(1) || 'New'}</span>
          </div>
        </div>

        {/* Star Rating */}
        <div className="flex items-center gap-0.5 mt-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <StarIcon
              key={i}
              className={`w-4 h-4 ${i < hotel.starRating ? 'text-yellow-400' : 'text-gray-200'}`}
            />
          ))}
          <span className="text-sm text-gray-500 ml-1">{hotel.starRating}-star hotel</span>
        </div>

        {/* Amenities */}
        {hotel.amenities.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {hotel.amenities.slice(0, 4).map((amenity) => (
              <span
                key={amenity}
                className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full"
              >
                {amenity}
              </span>
            ))}
            {hotel.amenities.length > 4 && (
              <span className="text-xs text-gray-500">
                +{hotel.amenities.length - 4} more
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}
```

---

## Step 4: State Management with Zustand (8 minutes)

### Search Store

```typescript
// stores/searchStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { addDays, format } from 'date-fns';

interface SearchParams {
  location: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  rooms: number;
  priceMin: number | null;
  priceMax: number | null;
  starRating: number[];
  amenities: string[];
}

interface SearchState {
  searchParams: SearchParams;
  results: Hotel[];
  isLoading: boolean;
  error: string | null;

  // Actions
  setSearchParams: (params: Partial<SearchParams>) => void;
  resetFilters: () => void;
  setResults: (results: Hotel[]) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
}

const defaultParams: SearchParams = {
  location: '',
  checkIn: format(new Date(), 'yyyy-MM-dd'),
  checkOut: format(addDays(new Date(), 2), 'yyyy-MM-dd'),
  guests: 2,
  rooms: 1,
  priceMin: null,
  priceMax: null,
  starRating: [],
  amenities: [],
};

export const useSearchStore = create<SearchState>()(
  persist(
    (set) => ({
      searchParams: defaultParams,
      results: [],
      isLoading: false,
      error: null,

      setSearchParams: (params) =>
        set((state) => ({
          searchParams: { ...state.searchParams, ...params },
        })),

      resetFilters: () =>
        set((state) => ({
          searchParams: {
            ...state.searchParams,
            priceMin: null,
            priceMax: null,
            starRating: [],
            amenities: [],
          },
        })),

      setResults: (results) => set({ results }),
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => set({ error }),
    }),
    {
      name: 'hotel-search',
      partialize: (state) => ({
        searchParams: {
          location: state.searchParams.location,
          guests: state.searchParams.guests,
          rooms: state.searchParams.rooms,
        },
      }),
    }
  )
);
```

### Booking Store

```typescript
// stores/bookingStore.ts
import { create } from 'zustand';
import type { Hotel, RoomType, BookingDetails } from '@/types';

interface BookingState {
  // Selected booking details
  hotel: Hotel | null;
  roomType: RoomType | null;
  checkIn: string | null;
  checkOut: string | null;
  roomCount: number;

  // Guest details
  guestDetails: GuestDetails | null;

  // Booking flow state
  step: 'select' | 'details' | 'payment' | 'confirmation';
  isProcessing: boolean;
  error: string | null;
  confirmationNumber: string | null;

  // Actions
  setHotel: (hotel: Hotel) => void;
  setRoomType: (roomType: RoomType) => void;
  setDates: (checkIn: string, checkOut: string) => void;
  setRoomCount: (count: number) => void;
  setGuestDetails: (details: GuestDetails) => void;
  setStep: (step: BookingState['step']) => void;
  setProcessing: (isProcessing: boolean) => void;
  setError: (error: string | null) => void;
  setConfirmation: (confirmationNumber: string) => void;
  reset: () => void;

  // Computed
  getTotalPrice: () => number;
  getNightCount: () => number;
}

interface GuestDetails {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  specialRequests?: string;
}

export const useBookingStore = create<BookingState>((set, get) => ({
  hotel: null,
  roomType: null,
  checkIn: null,
  checkOut: null,
  roomCount: 1,
  guestDetails: null,
  step: 'select',
  isProcessing: false,
  error: null,
  confirmationNumber: null,

  setHotel: (hotel) => set({ hotel }),
  setRoomType: (roomType) => set({ roomType }),
  setDates: (checkIn, checkOut) => set({ checkIn, checkOut }),
  setRoomCount: (roomCount) => set({ roomCount }),
  setGuestDetails: (guestDetails) => set({ guestDetails }),
  setStep: (step) => set({ step }),
  setProcessing: (isProcessing) => set({ isProcessing }),
  setError: (error) => set({ error }),
  setConfirmation: (confirmationNumber) => set({ confirmationNumber }),

  reset: () => set({
    hotel: null,
    roomType: null,
    checkIn: null,
    checkOut: null,
    roomCount: 1,
    guestDetails: null,
    step: 'select',
    isProcessing: false,
    error: null,
    confirmationNumber: null,
  }),

  getTotalPrice: () => {
    const { roomType, roomCount } = get();
    const nightCount = get().getNightCount();
    if (!roomType) return 0;
    return roomType.basePrice * roomCount * nightCount;
  },

  getNightCount: () => {
    const { checkIn, checkOut } = get();
    if (!checkIn || !checkOut) return 0;
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    return Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  },
}));
```

### Auth Store

```typescript
// stores/authStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '@/services/api';

interface User {
  id: string;
  email: string;
  name: string;
  role: 'guest' | 'hotel_admin' | 'system_admin';
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  // Actions
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      isLoading: true,

      login: async (email, password) => {
        const response = await api.login({ email, password });
        if (response.ok) {
          const user = await response.json();
          set({ user, isAuthenticated: true });
        } else {
          throw new Error('Invalid credentials');
        }
      },

      logout: async () => {
        await api.logout();
        set({ user: null, isAuthenticated: false });
      },

      checkAuth: async () => {
        try {
          const response = await api.getCurrentUser();
          if (response.ok) {
            const user = await response.json();
            set({ user, isAuthenticated: true, isLoading: false });
          } else {
            set({ user: null, isAuthenticated: false, isLoading: false });
          }
        } catch {
          set({ user: null, isAuthenticated: false, isLoading: false });
        }
      },
    }),
    {
      name: 'auth',
      partialize: (state) => ({ user: state.user }),
    }
  )
);
```

---

## Step 5: Admin Dashboard Components (8 minutes)

### Admin Hotel Management Page

```tsx
// routes/admin.hotels.$hotelId.tsx
import { useParams } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '@/services/api';
import {
  HotelHeader,
  AdminRoomTypeCard,
  RoomTypeModal,
  PricingModal,
  BookingsTable,
  StatsGrid,
} from '@/components/admin';
import { PlusIcon } from '@/components/icons';

export default function AdminHotelPage() {
  const { hotelId } = useParams({ from: '/admin/hotels/$hotelId' });
  const [hotel, setHotel] = useState<Hotel | null>(null);
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);

  const [showRoomModal, setShowRoomModal] = useState(false);
  const [showPricingModal, setShowPricingModal] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<RoomType | null>(null);

  useEffect(() => {
    loadData();
  }, [hotelId]);

  const loadData = async () => {
    const [hotelRes, roomsRes, bookingsRes, statsRes] = await Promise.all([
      api.getHotel(hotelId),
      api.getHotelRoomTypes(hotelId),
      api.getHotelBookings(hotelId),
      api.getHotelStats(hotelId),
    ]);

    setHotel(await hotelRes.json());
    setRoomTypes(await roomsRes.json());
    setBookings(await bookingsRes.json());
    setStats(await statsRes.json());
  };

  const handleCreateRoom = () => {
    setSelectedRoom(null);
    setShowRoomModal(true);
  };

  const handleEditRoom = (room: RoomType) => {
    setSelectedRoom(room);
    setShowRoomModal(true);
  };

  const handlePricing = (room: RoomType) => {
    setSelectedRoom(room);
    setShowPricingModal(true);
  };

  if (!hotel) {
    return <div className="animate-pulse">Loading...</div>;
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Hotel Header */}
      <HotelHeader hotel={hotel} />

      {/* Stats Grid */}
      {stats && <StatsGrid stats={stats} className="mt-6" />}

      {/* Room Types Section */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Room Types</h2>
          <button
            onClick={handleCreateRoom}
            className="
              flex items-center gap-2 px-4 py-2 bg-blue-600 text-white
              rounded-lg hover:bg-blue-700
            "
          >
            <PlusIcon className="w-5 h-5" />
            Add Room Type
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {roomTypes.map((room) => (
            <AdminRoomTypeCard
              key={room.id}
              room={room}
              onEdit={() => handleEditRoom(room)}
              onPricing={() => handlePricing(room)}
            />
          ))}
        </div>
      </section>

      {/* Recent Bookings */}
      <section className="mt-8">
        <h2 className="text-xl font-semibold mb-4">Recent Bookings</h2>
        <BookingsTable bookings={bookings} />
      </section>

      {/* Modals */}
      {showRoomModal && (
        <RoomTypeModal
          hotelId={hotelId}
          room={selectedRoom}
          onClose={() => setShowRoomModal(false)}
          onSuccess={() => {
            setShowRoomModal(false);
            loadData();
          }}
        />
      )}

      {showPricingModal && selectedRoom && (
        <PricingModal
          roomType={selectedRoom}
          onClose={() => setShowPricingModal(false)}
          onSuccess={() => {
            setShowPricingModal(false);
            loadData();
          }}
        />
      )}
    </div>
  );
}
```

### Pricing Override Modal

```tsx
// components/admin/PricingModal.tsx
import { useState, useEffect } from 'react';
import { format, addDays, eachDayOfInterval } from 'date-fns';
import { api } from '@/services/api';
import { Modal } from '@/components/ui';
import type { RoomType, PriceOverride } from '@/types';

interface PricingModalProps {
  roomType: RoomType;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Modal for setting date-specific price overrides.
 * Displays a calendar grid for the next 90 days with editable prices.
 */
export function PricingModal({ roomType, onClose, onSuccess }: PricingModalProps) {
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Generate next 90 days
  const days = eachDayOfInterval({
    start: new Date(),
    end: addDays(new Date(), 90),
  });

  useEffect(() => {
    loadExistingOverrides();
  }, [roomType.id]);

  const loadExistingOverrides = async () => {
    const response = await api.getRoomPriceOverrides(roomType.id);
    const data: PriceOverride[] = await response.json();

    const overrideMap: Record<string, number> = {};
    data.forEach((o) => {
      overrideMap[o.date] = o.price;
    });
    setOverrides(overrideMap);
  };

  const handlePriceChange = (date: string, price: string) => {
    const numPrice = parseFloat(price);
    if (!isNaN(numPrice) && numPrice > 0) {
      setOverrides((prev) => ({ ...prev, [date]: numPrice }));
    } else if (price === '') {
      // Remove override
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[date];
        return next;
      });
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await api.setRoomPriceOverrides(roomType.id, overrides);
      onSuccess();
    } catch (error) {
      console.error('Failed to save pricing:', error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={`Pricing - ${roomType.name}`} size="large">
      <div className="mb-4">
        <p className="text-sm text-gray-600">
          Base price: <strong>${roomType.basePrice}/night</strong>.
          Enter custom prices for specific dates below.
        </p>
      </div>

      {/* Pricing Grid */}
      <div className="max-h-96 overflow-y-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-4 py-2 text-left">Date</th>
              <th className="px-4 py-2 text-left">Day</th>
              <th className="px-4 py-2 text-left">Price</th>
              <th className="px-4 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {days.map((day) => {
              const dateKey = format(day, 'yyyy-MM-dd');
              const hasOverride = dateKey in overrides;
              const price = overrides[dateKey] ?? roomType.basePrice;

              return (
                <tr key={dateKey} className={hasOverride ? 'bg-blue-50' : ''}>
                  <td className="px-4 py-2">{format(day, 'MMM d, yyyy')}</td>
                  <td className="px-4 py-2">{format(day, 'EEE')}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <span className="text-gray-500">$</span>
                      <input
                        type="number"
                        value={hasOverride ? overrides[dateKey] : ''}
                        placeholder={roomType.basePrice.toString()}
                        onChange={(e) => handlePriceChange(dateKey, e.target.value)}
                        className="
                          w-24 px-2 py-1 border rounded
                          focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                        "
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    {hasOverride ? (
                      <span className="text-blue-600 font-medium">Custom</span>
                    ) : (
                      <span className="text-gray-400">Base</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3 mt-6">
        <button
          onClick={onClose}
          className="px-4 py-2 border rounded-lg hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="
            px-4 py-2 bg-blue-600 text-white rounded-lg
            hover:bg-blue-700 disabled:opacity-50
          "
        >
          {isSaving ? 'Saving...' : 'Save Pricing'}
        </button>
      </div>
    </Modal>
  );
}
```

---

## Step 6: Booking Flow Components (5 minutes)

### Guest Details Form

```tsx
// components/booking/GuestDetailsForm.tsx
import { useState } from 'react';
import { useBookingStore } from '@/stores/bookingStore';

/**
 * Form for collecting guest information during booking.
 * Validates required fields and formats phone numbers.
 */
export function GuestDetailsForm({ onSubmit }: { onSubmit: () => void }) {
  const { guestDetails, setGuestDetails } = useBookingStore();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [formData, setFormData] = useState({
    firstName: guestDetails?.firstName || '',
    lastName: guestDetails?.lastName || '',
    email: guestDetails?.email || '',
    phone: guestDetails?.phone || '',
    specialRequests: guestDetails?.specialRequests || '',
  });

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.firstName.trim()) {
      newErrors.firstName = 'First name is required';
    }
    if (!formData.lastName.trim()) {
      newErrors.lastName = 'Last name is required';
    }
    if (!formData.email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Invalid email format';
    }
    if (!formData.phone.trim()) {
      newErrors.phone = 'Phone number is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validate()) {
      setGuestDetails(formData);
      onSubmit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-xl font-semibold mb-4">Guest Details</h2>

      <div className="grid gap-4 md:grid-cols-2">
        {/* First Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            First Name *
          </label>
          <input
            type="text"
            value={formData.firstName}
            onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
            className={`
              w-full px-4 py-2 border rounded-lg
              focus:ring-2 focus:ring-blue-500 focus:border-blue-500
              ${errors.firstName ? 'border-red-500' : 'border-gray-300'}
            `}
          />
          {errors.firstName && (
            <p className="text-red-500 text-sm mt-1">{errors.firstName}</p>
          )}
        </div>

        {/* Last Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Last Name *
          </label>
          <input
            type="text"
            value={formData.lastName}
            onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
            className={`
              w-full px-4 py-2 border rounded-lg
              focus:ring-2 focus:ring-blue-500 focus:border-blue-500
              ${errors.lastName ? 'border-red-500' : 'border-gray-300'}
            `}
          />
          {errors.lastName && (
            <p className="text-red-500 text-sm mt-1">{errors.lastName}</p>
          )}
        </div>
      </div>

      {/* Email */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Email *
        </label>
        <input
          type="email"
          value={formData.email}
          onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          className={`
            w-full px-4 py-2 border rounded-lg
            focus:ring-2 focus:ring-blue-500 focus:border-blue-500
            ${errors.email ? 'border-red-500' : 'border-gray-300'}
          `}
        />
        {errors.email && (
          <p className="text-red-500 text-sm mt-1">{errors.email}</p>
        )}
      </div>

      {/* Phone */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Phone *
        </label>
        <input
          type="tel"
          value={formData.phone}
          onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
          className={`
            w-full px-4 py-2 border rounded-lg
            focus:ring-2 focus:ring-blue-500 focus:border-blue-500
            ${errors.phone ? 'border-red-500' : 'border-gray-300'}
          `}
        />
        {errors.phone && (
          <p className="text-red-500 text-sm mt-1">{errors.phone}</p>
        )}
      </div>

      {/* Special Requests */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Special Requests
        </label>
        <textarea
          value={formData.specialRequests}
          onChange={(e) => setFormData({ ...formData, specialRequests: e.target.value })}
          rows={3}
          className="
            w-full px-4 py-2 border border-gray-300 rounded-lg
            focus:ring-2 focus:ring-blue-500 focus:border-blue-500
          "
          placeholder="Any special requests for your stay..."
        />
      </div>

      <button
        type="submit"
        className="
          w-full py-3 bg-blue-600 text-white rounded-lg font-medium
          hover:bg-blue-700 transition-colors
        "
      >
        Continue to Payment
      </button>
    </form>
  );
}
```

---

## Step 7: Trade-offs Discussion (3 minutes)

### Frontend Trade-offs Table

| Decision | Approach | Trade-off | Rationale |
|----------|----------|-----------|-----------|
| State management | Zustand with persist | Simpler than Redux, less boilerplate | Search/booking state benefits from persistence |
| Routing | TanStack Router | Learning curve vs. type safety | File-based routes with full TypeScript support |
| Calendar component | Custom implementation | Development time vs. flexibility | Full control over availability display |
| Admin dashboard | Component extraction | More files vs. maintainability | Each component < 200 lines, clear responsibility |
| Form validation | Manual validation | Bundle size vs. control | Avoid Zod/Yup dependency for simple forms |
| Date handling | date-fns | Bundle size vs. DX | Tree-shakeable, immutable operations |

### Accessibility Considerations

- Keyboard navigation for date picker and modals
- ARIA labels on interactive elements
- Focus management when modals open/close
- Color contrast meeting WCAG AA standards
- Screen reader announcements for dynamic content

---

## Closing Summary

"I've designed a hotel booking frontend with:

1. **Component architecture** with single responsibility - admin components extracted into dedicated modules
2. **State management** using Zustand with persistence for search, booking, and auth
3. **AvailabilityCalendar** showing prices and availability with intuitive date selection
4. **Admin dashboard** with hotel management, room types, and dynamic pricing modals
5. **Booking flow** with guest details form and price summary

The key insight is separating the search experience (browsing, filtering) from the booking experience (selection, payment) with clear state boundaries. The admin interface mirrors the guest experience while adding management controls. Happy to dive deeper into any component."

---

## Potential Follow-up Questions

1. **How would you handle real-time availability updates?**
   - WebSocket connection for active search pages
   - Optimistic updates with rollback on conflict
   - Toast notification when prices change during booking

2. **How would you optimize for mobile?**
   - Bottom sheet for date picker on mobile
   - Swipeable image gallery
   - Sticky booking summary at bottom

3. **How would you implement offline support?**
   - Service worker for static assets
   - IndexedDB for recent searches
   - Queue booking requests when offline
