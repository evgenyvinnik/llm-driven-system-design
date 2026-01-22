# Online Auction System - Frontend System Design Interview Answer

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing the frontend for an online auction platform similar to eBay. I'll focus on the UI components, real-time bid updates, state management, and ensuring a responsive user experience during high-activity auction periods."

---

## 1. Requirements Clarification (5 minutes)

### Frontend Functional Requirements

1. **Auction Browsing** - Grid/list views with search, filtering, and category navigation
2. **Auction Detail View** - Images, description, current bid, countdown timer, bid history
3. **Bid Placement** - Form with validation, optimistic updates, error handling
4. **Auto-Bid Setup** - Set maximum bid with clear UI explaining proxy bidding
5. **Real-Time Updates** - Live bid updates, countdown timers, sniping extension alerts
6. **Watchlist** - Track favorite auctions with notification indicators
7. **User Dashboard** - My bids, my auctions (seller), won/lost history
8. **Admin Panel** - Auction management, user management, analytics

### Non-Functional Requirements

- **Responsiveness** - Bid form interactions under 100ms perceived latency
- **Real-Time** - Bid updates within 500ms of occurrence
- **Accessibility** - WCAG 2.1 AA compliance, screen reader support for bidding
- **Mobile-First** - Touch-friendly bid controls, responsive layouts

---

## 2. Component Architecture (8 minutes)

### Core Layout Structure

```
App
├── Header
│   ├── Logo
│   ├── SearchBar
│   ├── CategoryNav
│   └── UserMenu (auth state)
├── Main Content (Route-based)
│   ├── AuctionGrid (browse)
│   ├── AuctionDetail (view/bid)
│   ├── CreateAuction (seller)
│   ├── UserDashboard
│   └── AdminPanel
└── Footer
```

### Auction Detail Page Hierarchy

```
AuctionDetailPage
├── ImageGallery
│   ├── MainImage
│   ├── ThumbnailStrip
│   └── ZoomModal
├── AuctionInfo
│   ├── Title
│   ├── SellerInfo
│   ├── Description (expandable)
│   └── CategoryBreadcrumb
├── BidSection
│   ├── CurrentBidDisplay
│   │   ├── BidAmount
│   │   ├── BidderInfo (anonymized)
│   │   └── BidCount
│   ├── CountdownTimer
│   │   └── SnipeExtensionAlert
│   ├── BidForm
│   │   ├── AmountInput
│   │   ├── IncrementButtons (+$1, +$5, +$10)
│   │   ├── SubmitButton
│   │   └── ValidationFeedback
│   └── AutoBidSetup
│       ├── MaxBidInput
│       ├── ExplainerTooltip
│       └── ActivateToggle
├── BidHistory
│   ├── BidList (virtualized)
│   └── LoadMoreButton
└── WatchlistButton
```

---

## 3. Deep Dive: Real-Time Bid Updates (10 minutes)

"Real-time updates are critical for auction UX. Users must see competing bids immediately to make informed decisions."

### WebSocket Connection Management

```typescript
// hooks/useAuctionSocket.ts
import { useEffect, useRef, useCallback } from 'react';
import { useAuctionStore } from '../stores/auctionStore';

interface AuctionMessage {
  type: 'bid_update' | 'auction_extended' | 'auction_ended';
  auctionId: string;
  data: BidUpdate | AuctionExtension | AuctionEnd;
}

export function useAuctionSocket(auctionId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const { updateCurrentBid, extendAuction, markEnded } = useAuctionStore();

  const connect = useCallback(() => {
    const ws = new WebSocket(
      `${import.meta.env.VITE_WS_URL}/auctions/${auctionId}`
    );

    ws.onopen = () => {
      console.log(`Connected to auction ${auctionId}`);
    };

    ws.onmessage = (event) => {
      const message: AuctionMessage = JSON.parse(event.data);

      switch (message.type) {
        case 'bid_update':
          updateCurrentBid(auctionId, message.data as BidUpdate);
          break;
        case 'auction_extended':
          extendAuction(auctionId, message.data as AuctionExtension);
          break;
        case 'auction_ended':
          markEnded(auctionId, message.data as AuctionEnd);
          break;
      }
    };

    ws.onclose = (event) => {
      if (!event.wasClean) {
        // Reconnect with exponential backoff
        reconnectTimeoutRef.current = setTimeout(connect, 2000);
      }
    };

    wsRef.current = ws;
  }, [auctionId, updateCurrentBid, extendAuction, markEnded]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return wsRef.current;
}
```

### Current Bid Display with Animation

```typescript
// components/CurrentBidDisplay.tsx
import { useEffect, useRef, useState } from 'react';
import { formatCurrency } from '../utils/format';

interface CurrentBidDisplayProps {
  amount: number;
  bidderName: string;
  bidCount: number;
  isLeading: boolean;
}

export function CurrentBidDisplay({
  amount,
  bidderName,
  bidCount,
  isLeading,
}: CurrentBidDisplayProps) {
  const [isAnimating, setIsAnimating] = useState(false);
  const prevAmountRef = useRef(amount);

  useEffect(() => {
    if (amount !== prevAmountRef.current) {
      setIsAnimating(true);
      prevAmountRef.current = amount;

      const timer = setTimeout(() => setIsAnimating(false), 600);
      return () => clearTimeout(timer);
    }
  }, [amount]);

  return (
    <div className="bg-white rounded-lg shadow-lg p-6 border-2 border-gray-200">
      <div className="text-sm text-gray-500 uppercase tracking-wide mb-1">
        Current Bid
      </div>

      <div
        className={`text-4xl font-bold transition-all duration-300 ${
          isAnimating
            ? 'text-green-600 scale-110'
            : 'text-gray-900 scale-100'
        }`}
        aria-live="polite"
        aria-atomic="true"
      >
        {formatCurrency(amount)}
      </div>

      <div className="mt-2 text-sm text-gray-600">
        by {bidderName} ({bidCount} bid{bidCount !== 1 ? 's' : ''})
      </div>

      {isLeading && (
        <div className="mt-3 inline-flex items-center px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm">
          <CheckCircleIcon className="w-4 h-4 mr-1" />
          You are the highest bidder
        </div>
      )}
    </div>
  );
}
```

### Countdown Timer with Anti-Sniping

```typescript
// components/CountdownTimer.tsx
import { useEffect, useState, useMemo } from 'react';

interface CountdownTimerProps {
  endTime: Date;
  onTimeUpdate?: (remaining: number) => void;
  onExtension?: (newEndTime: Date) => void;
}

export function CountdownTimer({
  endTime,
  onTimeUpdate,
  onExtension,
}: CountdownTimerProps) {
  const [now, setNow] = useState(Date.now());
  const [wasExtended, setWasExtended] = useState(false);

  // Update every second, switch to 100ms when under 1 minute
  useEffect(() => {
    const remaining = endTime.getTime() - now;
    const interval = remaining < 60000 ? 100 : 1000;

    const timer = setInterval(() => {
      setNow(Date.now());
    }, interval);

    return () => clearInterval(timer);
  }, [endTime, now]);

  // Track extensions
  useEffect(() => {
    onTimeUpdate?.(endTime.getTime() - now);
  }, [now, endTime, onTimeUpdate]);

  const remaining = useMemo(() => {
    const ms = Math.max(0, endTime.getTime() - now);
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    return {
      days,
      hours: hours % 24,
      minutes: minutes % 60,
      seconds: seconds % 60,
      ms: ms % 1000,
      total: ms,
    };
  }, [now, endTime]);

  const isUrgent = remaining.total < 120000; // Under 2 minutes
  const isEnded = remaining.total === 0;

  if (isEnded) {
    return (
      <div className="text-2xl font-bold text-red-600">
        Auction Ended
      </div>
    );
  }

  return (
    <div className={`rounded-lg p-4 ${isUrgent ? 'bg-red-50' : 'bg-gray-50'}`}>
      {wasExtended && (
        <div className="mb-2 text-sm text-orange-600 animate-pulse">
          Auction extended due to last-minute bid
        </div>
      )}

      <div className="text-sm text-gray-500 mb-1">Time Remaining</div>

      <div
        className={`font-mono text-3xl ${
          isUrgent ? 'text-red-600 animate-pulse' : 'text-gray-900'
        }`}
        aria-label={`${remaining.days} days, ${remaining.hours} hours, ${remaining.minutes} minutes, ${remaining.seconds} seconds remaining`}
      >
        {remaining.days > 0 && (
          <span>{remaining.days}d </span>
        )}
        <span>
          {String(remaining.hours).padStart(2, '0')}:
          {String(remaining.minutes).padStart(2, '0')}:
          {String(remaining.seconds).padStart(2, '0')}
        </span>
        {isUrgent && (
          <span className="text-xl">.{String(Math.floor(remaining.ms / 100))}</span>
        )}
      </div>
    </div>
  );
}
```

---

## 4. Deep Dive: Bid Form UX (8 minutes)

"The bid form must be fast, forgiving, and clear about outcomes."

### Bid Form Component

```typescript
// components/BidForm.tsx
import { useState, useCallback, useMemo } from 'react';
import { usePlaceBid } from '../hooks/usePlaceBid';
import { formatCurrency } from '../utils/format';

interface BidFormProps {
  auctionId: string;
  currentBid: number;
  bidIncrement: number;
  isEnded: boolean;
}

export function BidForm({
  auctionId,
  currentBid,
  bidIncrement,
  isEnded,
}: BidFormProps) {
  const minimumBid = currentBid + bidIncrement;
  const [amount, setAmount] = useState(minimumBid);
  const [error, setError] = useState<string | null>(null);

  const { mutate: placeBid, isPending, isSuccess } = usePlaceBid();

  // Update minimum when outbid
  useMemo(() => {
    if (amount < minimumBid) {
      setAmount(minimumBid);
    }
  }, [minimumBid, amount]);

  const handleQuickIncrement = useCallback((increment: number) => {
    setAmount((prev) => {
      const newAmount = Math.max(minimumBid, prev + increment);
      setError(null);
      return newAmount;
    });
  }, [minimumBid]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (amount < minimumBid) {
        setError(`Bid must be at least ${formatCurrency(minimumBid)}`);
        return;
      }

      placeBid(
        { auctionId, amount },
        {
          onError: (err) => {
            setError(err.message || 'Failed to place bid');
          },
        }
      );
    },
    [auctionId, amount, minimumBid, placeBid]
  );

  if (isEnded) {
    return (
      <div className="bg-gray-100 rounded-lg p-6 text-center">
        <div className="text-lg font-semibold text-gray-600">
          Bidding has ended
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="text-sm text-gray-600">
        Minimum bid: {formatCurrency(minimumBid)}
      </div>

      {/* Amount input with quick increments */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
            $
          </span>
          <input
            type="number"
            value={amount}
            onChange={(e) => {
              setAmount(parseFloat(e.target.value) || minimumBid);
              setError(null);
            }}
            min={minimumBid}
            step={0.01}
            className={`w-full pl-8 pr-4 py-3 text-xl font-semibold border-2 rounded-lg
              ${error ? 'border-red-500' : 'border-gray-300'}
              focus:outline-none focus:ring-2 focus:ring-blue-500`}
            aria-label="Bid amount"
            aria-invalid={!!error}
            aria-describedby={error ? 'bid-error' : undefined}
          />
        </div>
      </div>

      {/* Quick increment buttons */}
      <div className="flex gap-2">
        {[1, 5, 10, 25].map((inc) => (
          <button
            key={inc}
            type="button"
            onClick={() => handleQuickIncrement(inc)}
            className="flex-1 py-2 px-3 bg-gray-100 hover:bg-gray-200
                       rounded-lg text-sm font-medium transition-colors"
          >
            +${inc}
          </button>
        ))}
      </div>

      {/* Error message */}
      {error && (
        <div
          id="bid-error"
          className="text-red-600 text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Submit button */}
      <button
        type="submit"
        disabled={isPending || isEnded}
        className={`w-full py-4 text-xl font-bold rounded-lg transition-all
          ${isPending
            ? 'bg-gray-400 cursor-wait'
            : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
      >
        {isPending ? (
          <span className="flex items-center justify-center gap-2">
            <SpinnerIcon className="w-5 h-5 animate-spin" />
            Placing Bid...
          </span>
        ) : (
          `Place Bid: ${formatCurrency(amount)}`
        )}
      </button>

      {/* Success feedback */}
      {isSuccess && (
        <div className="text-green-600 text-center font-medium animate-fadeIn">
          Bid placed successfully
        </div>
      )}
    </form>
  );
}
```

### Optimistic Bid Updates

```typescript
// hooks/usePlaceBid.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { placeBid as placeBidApi } from '../api/auctions';
import { useAuctionStore } from '../stores/auctionStore';
import { v4 as uuidv4 } from 'uuid';

export function usePlaceBid() {
  const queryClient = useQueryClient();
  const { optimisticBid, rollbackBid, confirmBid } = useAuctionStore();

  return useMutation({
    mutationFn: async ({ auctionId, amount }: PlaceBidInput) => {
      const idempotencyKey = uuidv4();
      return placeBidApi(auctionId, amount, idempotencyKey);
    },

    onMutate: async ({ auctionId, amount }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['auction', auctionId] });

      // Snapshot previous value
      const previousAuction = queryClient.getQueryData(['auction', auctionId]);

      // Optimistically update
      optimisticBid(auctionId, amount);

      return { previousAuction };
    },

    onError: (err, { auctionId }, context) => {
      // Rollback on error
      if (context?.previousAuction) {
        rollbackBid(auctionId, context.previousAuction);
      }
    },

    onSuccess: (data, { auctionId }) => {
      // Confirm optimistic update
      confirmBid(auctionId, data);
    },

    onSettled: (_, __, { auctionId }) => {
      // Refetch to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['auction', auctionId] });
    },
  });
}
```

---

## 5. State Management (5 minutes)

### Auction Store with Zustand

```typescript
// stores/auctionStore.ts
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface Auction {
  id: string;
  title: string;
  currentBid: number;
  currentBidderId: string | null;
  bidCount: number;
  endTime: Date;
  status: 'active' | 'ended' | 'sold' | 'unsold';
  isWatching: boolean;
}

interface AuctionState {
  auctions: Record<string, Auction>;
  activeAuctionId: string | null;
  optimisticBids: Record<string, number>;

  // Actions
  setAuction: (auction: Auction) => void;
  updateCurrentBid: (auctionId: string, update: BidUpdate) => void;
  extendAuction: (auctionId: string, extension: AuctionExtension) => void;
  markEnded: (auctionId: string, end: AuctionEnd) => void;
  optimisticBid: (auctionId: string, amount: number) => void;
  rollbackBid: (auctionId: string, previous: Auction) => void;
  confirmBid: (auctionId: string, confirmed: BidResponse) => void;
  toggleWatchlist: (auctionId: string) => void;
}

export const useAuctionStore = create<AuctionState>()(
  immer((set, get) => ({
    auctions: {},
    activeAuctionId: null,
    optimisticBids: {},

    setAuction: (auction) => {
      set((state) => {
        state.auctions[auction.id] = auction;
      });
    },

    updateCurrentBid: (auctionId, update) => {
      set((state) => {
        const auction = state.auctions[auctionId];
        if (auction) {
          auction.currentBid = update.amount;
          auction.currentBidderId = update.bidderId;
          auction.bidCount = update.bidCount;
        }
      });
    },

    extendAuction: (auctionId, extension) => {
      set((state) => {
        const auction = state.auctions[auctionId];
        if (auction) {
          auction.endTime = new Date(extension.newEndTime);
        }
      });
    },

    markEnded: (auctionId, end) => {
      set((state) => {
        const auction = state.auctions[auctionId];
        if (auction) {
          auction.status = end.reserveMet ? 'sold' : 'unsold';
        }
      });
    },

    optimisticBid: (auctionId, amount) => {
      set((state) => {
        state.optimisticBids[auctionId] = amount;
        const auction = state.auctions[auctionId];
        if (auction) {
          auction.currentBid = amount;
          auction.bidCount += 1;
        }
      });
    },

    rollbackBid: (auctionId, previous) => {
      set((state) => {
        delete state.optimisticBids[auctionId];
        state.auctions[auctionId] = previous;
      });
    },

    confirmBid: (auctionId, confirmed) => {
      set((state) => {
        delete state.optimisticBids[auctionId];
        const auction = state.auctions[auctionId];
        if (auction) {
          auction.currentBid = confirmed.finalAmount;
          auction.currentBidderId = confirmed.winnerId;
          auction.bidCount = confirmed.bidCount;
        }
      });
    },

    toggleWatchlist: (auctionId) => {
      set((state) => {
        const auction = state.auctions[auctionId];
        if (auction) {
          auction.isWatching = !auction.isWatching;
        }
      });
    },
  }))
);
```

### User Store for Auth and Preferences

```typescript
// stores/userStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
}

interface UserState {
  user: User | null;
  isAuthenticated: boolean;
  watchlistIds: string[];
  myBidAuctionIds: string[];

  setUser: (user: User) => void;
  clearUser: () => void;
  addToWatchlist: (auctionId: string) => void;
  removeFromWatchlist: (auctionId: string) => void;
  addMyBid: (auctionId: string) => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      watchlistIds: [],
      myBidAuctionIds: [],

      setUser: (user) => set({ user, isAuthenticated: true }),
      clearUser: () => set({ user: null, isAuthenticated: false }),

      addToWatchlist: (auctionId) =>
        set((state) => ({
          watchlistIds: [...new Set([...state.watchlistIds, auctionId])],
        })),

      removeFromWatchlist: (auctionId) =>
        set((state) => ({
          watchlistIds: state.watchlistIds.filter((id) => id !== auctionId),
        })),

      addMyBid: (auctionId) =>
        set((state) => ({
          myBidAuctionIds: [...new Set([...state.myBidAuctionIds, auctionId])],
        })),
    }),
    {
      name: 'auction-user',
      partialize: (state) => ({
        watchlistIds: state.watchlistIds,
      }),
    }
  )
);
```

---

## 6. Auction Grid with Virtualization (5 minutes)

```typescript
// components/AuctionGrid.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useMemo } from 'react';
import { AuctionCard } from './AuctionCard';

interface AuctionGridProps {
  auctions: Auction[];
  columns?: number;
}

export function AuctionGrid({ auctions, columns = 4 }: AuctionGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Group into rows
  const rows = useMemo(() => {
    const result: Auction[][] = [];
    for (let i = 0; i < auctions.length; i += columns) {
      result.push(auctions.slice(i, i + columns));
    }
    return result;
  }, [auctions, columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 360, // Card height + gap
    overscan: 2,
  });

  return (
    <div
      ref={parentRef}
      className="h-[calc(100vh-200px)] overflow-auto"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <div className="grid grid-cols-4 gap-4 px-4">
              {rows[virtualRow.index].map((auction) => (
                <AuctionCard key={auction.id} auction={auction} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### Auction Card Component

```typescript
// components/AuctionCard.tsx
import { Link } from '@tanstack/react-router';
import { formatCurrency } from '../utils/format';
import { useCountdown } from '../hooks/useCountdown';

interface AuctionCardProps {
  auction: Auction;
}

export function AuctionCard({ auction }: AuctionCardProps) {
  const { formatted, isUrgent, isEnded } = useCountdown(auction.endTime);

  return (
    <Link
      to="/auctions/$auctionId"
      params={{ auctionId: auction.id }}
      className="group block bg-white rounded-lg shadow-md overflow-hidden
                 hover:shadow-xl transition-shadow duration-200"
    >
      {/* Image */}
      <div className="relative aspect-square overflow-hidden">
        <img
          src={auction.thumbnailUrl}
          alt={auction.title}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
          loading="lazy"
        />
        {auction.isWatching && (
          <div className="absolute top-2 right-2 p-1.5 bg-white rounded-full shadow">
            <HeartIcon className="w-5 h-5 text-red-500" />
          </div>
        )}
        {isUrgent && !isEnded && (
          <div className="absolute bottom-2 left-2 px-2 py-1 bg-red-600 text-white text-xs font-bold rounded">
            Ending Soon
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4">
        <h3 className="font-semibold text-gray-900 truncate">
          {auction.title}
        </h3>

        <div className="mt-2 flex justify-between items-baseline">
          <div>
            <div className="text-xs text-gray-500 uppercase">Current Bid</div>
            <div className="text-lg font-bold text-gray-900">
              {formatCurrency(auction.currentBid)}
            </div>
          </div>

          <div className="text-right">
            <div className="text-xs text-gray-500">
              {isEnded ? 'Ended' : 'Ends in'}
            </div>
            <div
              className={`text-sm font-medium ${
                isUrgent ? 'text-red-600' : 'text-gray-600'
              }`}
            >
              {formatted}
            </div>
          </div>
        </div>

        <div className="mt-2 text-sm text-gray-500">
          {auction.bidCount} bid{auction.bidCount !== 1 ? 's' : ''}
        </div>
      </div>
    </Link>
  );
}
```

---

## 7. Auto-Bid Setup UI (3 minutes)

```typescript
// components/AutoBidSetup.tsx
import { useState } from 'react';
import { useSetAutoBid } from '../hooks/useSetAutoBid';
import { formatCurrency } from '../utils/format';

interface AutoBidSetupProps {
  auctionId: string;
  currentBid: number;
  bidIncrement: number;
  existingAutoBid?: { maxAmount: number; isActive: boolean };
}

export function AutoBidSetup({
  auctionId,
  currentBid,
  bidIncrement,
  existingAutoBid,
}: AutoBidSetupProps) {
  const [maxAmount, setMaxAmount] = useState(
    existingAutoBid?.maxAmount || currentBid + bidIncrement * 10
  );
  const [isExpanded, setIsExpanded] = useState(!!existingAutoBid);

  const { mutate: setAutoBid, isPending } = useSetAutoBid();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setAutoBid({ auctionId, maxAmount });
  };

  return (
    <div className="border-t pt-4 mt-4">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <span className="font-medium text-gray-900">
          Auto-Bid (Proxy Bidding)
        </span>
        <ChevronIcon
          className={`w-5 h-5 transition-transform ${
            isExpanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {isExpanded && (
        <div className="mt-4 space-y-4">
          {/* Explainer */}
          <div className="bg-blue-50 p-3 rounded-lg text-sm text-blue-800">
            <InfoIcon className="w-4 h-4 inline mr-2" />
            Set your maximum bid. We will automatically bid on your behalf
            (in minimum increments) to keep you as the highest bidder, up to
            your maximum amount.
          </div>

          {existingAutoBid?.isActive && (
            <div className="text-sm text-green-600">
              Active auto-bid: up to {formatCurrency(existingAutoBid.maxAmount)}
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex gap-3">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
                $
              </span>
              <input
                type="number"
                value={maxAmount}
                onChange={(e) => setMaxAmount(parseFloat(e.target.value))}
                min={currentBid + bidIncrement}
                step={0.01}
                className="w-full pl-8 pr-4 py-2 border rounded-lg"
                placeholder="Maximum amount"
              />
            </div>
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
            >
              {isPending ? 'Setting...' : existingAutoBid ? 'Update' : 'Enable'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
```

---

## 8. Image Gallery with Zoom (3 minutes)

```typescript
// components/ImageGallery.tsx
import { useState, useCallback } from 'react';
import { Dialog } from '@headlessui/react';

interface ImageGalleryProps {
  images: AuctionImage[];
}

export function ImageGallery({ images }: ImageGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (e.key === 'ArrowRight') {
      setSelectedIndex((prev) => Math.min(images.length - 1, prev + 1));
    }
  }, [images.length]);

  return (
    <div className="space-y-4" onKeyDown={handleKeyDown} tabIndex={0}>
      {/* Main image */}
      <button
        onClick={() => setIsZoomed(true)}
        className="w-full aspect-square bg-gray-100 rounded-lg overflow-hidden
                   cursor-zoom-in focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <img
          src={images[selectedIndex].url}
          alt={`Image ${selectedIndex + 1} of ${images.length}`}
          className="w-full h-full object-contain"
        />
      </button>

      {/* Thumbnails */}
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto py-2">
          {images.map((image, index) => (
            <button
              key={image.id}
              onClick={() => setSelectedIndex(index)}
              className={`flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden
                ${index === selectedIndex
                  ? 'ring-2 ring-blue-500'
                  : 'opacity-60 hover:opacity-100'
                }`}
            >
              <img
                src={image.thumbnailUrl}
                alt={`Thumbnail ${index + 1}`}
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      {/* Zoom modal */}
      <Dialog open={isZoomed} onClose={() => setIsZoomed(false)}>
        <div className="fixed inset-0 bg-black/90 z-50">
          <Dialog.Panel className="w-full h-full flex items-center justify-center p-4">
            <button
              onClick={() => setIsZoomed(false)}
              className="absolute top-4 right-4 text-white p-2"
              aria-label="Close zoom"
            >
              <XIcon className="w-8 h-8" />
            </button>

            <img
              src={images[selectedIndex].fullUrl}
              alt={`Zoomed image ${selectedIndex + 1}`}
              className="max-w-full max-h-full object-contain"
            />

            {/* Navigation arrows */}
            {selectedIndex > 0 && (
              <button
                onClick={() => setSelectedIndex((prev) => prev - 1)}
                className="absolute left-4 text-white p-2"
                aria-label="Previous image"
              >
                <ChevronLeftIcon className="w-10 h-10" />
              </button>
            )}
            {selectedIndex < images.length - 1 && (
              <button
                onClick={() => setSelectedIndex((prev) => prev + 1)}
                className="absolute right-4 text-white p-2"
                aria-label="Next image"
              >
                <ChevronRightIcon className="w-10 h-10" />
              </button>
            )}
          </Dialog.Panel>
        </div>
      </Dialog>
    </div>
  );
}
```

---

## 9. Trade-offs and Alternatives (3 minutes)

| Decision | Chosen Approach | Trade-off | Alternative |
|----------|----------------|-----------|-------------|
| Real-time updates | WebSocket per auction | Connection overhead for many watchers | Server-Sent Events (simpler, one-way only) |
| Bid submission | Optimistic update + rollback | Brief inconsistent state | Wait for server confirmation (slower UX) |
| Countdown precision | 100ms updates in final minute | Higher CPU usage | 1s always (less precise ending) |
| Image loading | Lazy load thumbnails | Initial layout shift | Eager load all (slower initial paint) |
| State management | Zustand with immer | Additional dependency | Plain React context (less performant) |
| Virtualization | Row-based grid virtual | Complex implementation | Paginated grid (simpler, worse UX) |

---

## 10. Future Enhancements

1. **Push Notifications** - Browser notifications for outbid events when tab is background
2. **Offline Support** - Service worker caching for auction browsing, queue bids when offline
3. **Bid Sound Effects** - Audio feedback for successful bids, outbid alerts
4. **AR Preview** - Camera integration for visualizing items in space
5. **Accessibility Audit** - Full screen reader testing, keyboard navigation improvements
6. **Performance Monitoring** - Real User Monitoring (RUM) for bid latency tracking

---

## Summary

"I've designed the frontend for an online auction platform with:

1. **Real-time WebSocket updates** - Instant bid notifications with reconnection handling
2. **Optimistic bid placement** - Immediate UI feedback with automatic rollback on failure
3. **Dynamic countdown timer** - High-precision timing with anti-sniping extension alerts
4. **Virtualized auction grid** - Efficient rendering for thousands of listings
5. **Zustand state management** - Clean separation of auction and user state
6. **Accessible bid forms** - ARIA labels, keyboard navigation, clear error states

The key insight is treating the bid experience as a real-time competitive interaction. Every millisecond matters during auction endings, so the UI must feel responsive while maintaining correctness through optimistic updates and server reconciliation."
