# Yelp - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement

"I'll be designing a local business review and discovery platform like Yelp. As a frontend engineer, I'll focus on the search experience with autocomplete, geo-location integration, business detail pages with photo galleries, the review submission flow, and map-based browsing. Let me start by clarifying what we need to build."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Search Experience**
   - Autocomplete with category and business suggestions
   - Location-aware search ("near me" or specific address)
   - Filters for rating, price, distance, open now
   - Sort options (relevance, rating, distance, most reviewed)

2. **Business Detail Pages**
   - Photo gallery with lightbox navigation
   - Business info (hours, address, phone, website)
   - Interactive map showing location
   - Reviews list with pagination and sorting

3. **Review System**
   - Star rating selector (1-5 stars)
   - Rich text review form with photo upload
   - Helpful/not helpful voting on reviews
   - Review submission with optimistic updates

4. **Map Browsing**
   - Interactive map with business markers
   - Marker clustering for dense areas
   - Info popups on marker click
   - "Search this area" functionality

5. **User Dashboard**
   - Business owner management interface
   - User review history
   - Admin moderation panel

### Non-Functional Requirements

- **Performance**: LCP < 2.5s, FID < 100ms, CLS < 0.1
- **Accessibility**: WCAG 2.1 AA compliance
- **Responsive**: Mobile-first with desktop optimization
- **Offline**: Service worker for cached searches

---

## 2. Frontend Architecture Overview (4-5 minutes)

### Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Framework | React 19 | Component model, hooks, concurrent features |
| Routing | TanStack Router | Type-safe file-based routing |
| State | Zustand | Lightweight global state |
| Styling | Tailwind CSS | Utility-first, responsive |
| Maps | Mapbox GL JS | Vector tiles, clustering, performance |
| Forms | React Hook Form + Zod | Validation, type safety |
| HTTP | Axios | Interceptors, cancellation |

### Directory Structure

```
frontend/src/
├── components/
│   ├── business/           # Business detail components
│   │   ├── index.ts              # Barrel export
│   │   ├── PhotoGallery.tsx      # Image carousel with lightbox
│   │   ├── BusinessHeader.tsx    # Name, rating, categories
│   │   ├── BusinessSidebar.tsx   # Contact info and hours
│   │   ├── ReviewForm.tsx        # Review submission form
│   │   └── ReviewsList.tsx       # Paginated reviews
│   ├── search/             # Search experience components
│   │   ├── index.ts
│   │   ├── SearchBar.tsx         # Autocomplete search input
│   │   ├── FilterPanel.tsx       # Rating, price, distance filters
│   │   ├── SearchResults.tsx     # Business card grid
│   │   └── MapView.tsx           # Interactive business map
│   ├── common/             # Shared UI components
│   │   ├── StarRating.tsx        # Star display and selector
│   │   ├── PriceLevel.tsx        # Dollar sign indicators
│   │   ├── Badge.tsx             # Category badges
│   │   └── Modal.tsx             # Accessible modal
│   ├── admin/              # Admin dashboard components
│   └── dashboard/          # Business owner components
├── routes/                 # TanStack Router pages
│   ├── __root.tsx          # Root layout with header
│   ├── index.tsx           # Home with search
│   ├── search.tsx          # Search results
│   ├── business.$slug.tsx  # Business detail
│   ├── write-review.$id.tsx # Review form page
│   ├── login.tsx           # Login form
│   ├── register.tsx        # Registration
│   ├── dashboard.tsx       # Business owner dashboard
│   └── admin.tsx           # Admin panel
├── services/
│   └── api.ts              # Axios API client
├── stores/
│   ├── authStore.ts        # Authentication state
│   └── searchStore.ts      # Search filters and results
├── hooks/
│   ├── useGeolocation.ts   # Browser geolocation
│   ├── useDebounce.ts      # Input debouncing
│   └── useIntersection.ts  # Infinite scroll
└── types/
    └── index.ts            # TypeScript interfaces
```

---

## 3. Deep Dive: Search Experience (8-10 minutes)

### Autocomplete Search Bar

```tsx
// components/search/SearchBar.tsx
import { useState, useRef, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useDebounce } from '../../hooks/useDebounce';
import api from '../../services/api';

interface Suggestion {
  type: 'business' | 'category';
  id: string;
  name: string;
  category?: string;
  distance?: number;
}

interface SearchBarProps {
  initialQuery?: string;
  onSearch?: (query: string, location: string) => void;
}

export function SearchBar({ initialQuery = '', onSearch }: SearchBarProps) {
  const [query, setQuery] = useState(initialQuery);
  const [location, setLocation] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const debouncedQuery = useDebounce(query, 200);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const navigate = useNavigate();

  // Fetch suggestions on debounced query change
  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setSuggestions([]);
      return;
    }

    const controller = new AbortController();

    api.get<{ suggestions: Suggestion[] }>('/search/autocomplete', {
      params: { q: debouncedQuery },
      signal: controller.signal
    })
      .then((res) => setSuggestions(res.data.suggestions))
      .catch(() => {}); // Ignore aborted requests

    return () => controller.abort();
  }, [debouncedQuery]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && suggestions[activeIndex]) {
          selectSuggestion(suggestions[activeIndex]);
        } else {
          handleSearch();
        }
        break;
      case 'Escape':
        setIsOpen(false);
        inputRef.current?.blur();
        break;
    }
  };

  const selectSuggestion = (suggestion: Suggestion) => {
    if (suggestion.type === 'business') {
      navigate({ to: '/business/$slug', params: { slug: suggestion.id } });
    } else {
      setQuery(suggestion.name);
      handleSearch();
    }
    setIsOpen(false);
  };

  const handleSearch = () => {
    if (onSearch) {
      onSearch(query, location);
    } else {
      navigate({
        to: '/search',
        search: { q: query, location }
      });
    }
  };

  return (
    <div className="relative flex gap-2">
      {/* Search input */}
      <div className="relative flex-1">
        <label htmlFor="search-input" className="sr-only">
          Search businesses
        </label>
        <input
          ref={inputRef}
          id="search-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setTimeout(() => setIsOpen(false), 200)}
          onKeyDown={handleKeyDown}
          placeholder="Restaurants, bars, coffee..."
          className="w-full px-4 py-3 border border-gray-300 rounded-l-lg
                     focus:outline-none focus:ring-2 focus:ring-yelp-red"
          autoComplete="off"
          aria-expanded={isOpen && suggestions.length > 0}
          aria-haspopup="listbox"
          aria-controls="search-suggestions"
          aria-activedescendant={
            activeIndex >= 0 ? `suggestion-${activeIndex}` : undefined
          }
        />

        {/* Suggestions dropdown */}
        {isOpen && suggestions.length > 0 && (
          <ul
            ref={listRef}
            id="search-suggestions"
            role="listbox"
            className="absolute top-full left-0 right-0 mt-1 bg-white
                       border border-gray-200 rounded-lg shadow-lg z-50
                       max-h-80 overflow-y-auto"
          >
            {suggestions.map((suggestion, index) => (
              <li
                key={`${suggestion.type}-${suggestion.id}`}
                id={`suggestion-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                onClick={() => selectSuggestion(suggestion)}
                className={`px-4 py-3 cursor-pointer flex items-center gap-3
                  ${index === activeIndex ? 'bg-gray-100' : 'hover:bg-gray-50'}`}
              >
                {suggestion.type === 'business' ? (
                  <BuildingIcon className="w-5 h-5 text-gray-400" />
                ) : (
                  <TagIcon className="w-5 h-5 text-gray-400" />
                )}
                <div>
                  <div className="font-medium">{suggestion.name}</div>
                  {suggestion.category && (
                    <div className="text-sm text-gray-500">
                      {suggestion.category}
                    </div>
                  )}
                </div>
                {suggestion.distance && (
                  <span className="ml-auto text-sm text-gray-400">
                    {suggestion.distance.toFixed(1)} mi
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Location input */}
      <div className="relative w-64">
        <label htmlFor="location-input" className="sr-only">
          Location
        </label>
        <input
          id="location-input"
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="San Francisco, CA"
          className="w-full px-4 py-3 border border-gray-300
                     focus:outline-none focus:ring-2 focus:ring-yelp-red"
        />
        <button
          type="button"
          onClick={() => navigator.geolocation.getCurrentPosition(
            (pos) => setLocation(`${pos.coords.latitude},${pos.coords.longitude}`)
          )}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-2
                     text-gray-400 hover:text-yelp-red"
          aria-label="Use current location"
        >
          <LocationIcon className="w-5 h-5" />
        </button>
      </div>

      {/* Search button */}
      <button
        type="button"
        onClick={handleSearch}
        className="px-6 py-3 bg-yelp-red text-white font-semibold
                   rounded-r-lg hover:bg-red-700 transition-colors"
      >
        Search
      </button>
    </div>
  );
}
```

### Geolocation Hook

```tsx
// hooks/useGeolocation.ts
import { useState, useEffect, useCallback } from 'react';

interface GeolocationState {
  latitude: number | null;
  longitude: number | null;
  error: string | null;
  loading: boolean;
}

export function useGeolocation(options?: PositionOptions) {
  const [state, setState] = useState<GeolocationState>({
    latitude: null,
    longitude: null,
    error: null,
    loading: false
  });

  const getLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setState((prev) => ({
        ...prev,
        error: 'Geolocation is not supported'
      }));
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: null }));

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setState({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          error: null,
          loading: false
        });
      },
      (error) => {
        setState((prev) => ({
          ...prev,
          error: error.message,
          loading: false
        }));
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000, // 5 minutes cache
        ...options
      }
    );
  }, [options]);

  return { ...state, getLocation };
}
```

### Filter Panel with URL Sync

```tsx
// components/search/FilterPanel.tsx
import { useSearch, useNavigate } from '@tanstack/react-router';

interface FilterPanelProps {
  onFilterChange?: () => void;
}

export function FilterPanel({ onFilterChange }: FilterPanelProps) {
  const search = useSearch({ from: '/search' });
  const navigate = useNavigate();

  const updateFilter = (key: string, value: string | number | null) => {
    navigate({
      to: '/search',
      search: (prev) => ({
        ...prev,
        [key]: value,
        page: 1 // Reset to first page on filter change
      }),
      replace: true
    });
    onFilterChange?.();
  };

  return (
    <div className="space-y-6 p-4 bg-white rounded-lg shadow">
      {/* Rating filter */}
      <div>
        <h3 className="font-semibold mb-3">Rating</h3>
        <div className="space-y-2">
          {[5, 4, 3, 2].map((rating) => (
            <label
              key={rating}
              className="flex items-center gap-2 cursor-pointer"
            >
              <input
                type="radio"
                name="rating"
                checked={search.minRating === rating}
                onChange={() => updateFilter('minRating', rating)}
                className="text-yelp-red focus:ring-yelp-red"
              />
              <StarRating rating={rating} size="sm" />
              <span className="text-gray-600">& up</span>
            </label>
          ))}
        </div>
      </div>

      {/* Price level filter */}
      <div>
        <h3 className="font-semibold mb-3">Price</h3>
        <div className="flex gap-2">
          {[1, 2, 3, 4].map((level) => (
            <button
              key={level}
              onClick={() =>
                updateFilter('price', search.price === level ? null : level)
              }
              className={`px-4 py-2 border rounded-lg transition-colors
                ${search.price === level
                  ? 'bg-yelp-red text-white border-yelp-red'
                  : 'border-gray-300 hover:border-yelp-red'
                }`}
            >
              {'$'.repeat(level)}
            </button>
          ))}
        </div>
      </div>

      {/* Distance filter */}
      <div>
        <h3 className="font-semibold mb-3">Distance</h3>
        <select
          value={search.distance || ''}
          onChange={(e) =>
            updateFilter('distance', e.target.value || null)
          }
          className="w-full px-4 py-2 border border-gray-300 rounded-lg
                     focus:outline-none focus:ring-2 focus:ring-yelp-red"
        >
          <option value="">Any distance</option>
          <option value="0.5">Walking (0.5 mi)</option>
          <option value="1">1 mile</option>
          <option value="5">5 miles</option>
          <option value="10">10 miles</option>
          <option value="25">25 miles</option>
        </select>
      </div>

      {/* Open Now toggle */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={search.openNow === true}
            onChange={(e) =>
              updateFilter('openNow', e.target.checked || null)
            }
            className="w-5 h-5 text-yelp-red rounded focus:ring-yelp-red"
          />
          <span className="font-medium">Open Now</span>
        </label>
      </div>

      {/* Clear filters */}
      <button
        onClick={() =>
          navigate({
            to: '/search',
            search: { q: search.q, location: search.location }
          })
        }
        className="w-full py-2 text-yelp-red hover:underline"
      >
        Clear all filters
      </button>
    </div>
  );
}
```

---

## 4. Deep Dive: Business Detail Page (7-8 minutes)

### Photo Gallery with Lightbox

```tsx
// components/business/PhotoGallery.tsx
import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface PhotoGalleryProps {
  photos: string[];
  businessName: string;
}

export function PhotoGallery({ photos, businessName }: PhotoGalleryProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  // Keyboard navigation in lightbox
  useEffect(() => {
    if (!lightboxOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          setCurrentIndex((prev) => (prev > 0 ? prev - 1 : photos.length - 1));
          break;
        case 'ArrowRight':
          setCurrentIndex((prev) => (prev < photos.length - 1 ? prev + 1 : 0));
          break;
        case 'Escape':
          setLightboxOpen(false);
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [lightboxOpen, photos.length]);

  const openLightbox = useCallback((index: number) => {
    setCurrentIndex(index);
    setLightboxOpen(true);
  }, []);

  if (photos.length === 0) {
    return (
      <div className="h-64 bg-gray-200 flex items-center justify-center">
        <span className="text-gray-400">No photos available</span>
      </div>
    );
  }

  return (
    <>
      {/* Photo grid */}
      <div className="grid grid-cols-4 grid-rows-2 gap-1 h-80 rounded-lg overflow-hidden">
        {/* Main photo */}
        <button
          onClick={() => openLightbox(0)}
          className="col-span-2 row-span-2 relative group"
        >
          <img
            src={photos[0]}
            alt={`${businessName} - Photo 1`}
            className="w-full h-full object-cover"
            loading="eager"
          />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
        </button>

        {/* Secondary photos */}
        {photos.slice(1, 5).map((photo, index) => (
          <button
            key={photo}
            onClick={() => openLightbox(index + 1)}
            className="relative group"
          >
            <img
              src={photo}
              alt={`${businessName} - Photo ${index + 2}`}
              className="w-full h-full object-cover"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />

            {/* "See all photos" overlay on last visible photo */}
            {index === 3 && photos.length > 5 && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                <span className="text-white font-semibold">
                  +{photos.length - 5} more
                </span>
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Lightbox modal */}
      {lightboxOpen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Photo gallery"
            className="fixed inset-0 z-50 bg-black flex items-center justify-center"
          >
            {/* Close button */}
            <button
              onClick={() => setLightboxOpen(false)}
              className="absolute top-4 right-4 p-2 text-white hover:bg-white/10 rounded-full"
              aria-label="Close gallery"
            >
              <XIcon className="w-8 h-8" />
            </button>

            {/* Navigation arrows */}
            <button
              onClick={() =>
                setCurrentIndex((prev) =>
                  prev > 0 ? prev - 1 : photos.length - 1
                )
              }
              className="absolute left-4 p-2 text-white hover:bg-white/10 rounded-full"
              aria-label="Previous photo"
            >
              <ChevronLeftIcon className="w-8 h-8" />
            </button>

            <button
              onClick={() =>
                setCurrentIndex((prev) =>
                  prev < photos.length - 1 ? prev + 1 : 0
                )
              }
              className="absolute right-4 p-2 text-white hover:bg-white/10 rounded-full"
              aria-label="Next photo"
            >
              <ChevronRightIcon className="w-8 h-8" />
            </button>

            {/* Current photo */}
            <img
              src={photos[currentIndex]}
              alt={`${businessName} - Photo ${currentIndex + 1} of ${photos.length}`}
              className="max-h-[90vh] max-w-[90vw] object-contain"
            />

            {/* Photo counter */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white">
              {currentIndex + 1} / {photos.length}
            </div>

            {/* Thumbnail strip */}
            <div className="absolute bottom-16 left-1/2 -translate-x-1/2 flex gap-2 max-w-[80vw] overflow-x-auto">
              {photos.map((photo, index) => (
                <button
                  key={photo}
                  onClick={() => setCurrentIndex(index)}
                  className={`w-16 h-12 flex-shrink-0 rounded overflow-hidden
                    ${index === currentIndex ? 'ring-2 ring-white' : 'opacity-50'}`}
                >
                  <img
                    src={photo}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
```

### Business Hours Component

```tsx
// components/business/BusinessSidebar.tsx
import { useMemo } from 'react';

interface BusinessHours {
  [day: string]: { open: string; close: string } | null;
}

interface BusinessSidebarProps {
  business: {
    phone: string;
    website: string;
    address: string;
    city: string;
    state: string;
    hours: BusinessHours;
    latitude: number;
    longitude: number;
  };
}

export function BusinessSidebar({ business }: BusinessSidebarProps) {
  const { isOpen, todayHours, closingTime } = useMemo(() => {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const now = new Date();
    const today = days[now.getDay()];
    const todayHours = business.hours[today];

    if (!todayHours) {
      return { isOpen: false, todayHours: null, closingTime: null };
    }

    const currentTime = now.toTimeString().slice(0, 5);
    const isOpen = currentTime >= todayHours.open && currentTime < todayHours.close;

    return {
      isOpen,
      todayHours,
      closingTime: todayHours.close
    };
  }, [business.hours]);

  return (
    <aside className="bg-white rounded-lg shadow p-6 space-y-6">
      {/* Open/Closed status */}
      <div className="flex items-center gap-2">
        <span
          className={`px-3 py-1 rounded-full text-sm font-medium
            ${isOpen ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}
        >
          {isOpen ? 'Open' : 'Closed'}
        </span>
        {isOpen && closingTime && (
          <span className="text-gray-600">
            Closes at {formatTime(closingTime)}
          </span>
        )}
      </div>

      {/* Phone */}
      {business.phone && (
        <div className="flex items-center gap-3">
          <PhoneIcon className="w-5 h-5 text-gray-400" />
          <a
            href={`tel:${business.phone}`}
            className="text-yelp-blue hover:underline"
          >
            {formatPhoneNumber(business.phone)}
          </a>
        </div>
      )}

      {/* Website */}
      {business.website && (
        <div className="flex items-center gap-3">
          <GlobeIcon className="w-5 h-5 text-gray-400" />
          <a
            href={business.website}
            target="_blank"
            rel="noopener noreferrer"
            className="text-yelp-blue hover:underline truncate"
          >
            {new URL(business.website).hostname}
          </a>
        </div>
      )}

      {/* Address with directions link */}
      <div className="flex items-start gap-3">
        <MapPinIcon className="w-5 h-5 text-gray-400 mt-0.5" />
        <div>
          <p>{business.address}</p>
          <p>{business.city}, {business.state}</p>
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${business.latitude},${business.longitude}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-yelp-blue hover:underline text-sm"
          >
            Get Directions
          </a>
        </div>
      </div>

      {/* Hours table */}
      <div>
        <h3 className="font-semibold mb-3">Hours</h3>
        <dl className="space-y-1 text-sm">
          {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => {
            const hours = business.hours[day];
            const isToday = new Date().toLocaleDateString('en-US', { weekday: 'long' }) === day;

            return (
              <div
                key={day}
                className={`flex justify-between ${isToday ? 'font-semibold' : ''}`}
              >
                <dt>{day}</dt>
                <dd>
                  {hours
                    ? `${formatTime(hours.open)} - ${formatTime(hours.close)}`
                    : 'Closed'}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </aside>
  );
}

function formatTime(time: string): string {
  const [hours, minutes] = time.split(':');
  const h = parseInt(hours);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${minutes} ${ampm}`;
}

function formatPhoneNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  return phone;
}
```

---

## 5. Deep Dive: Star Rating Component (4-5 minutes)

### Interactive Star Rating

```tsx
// components/common/StarRating.tsx
import { useState, useCallback } from 'react';

interface StarRatingProps {
  rating: number;
  size?: 'sm' | 'md' | 'lg';
  interactive?: boolean;
  onChange?: (rating: number) => void;
  showValue?: boolean;
}

export function StarRating({
  rating,
  size = 'md',
  interactive = false,
  onChange,
  showValue = false
}: StarRatingProps) {
  const [hoverRating, setHoverRating] = useState<number | null>(null);

  const displayRating = hoverRating ?? rating;

  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-7 h-7'
  };

  const colorClasses = {
    full: 'text-yelp-red fill-current',
    half: 'text-yelp-red',
    empty: 'text-gray-300'
  };

  const handleClick = useCallback(
    (value: number) => {
      if (interactive && onChange) {
        onChange(value);
      }
    },
    [interactive, onChange]
  );

  const renderStar = (index: number) => {
    const value = index + 1;
    const fillAmount = Math.min(Math.max(displayRating - index, 0), 1);

    let starType: 'full' | 'half' | 'empty';
    if (fillAmount >= 0.75) {
      starType = 'full';
    } else if (fillAmount >= 0.25) {
      starType = 'half';
    } else {
      starType = 'empty';
    }

    const StarComponent = starType === 'half' ? HalfStar : FullStar;

    return (
      <button
        key={index}
        type="button"
        onClick={() => handleClick(value)}
        onMouseEnter={() => interactive && setHoverRating(value)}
        onMouseLeave={() => interactive && setHoverRating(null)}
        className={`${interactive ? 'cursor-pointer' : 'cursor-default'}
                    ${sizeClasses[size]} ${colorClasses[starType]}`}
        disabled={!interactive}
        aria-label={interactive ? `Rate ${value} stars` : undefined}
      >
        <StarComponent />
      </button>
    );
  };

  return (
    <div
      className="inline-flex items-center gap-0.5"
      role={interactive ? 'radiogroup' : 'img'}
      aria-label={interactive ? 'Rating' : `${rating.toFixed(1)} out of 5 stars`}
    >
      {[0, 1, 2, 3, 4].map(renderStar)}
      {showValue && (
        <span className="ml-2 text-gray-600 font-medium">
          {rating.toFixed(1)}
        </span>
      )}
    </div>
  );
}

function FullStar() {
  return (
    <svg viewBox="0 0 20 20" className="w-full h-full">
      <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
    </svg>
  );
}

function HalfStar() {
  return (
    <svg viewBox="0 0 20 20" className="w-full h-full">
      <defs>
        <linearGradient id="half-fill">
          <stop offset="50%" stopColor="currentColor" />
          <stop offset="50%" stopColor="#D1D5DB" />
        </linearGradient>
      </defs>
      <path
        d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z"
        fill="url(#half-fill)"
      />
    </svg>
  );
}
```

---

## 6. Deep Dive: Review Form (6-7 minutes)

### Review Submission with Photo Upload

```tsx
// components/business/ReviewForm.tsx
import { useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import api from '../../services/api';
import { StarRating } from '../common/StarRating';

const reviewSchema = z.object({
  rating: z.number().min(1, 'Please select a rating').max(5),
  title: z.string().min(3, 'Title must be at least 3 characters').max(200),
  content: z.string().min(50, 'Review must be at least 50 characters').max(5000)
});

type ReviewFormData = z.infer<typeof reviewSchema>;

interface ReviewFormProps {
  businessId: string;
  businessName: string;
  onSuccess: (review: Review) => void;
}

export function ReviewForm({ businessId, businessName, onSuccess }: ReviewFormProps) {
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoPreview, setPhotoPreview] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<ReviewFormData>({
    resolver: zodResolver(reviewSchema),
    defaultValues: { rating: 0 }
  });

  const currentRating = watch('rating');

  const handlePhotoSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (photos.length + files.length > 5) {
      alert('Maximum 5 photos allowed');
      return;
    }

    // Validate file types and sizes
    const validFiles = files.filter((file) => {
      if (!file.type.startsWith('image/')) {
        alert(`${file.name} is not an image`);
        return false;
      }
      if (file.size > 5 * 1024 * 1024) {
        alert(`${file.name} is too large (max 5MB)`);
        return false;
      }
      return true;
    });

    setPhotos((prev) => [...prev, ...validFiles]);

    // Generate previews
    validFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoPreview((prev) => [...prev, reader.result as string]);
      };
      reader.readAsDataURL(file);
    });
  }, [photos.length]);

  const removePhoto = useCallback((index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
    setPhotoPreview((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const onSubmit = async (data: ReviewFormData) => {
    // Generate idempotency key for retry safety
    const idempotencyKey = uuidv4();

    try {
      setUploading(true);

      // Upload photos first (if any)
      let photoUrls: string[] = [];
      if (photos.length > 0) {
        const formData = new FormData();
        photos.forEach((photo) => formData.append('photos', photo));

        const uploadRes = await api.post<{ urls: string[] }>(
          `/businesses/${businessId}/photos`,
          formData,
          { headers: { 'Content-Type': 'multipart/form-data' } }
        );
        photoUrls = uploadRes.data.urls;
      }

      // Submit review with idempotency key
      const response = await api.post<{ review: Review }>(
        `/businesses/${businessId}/reviews`,
        { ...data, photoUrls },
        { headers: { 'Idempotency-Key': idempotencyKey } }
      );

      onSuccess(response.data.review);
    } catch (error) {
      // Handle duplicate review error
      if (error.response?.status === 409) {
        alert('You have already reviewed this business');
      } else {
        throw error;
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <h2 className="text-2xl font-bold">
        Write a review for {businessName}
      </h2>

      {/* Star rating selector */}
      <div>
        <label className="block font-medium mb-2">Your rating</label>
        <div className="flex items-center gap-4">
          <StarRating
            rating={currentRating}
            size="lg"
            interactive
            onChange={(rating) => setValue('rating', rating)}
          />
          <span className="text-gray-600">
            {ratingLabels[currentRating] || 'Select your rating'}
          </span>
        </div>
        {errors.rating && (
          <p className="text-red-500 text-sm mt-1">{errors.rating.message}</p>
        )}
      </div>

      {/* Title */}
      <div>
        <label htmlFor="review-title" className="block font-medium mb-2">
          Review title
        </label>
        <input
          id="review-title"
          type="text"
          {...register('title')}
          placeholder="Summarize your experience"
          className="w-full px-4 py-2 border border-gray-300 rounded-lg
                     focus:outline-none focus:ring-2 focus:ring-yelp-red"
        />
        {errors.title && (
          <p className="text-red-500 text-sm mt-1">{errors.title.message}</p>
        )}
      </div>

      {/* Content */}
      <div>
        <label htmlFor="review-content" className="block font-medium mb-2">
          Your review
        </label>
        <textarea
          id="review-content"
          {...register('content')}
          rows={6}
          placeholder="Tell others about your experience. What made it great? What could be improved?"
          className="w-full px-4 py-2 border border-gray-300 rounded-lg
                     focus:outline-none focus:ring-2 focus:ring-yelp-red resize-y"
        />
        {errors.content && (
          <p className="text-red-500 text-sm mt-1">{errors.content.message}</p>
        )}
      </div>

      {/* Photo upload */}
      <div>
        <label className="block font-medium mb-2">
          Add photos (optional)
        </label>
        <div className="flex flex-wrap gap-4">
          {photoPreview.map((preview, index) => (
            <div key={index} className="relative w-24 h-24">
              <img
                src={preview}
                alt={`Upload preview ${index + 1}`}
                className="w-full h-full object-cover rounded-lg"
              />
              <button
                type="button"
                onClick={() => removePhoto(index)}
                className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white
                           rounded-full flex items-center justify-center text-xs"
                aria-label={`Remove photo ${index + 1}`}
              >
                X
              </button>
            </div>
          ))}

          {photos.length < 5 && (
            <label className="w-24 h-24 border-2 border-dashed border-gray-300
                              rounded-lg flex flex-col items-center justify-center
                              cursor-pointer hover:border-yelp-red transition-colors">
              <CameraIcon className="w-6 h-6 text-gray-400" />
              <span className="text-xs text-gray-400 mt-1">Add photo</span>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handlePhotoSelect}
                className="sr-only"
              />
            </label>
          )}
        </div>
        <p className="text-sm text-gray-500 mt-2">
          Up to 5 photos, max 5MB each
        </p>
      </div>

      {/* Submit button */}
      <button
        type="submit"
        disabled={isSubmitting || uploading}
        className="w-full py-3 bg-yelp-red text-white font-semibold rounded-lg
                   hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed
                   transition-colors"
      >
        {isSubmitting || uploading ? 'Submitting...' : 'Post Review'}
      </button>
    </form>
  );
}

const ratingLabels: Record<number, string> = {
  1: 'Not good',
  2: 'Could be better',
  3: 'OK',
  4: 'Good',
  5: 'Great!'
};
```

---

## 7. Deep Dive: Map View (5-6 minutes)

### Interactive Map with Markers

```tsx
// components/search/MapView.tsx
import { useRef, useEffect, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

interface Business {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  rating: number;
  reviewCount: number;
  categories: string[];
}

interface MapViewProps {
  businesses: Business[];
  center: { lat: number; lng: number };
  zoom?: number;
  onBusinessClick?: (business: Business) => void;
  onBoundsChange?: (bounds: mapboxgl.LngLatBounds) => void;
}

export function MapView({
  businesses,
  center,
  zoom = 13,
  onBusinessClick,
  onBoundsChange
}: MapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markers = useRef<mapboxgl.Marker[]>([]);
  const [showSearchArea, setShowSearchArea] = useState(false);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [center.lng, center.lat],
      zoom
    });

    // Add navigation controls
    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

    // Track map movement for "Search this area" button
    map.current.on('moveend', () => {
      setShowSearchArea(true);
      if (onBoundsChange && map.current) {
        onBoundsChange(map.current.getBounds());
      }
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Update markers when businesses change
  useEffect(() => {
    if (!map.current) return;

    // Clear existing markers
    markers.current.forEach((marker) => marker.remove());
    markers.current = [];

    // Add new markers
    businesses.forEach((business) => {
      // Create custom marker element
      const el = document.createElement('div');
      el.className = 'business-marker';
      el.innerHTML = `
        <div class="w-8 h-8 bg-yelp-red rounded-full flex items-center justify-center
                    text-white font-bold text-sm shadow-lg cursor-pointer
                    hover:scale-110 transition-transform">
          ${business.rating.toFixed(1)}
        </div>
      `;

      // Create popup
      const popup = new mapboxgl.Popup({ offset: 25, closeButton: false })
        .setHTML(`
          <div class="p-2 min-w-[200px]">
            <h3 class="font-semibold">${business.name}</h3>
            <div class="flex items-center gap-1 text-sm">
              <span class="text-yelp-red">★ ${business.rating.toFixed(1)}</span>
              <span class="text-gray-500">(${business.reviewCount} reviews)</span>
            </div>
            <div class="text-sm text-gray-600 mt-1">
              ${business.categories.slice(0, 2).join(', ')}
            </div>
          </div>
        `);

      // Create and add marker
      const marker = new mapboxgl.Marker(el)
        .setLngLat([business.longitude, business.latitude])
        .setPopup(popup)
        .addTo(map.current!);

      // Handle click
      el.addEventListener('click', () => {
        onBusinessClick?.(business);
      });

      markers.current.push(marker);
    });
  }, [businesses, onBusinessClick]);

  // Fit bounds to show all markers
  const fitToMarkers = useCallback(() => {
    if (!map.current || businesses.length === 0) return;

    const bounds = new mapboxgl.LngLatBounds();
    businesses.forEach((b) => bounds.extend([b.longitude, b.latitude]));
    map.current.fitBounds(bounds, { padding: 50, maxZoom: 15 });
  }, [businesses]);

  const handleSearchArea = useCallback(() => {
    if (!map.current || !onBoundsChange) return;
    onBoundsChange(map.current.getBounds());
    setShowSearchArea(false);
  }, [onBoundsChange]);

  return (
    <div className="relative h-full">
      <div ref={mapContainer} className="w-full h-full rounded-lg" />

      {/* Search this area button */}
      {showSearchArea && (
        <button
          onClick={handleSearchArea}
          className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2
                     bg-white shadow-lg rounded-full font-medium
                     hover:bg-gray-50 transition-colors z-10"
        >
          Search this area
        </button>
      )}

      {/* Fit to markers button */}
      <button
        onClick={fitToMarkers}
        className="absolute bottom-4 right-4 p-2 bg-white shadow-lg rounded-lg
                   hover:bg-gray-50 transition-colors z-10"
        aria-label="Fit map to all results"
      >
        <ExpandIcon className="w-5 h-5" />
      </button>
    </div>
  );
}
```

---

## 8. State Management with Zustand (3-4 minutes)

### Search State Store

```tsx
// stores/searchStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SearchFilters {
  minRating: number | null;
  price: number | null;
  distance: number | null;
  openNow: boolean;
  categories: string[];
}

interface SearchState {
  query: string;
  location: string;
  coordinates: { lat: number; lng: number } | null;
  filters: SearchFilters;
  recentSearches: string[];
  setQuery: (query: string) => void;
  setLocation: (location: string) => void;
  setCoordinates: (coords: { lat: number; lng: number } | null) => void;
  updateFilter: <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => void;
  clearFilters: () => void;
  addRecentSearch: (search: string) => void;
}

const defaultFilters: SearchFilters = {
  minRating: null,
  price: null,
  distance: null,
  openNow: false,
  categories: []
};

export const useSearchStore = create<SearchState>()(
  persist(
    (set) => ({
      query: '',
      location: '',
      coordinates: null,
      filters: defaultFilters,
      recentSearches: [],

      setQuery: (query) => set({ query }),

      setLocation: (location) => set({ location }),

      setCoordinates: (coordinates) => set({ coordinates }),

      updateFilter: (key, value) =>
        set((state) => ({
          filters: { ...state.filters, [key]: value }
        })),

      clearFilters: () => set({ filters: defaultFilters }),

      addRecentSearch: (search) =>
        set((state) => ({
          recentSearches: [
            search,
            ...state.recentSearches.filter((s) => s !== search)
          ].slice(0, 10)
        }))
    }),
    {
      name: 'yelp-search',
      partialize: (state) => ({
        recentSearches: state.recentSearches,
        location: state.location
      })
    }
  )
);
```

---

## 9. Performance Optimizations (3-4 minutes)

### Image Optimization

```tsx
// components/common/OptimizedImage.tsx
import { useState, useRef, useEffect } from 'react';

interface OptimizedImageProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  priority?: boolean;
}

export function OptimizedImage({
  src,
  alt,
  width,
  height,
  className = '',
  priority = false
}: OptimizedImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isInView, setIsInView] = useState(priority);
  const imgRef = useRef<HTMLDivElement>(null);

  // Intersection Observer for lazy loading
  useEffect(() => {
    if (priority || isInView) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );

    if (imgRef.current) {
      observer.observe(imgRef.current);
    }

    return () => observer.disconnect();
  }, [priority, isInView]);

  // Generate srcset for responsive images
  const generateSrcSet = (baseSrc: string) => {
    const widths = [320, 640, 960, 1280];
    return widths
      .map((w) => `${baseSrc}?w=${w} ${w}w`)
      .join(', ');
  };

  return (
    <div
      ref={imgRef}
      className={`relative overflow-hidden ${className}`}
      style={{ aspectRatio: `${width}/${height}` }}
    >
      {/* Placeholder */}
      {!isLoaded && (
        <div className="absolute inset-0 bg-gray-200 animate-pulse" />
      )}

      {/* Actual image */}
      {isInView && (
        <img
          src={src}
          srcSet={generateSrcSet(src)}
          sizes={`(max-width: 640px) 100vw, ${width}px`}
          alt={alt}
          width={width}
          height={height}
          onLoad={() => setIsLoaded(true)}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          className={`w-full h-full object-cover transition-opacity duration-300
            ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </div>
  );
}
```

### Infinite Scroll for Reviews

```tsx
// hooks/useInfiniteScroll.ts
import { useEffect, useRef, useCallback, useState } from 'react';

interface UseInfiniteScrollOptions {
  threshold?: number;
  rootMargin?: string;
}

export function useInfiniteScroll(
  loadMore: () => Promise<void>,
  hasMore: boolean,
  options: UseInfiniteScrollOptions = {}
) {
  const { threshold = 0.1, rootMargin = '100px' } = options;
  const [isLoading, setIsLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const handleLoadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;
    setIsLoading(true);
    try {
      await loadMore();
    } finally {
      setIsLoading(false);
    }
  }, [loadMore, hasMore, isLoading]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          handleLoadMore();
        }
      },
      { threshold, rootMargin }
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [handleLoadMore, threshold, rootMargin]);

  return { sentinelRef, isLoading };
}

// Usage in ReviewsList
function ReviewsList({ businessId }: { businessId: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const loadMore = useCallback(async () => {
    const res = await api.get(`/businesses/${businessId}/reviews`, {
      params: { page: page + 1, limit: 10 }
    });
    setReviews((prev) => [...prev, ...res.data.reviews]);
    setHasMore(res.data.hasMore);
    setPage((p) => p + 1);
  }, [businessId, page]);

  const { sentinelRef, isLoading } = useInfiniteScroll(loadMore, hasMore);

  return (
    <div>
      {reviews.map((review) => (
        <ReviewCard key={review.id} review={review} />
      ))}
      <div ref={sentinelRef} className="h-10" />
      {isLoading && <LoadingSpinner />}
    </div>
  );
}
```

---

## 10. Accessibility Features (3-4 minutes)

### Accessible Rating Selector

```tsx
// components/common/AccessibleRating.tsx
import { useId, useRef, useState } from 'react';

interface AccessibleRatingProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
}

export function AccessibleRating({ value, onChange, label }: AccessibleRatingProps) {
  const groupId = useId();
  const [focusedValue, setFocusedValue] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent, currentValue: number) => {
    let newValue = currentValue;

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault();
        newValue = Math.min(currentValue + 1, 5);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault();
        newValue = Math.max(currentValue - 1, 1);
        break;
      case 'Home':
        e.preventDefault();
        newValue = 1;
        break;
      case 'End':
        e.preventDefault();
        newValue = 5;
        break;
      default:
        return;
    }

    onChange(newValue);
    setFocusedValue(newValue);

    // Focus the new radio button
    const radioButton = containerRef.current?.querySelector(
      `input[value="${newValue}"]`
    ) as HTMLInputElement;
    radioButton?.focus();
  };

  return (
    <div ref={containerRef}>
      <span id={`${groupId}-label`} className="block font-medium mb-2">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${groupId}-label`}
        className="flex gap-1"
      >
        {[1, 2, 3, 4, 5].map((starValue) => (
          <label
            key={starValue}
            className={`cursor-pointer p-1 rounded-lg
              ${focusedValue === starValue ? 'ring-2 ring-yelp-red ring-offset-2' : ''}`}
          >
            <input
              type="radio"
              name={groupId}
              value={starValue}
              checked={value === starValue}
              onChange={() => onChange(starValue)}
              onFocus={() => setFocusedValue(starValue)}
              onBlur={() => setFocusedValue(null)}
              onKeyDown={(e) => handleKeyDown(e, starValue)}
              className="sr-only"
              aria-label={`${starValue} star${starValue !== 1 ? 's' : ''}`}
            />
            <StarIcon
              className={`w-8 h-8 transition-colors
                ${starValue <= value ? 'text-yelp-red' : 'text-gray-300'}`}
              aria-hidden="true"
            />
          </label>
        ))}
      </div>
      <div
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        {value > 0 && `${value} star${value !== 1 ? 's' : ''} selected`}
      </div>
    </div>
  );
}
```

---

## 11. Trade-offs and Alternatives (3-4 minutes)

### Component Library

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Custom Tailwind | Full control, smaller bundle | More development time | **Chosen** - Yelp-specific UI |
| Radix UI | Accessible primitives | Additional dependency | Use for complex widgets |
| shadcn/ui | Copy-paste components | May need customization | Good alternative |

### Map Library

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Mapbox GL JS | Vector tiles, clustering, smooth | Paid at scale | **Chosen** - best performance |
| Google Maps | Familiar, comprehensive | Pricing, less customizable | Standard alternative |
| Leaflet | Open source, free | Raster tiles, less smooth | Budget option |

### Form Handling

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| React Hook Form + Zod | Type-safe, performant | Learning curve | **Chosen** - validation needs |
| Formik | Mature, flexible | More boilerplate | Established choice |
| Native forms | No dependencies | Manual validation | Simple forms only |

---

## 12. Future Enhancements (2-3 minutes)

### Short-term
- [ ] Service worker for offline search caching
- [ ] Photo cropping before upload
- [ ] Review draft auto-save to localStorage
- [ ] Dark mode support

### Medium-term
- [ ] PWA with install prompt
- [ ] WebGL map clustering for dense areas
- [ ] Voice search integration
- [ ] AR "view in space" for restaurant interiors

### Long-term
- [ ] Real-time review notifications via WebSocket
- [ ] Collaborative collections ("want to try")
- [ ] Personalized recommendations based on review history
- [ ] Multi-language support with i18n

---

## Summary

The key frontend insights for Yelp's design are:

1. **Autocomplete with debouncing**: 200ms debounce, request cancellation, keyboard navigation with ARIA support

2. **Geolocation integration**: Browser API with graceful fallback, cached results, "near me" functionality

3. **Photo gallery with lightbox**: Grid layout for thumbnails, keyboard navigation, touch gestures, lazy loading

4. **Interactive star rating**: Both display and input modes, half-star support, accessible with keyboard/screen reader

5. **Map-based browsing**: Mapbox GL JS with clustering, custom markers, "search this area" functionality

6. **Form validation**: React Hook Form + Zod for type-safe validation, idempotency keys for retry safety

7. **Performance optimizations**: Image lazy loading with intersection observer, infinite scroll for reviews, responsive images with srcset

This frontend architecture delivers a responsive, accessible search-and-discover experience that works seamlessly across desktop and mobile devices.
