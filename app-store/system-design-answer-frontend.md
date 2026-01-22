# App Store - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the frontend architecture for the App Store, Apple's digital marketplace with 2M+ apps. Key frontend challenges include:
- Building responsive search with instant results and filters
- Displaying app rankings with charts and category navigation
- Creating review interfaces with integrity indicators
- Implementing secure purchase flows with receipt handling
- Designing developer dashboards for app management

## Requirements Clarification

### Functional Requirements
1. **Discovery**: Search apps with filters, browse categories, view charts
2. **App Details**: View app info, screenshots, reviews, ratings
3. **Reviews**: Submit and read reviews, see developer responses
4. **Purchase**: Buy apps with secure checkout flow
5. **Developer Portal**: Manage apps, view analytics, respond to reviews

### Non-Functional Requirements
1. **Performance**: < 100ms time to interactive for search
2. **Responsiveness**: Support iPhone, iPad, Mac, Apple TV
3. **Accessibility**: WCAG 2.1 AA compliance
4. **Offline**: Cache recently viewed apps

### User Personas
- **Consumer**: Browse, search, purchase apps
- **Developer**: Manage apps, respond to reviews, view analytics

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      React Application                          │
├─────────────────────────────────────────────────────────────────┤
│  Routes                                                         │
│  ├── /                    → Home (Charts, Featured)             │
│  ├── /search              → Search Results                      │
│  ├── /category/:id        → Category Browse                     │
│  ├── /app/:id             → App Details                         │
│  ├── /developer           → Developer Dashboard                 │
│  └── /developer/app/:id   → App Management                      │
├─────────────────────────────────────────────────────────────────┤
│  State Management                                               │
│  ├── authStore            → User session, developer status      │
│  ├── catalogStore         → Categories, featured apps           │
│  └── searchStore          → Search query, filters, results      │
├─────────────────────────────────────────────────────────────────┤
│  Services                                                       │
│  ├── api.ts               → HTTP client with interceptors       │
│  └── cdn.ts               → Image/asset URL generation          │
└─────────────────────────────────────────────────────────────────┘
```

## Component Architecture

### Directory Structure

```
frontend/src/
├── components/
│   ├── app/
│   │   ├── AppCard.tsx           # App listing card
│   │   ├── AppDetails.tsx        # Full app page
│   │   ├── ScreenshotGallery.tsx # Screenshot carousel
│   │   └── index.ts
│   ├── reviews/
│   │   ├── ReviewCard.tsx        # Individual review
│   │   ├── ReviewForm.tsx        # Write review
│   │   ├── RatingBreakdown.tsx   # Star distribution
│   │   └── index.ts
│   ├── search/
│   │   ├── SearchBar.tsx         # Search input with suggestions
│   │   ├── SearchFilters.tsx     # Filter sidebar
│   │   ├── SearchResults.tsx     # Results grid
│   │   └── index.ts
│   ├── charts/
│   │   ├── ChartSection.tsx      # Top Free, Paid, Grossing
│   │   ├── ChartRow.tsx          # Horizontal app carousel
│   │   └── index.ts
│   ├── developer/
│   │   ├── DeveloperAppHeader.tsx
│   │   ├── AppDetailsTab.tsx
│   │   ├── AppReviewsTab.tsx
│   │   ├── AppAnalyticsTab.tsx
│   │   └── index.ts
│   └── shared/
│       ├── StarRating.tsx        # Rating display
│       ├── LoadingSpinner.tsx
│       └── ErrorBoundary.tsx
├── routes/
├── stores/
├── services/
└── types/
```

## Deep Dive: Search Experience

### Debounced Search with Suggestions

```tsx
/**
 * @fileoverview Search bar with debounced input and suggestions
 * Provides instant search experience with typo tolerance
 */

import { useState, useCallback, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useDebouncedCallback } from 'use-debounce';
import { api } from '../../services/api';

interface SearchSuggestion {
  type: 'app' | 'developer' | 'category';
  id: string;
  text: string;
  icon?: string;
}

export function SearchBar() {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Debounce API calls to reduce server load
  const fetchSuggestions = useDebouncedCallback(async (q: string) => {
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }

    try {
      const response = await api.get('/search/suggestions', { params: { q } });
      setSuggestions(response.data);
    } catch (error) {
      console.error('Failed to fetch suggestions:', error);
    }
  }, 150);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    setSelectedIndex(-1);
    fetchSuggestions(value);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0) {
          selectSuggestion(suggestions[selectedIndex]);
        } else {
          submitSearch();
        }
        break;
      case 'Escape':
        setIsOpen(false);
        inputRef.current?.blur();
        break;
    }
  };

  const selectSuggestion = (suggestion: SearchSuggestion) => {
    if (suggestion.type === 'app') {
      navigate({ to: '/app/$id', params: { id: suggestion.id } });
    } else if (suggestion.type === 'category') {
      navigate({ to: '/category/$id', params: { id: suggestion.id } });
    }
    setIsOpen(false);
  };

  const submitSearch = () => {
    if (query.trim()) {
      navigate({ to: '/search', search: { q: query } });
      setIsOpen(false);
    }
  };

  return (
    <div className="relative w-full max-w-xl">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setTimeout(() => setIsOpen(false), 200)}
          placeholder="Search apps and games"
          className="w-full pl-10 pr-4 py-2 rounded-full border border-gray-200
                     focus:outline-none focus:ring-2 focus:ring-blue-500
                     bg-gray-50 focus:bg-white transition-colors"
          aria-label="Search apps"
          aria-expanded={isOpen && suggestions.length > 0}
          aria-controls="search-suggestions"
          role="combobox"
        />
      </div>

      {/* Suggestions dropdown */}
      {isOpen && suggestions.length > 0 && (
        <ul
          id="search-suggestions"
          role="listbox"
          className="absolute z-50 w-full mt-2 bg-white rounded-lg shadow-lg
                     border border-gray-200 max-h-80 overflow-auto"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={`${suggestion.type}-${suggestion.id}`}
              role="option"
              aria-selected={selectedIndex === index}
              onClick={() => selectSuggestion(suggestion)}
              className={`px-4 py-3 flex items-center gap-3 cursor-pointer
                ${selectedIndex === index ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
            >
              {suggestion.icon && (
                <img
                  src={suggestion.icon}
                  alt=""
                  className="w-10 h-10 rounded-xl"
                />
              )}
              <div>
                <span className="font-medium">{suggestion.text}</span>
                <span className="text-sm text-gray-500 ml-2 capitalize">
                  {suggestion.type}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

### Search Results with Filters

```tsx
/**
 * @fileoverview Search results page with filter sidebar
 * Supports category, price, and rating filters
 */

import { useSearch, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { AppCard } from '../app/AppCard';
import { SearchFilters } from './SearchFilters';
import { api } from '../../services/api';

interface SearchFilters {
  category?: string;
  price?: 'free' | 'paid';
  rating?: number;
}

export function SearchResults() {
  const { q, ...filters } = useSearch({ from: '/search' });
  const navigate = useNavigate();
  const parentRef = useRef<HTMLDivElement>(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, status } =
    useInfiniteQuery({
      queryKey: ['search', q, filters],
      queryFn: async ({ pageParam = 0 }) => {
        const response = await api.get('/search', {
          params: { q, ...filters, offset: pageParam, limit: 20 },
        });
        return response.data;
      },
      getNextPageParam: (lastPage, pages) =>
        lastPage.hasMore ? pages.length * 20 : undefined,
    });

  const allApps = data?.pages.flatMap(page => page.apps) ?? [];

  // Virtual scrolling for performance
  const virtualizer = useVirtualizer({
    count: hasNextPage ? allApps.length + 1 : allApps.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 5,
  });

  const handleFilterChange = (newFilters: SearchFilters) => {
    navigate({
      to: '/search',
      search: { q, ...newFilters },
    });
  };

  return (
    <div className="flex gap-6 max-w-7xl mx-auto px-4 py-6">
      {/* Filter sidebar */}
      <aside className="w-64 flex-shrink-0">
        <SearchFilters
          filters={filters}
          onChange={handleFilterChange}
        />
      </aside>

      {/* Results */}
      <main className="flex-1">
        <h1 className="text-2xl font-bold mb-4">
          Results for "{q}"
        </h1>

        {status === 'pending' ? (
          <div className="flex justify-center py-12">
            <LoadingSpinner />
          </div>
        ) : status === 'error' ? (
          <div className="text-center py-12 text-red-600">
            Failed to load results. Please try again.
          </div>
        ) : allApps.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No apps found matching your search.
          </div>
        ) : (
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
              {virtualizer.getVirtualItems().map(virtualRow => {
                const isLoaderRow = virtualRow.index >= allApps.length;

                if (isLoaderRow) {
                  return (
                    <div
                      key="loader"
                      className="absolute w-full flex justify-center py-4"
                      style={{
                        top: virtualRow.start,
                        height: virtualRow.size,
                      }}
                    >
                      {hasNextPage && (
                        <button
                          onClick={() => fetchNextPage()}
                          disabled={isFetchingNextPage}
                          className="px-4 py-2 bg-blue-500 text-white rounded-lg"
                        >
                          {isFetchingNextPage ? 'Loading...' : 'Load More'}
                        </button>
                      )}
                    </div>
                  );
                }

                const app = allApps[virtualRow.index];
                return (
                  <div
                    key={app.id}
                    className="absolute w-full"
                    style={{
                      top: virtualRow.start,
                      height: virtualRow.size,
                    }}
                  >
                    <AppCard app={app} layout="horizontal" />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
```

## Deep Dive: App Card Component

```tsx
/**
 * @fileoverview App card component for listings and search results
 * Supports vertical (grid) and horizontal (list) layouts
 */

import { Link } from '@tanstack/react-router';
import { StarRating } from '../shared/StarRating';
import { formatDownloads, formatPrice } from '../../utils/format';

interface App {
  id: string;
  name: string;
  developer: string;
  iconUrl: string;
  averageRating: number;
  ratingCount: number;
  price: number;
  isFree: boolean;
  category: string;
}

interface AppCardProps {
  app: App;
  layout?: 'vertical' | 'horizontal';
  rank?: number;
}

export function AppCard({ app, layout = 'vertical', rank }: AppCardProps) {
  if (layout === 'horizontal') {
    return (
      <Link
        to="/app/$id"
        params={{ id: app.id }}
        className="flex items-center gap-4 p-4 hover:bg-gray-50 rounded-xl
                   transition-colors"
      >
        {rank && (
          <span className="text-2xl font-bold text-gray-300 w-8 text-center">
            {rank}
          </span>
        )}

        <img
          src={app.iconUrl}
          alt=""
          className="w-16 h-16 rounded-2xl shadow-sm"
          loading="lazy"
        />

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 truncate">
            {app.name}
          </h3>
          <p className="text-sm text-gray-500 truncate">
            {app.developer}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <StarRating rating={app.averageRating} size="sm" />
            <span className="text-xs text-gray-400">
              ({formatDownloads(app.ratingCount)})
            </span>
          </div>
        </div>

        <div className="flex-shrink-0">
          <button
            className={`px-4 py-1.5 rounded-full text-sm font-medium
              ${app.isFree
                ? 'bg-gray-100 text-blue-600 hover:bg-gray-200'
                : 'bg-blue-500 text-white hover:bg-blue-600'
              }`}
          >
            {app.isFree ? 'GET' : formatPrice(app.price)}
          </button>
        </div>
      </Link>
    );
  }

  // Vertical layout for grids
  return (
    <Link
      to="/app/$id"
      params={{ id: app.id }}
      className="flex flex-col items-center p-4 hover:bg-gray-50 rounded-xl
                 transition-colors group"
    >
      <img
        src={app.iconUrl}
        alt=""
        className="w-24 h-24 rounded-3xl shadow-lg
                   group-hover:shadow-xl transition-shadow"
        loading="lazy"
      />

      <h3 className="mt-3 font-semibold text-gray-900 text-center truncate w-full">
        {app.name}
      </h3>

      <p className="text-sm text-gray-500 text-center truncate w-full">
        {app.category}
      </p>

      <div className="flex items-center gap-1 mt-2">
        <StarRating rating={app.averageRating} size="xs" />
        <span className="text-xs text-gray-400">
          {app.averageRating.toFixed(1)}
        </span>
      </div>

      <button
        className={`mt-3 px-6 py-1.5 rounded-full text-sm font-medium
          ${app.isFree
            ? 'bg-gray-100 text-blue-600 hover:bg-gray-200'
            : 'bg-blue-500 text-white hover:bg-blue-600'
          }`}
      >
        {app.isFree ? 'GET' : formatPrice(app.price)}
      </button>
    </Link>
  );
}
```

## Deep Dive: Review System

### Review Card with Voting

```tsx
/**
 * @fileoverview Review card with helpful voting and developer response
 */

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { StarRating } from '../shared/StarRating';
import { api } from '../../services/api';

interface Review {
  id: string;
  userName: string;
  rating: number;
  title: string;
  body: string;
  createdAt: string;
  helpfulCount: number;
  userVoted: boolean;
  developerResponse?: {
    text: string;
    respondedAt: string;
  };
}

export function ReviewCard({ review }: { review: Review }) {
  const [helpfulCount, setHelpfulCount] = useState(review.helpfulCount);
  const [userVoted, setUserVoted] = useState(review.userVoted);

  const handleVote = async () => {
    if (userVoted) return;

    try {
      await api.post(`/reviews/${review.id}/helpful`);
      setHelpfulCount(prev => prev + 1);
      setUserVoted(true);
    } catch (error) {
      console.error('Failed to vote:', error);
    }
  };

  return (
    <article className="py-6 border-b border-gray-100 last:border-0">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h4 className="font-semibold text-gray-900">{review.title}</h4>
          <div className="flex items-center gap-2 mt-1">
            <StarRating rating={review.rating} size="sm" />
            <span className="text-sm text-gray-500">
              {review.userName}
            </span>
            <span className="text-sm text-gray-400">
              {formatDistanceToNow(new Date(review.createdAt), { addSuffix: true })}
            </span>
          </div>
        </div>
      </div>

      {/* Body */}
      <p className="mt-3 text-gray-700 leading-relaxed">
        {review.body}
      </p>

      {/* Helpful button */}
      <div className="mt-4 flex items-center gap-4">
        <button
          onClick={handleVote}
          disabled={userVoted}
          className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg
            ${userVoted
              ? 'bg-gray-100 text-gray-400 cursor-default'
              : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
            }`}
        >
          <ThumbUpIcon className="w-4 h-4" />
          {helpfulCount > 0 && <span>{helpfulCount}</span>}
          <span>{userVoted ? 'Helpful' : 'Mark as helpful'}</span>
        </button>
      </div>

      {/* Developer response */}
      {review.developerResponse && (
        <div className="mt-4 ml-4 p-4 bg-blue-50 rounded-lg border-l-4 border-blue-400">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-blue-800">
              Developer Response
            </span>
            <span className="text-xs text-blue-600">
              {formatDistanceToNow(new Date(review.developerResponse.respondedAt), {
                addSuffix: true,
              })}
            </span>
          </div>
          <p className="text-sm text-blue-900">
            {review.developerResponse.text}
          </p>
        </div>
      )}
    </article>
  );
}
```

### Rating Breakdown Chart

```tsx
/**
 * @fileoverview Rating distribution breakdown with bar chart
 */

interface RatingBreakdownProps {
  averageRating: number;
  ratingCount: number;
  distribution: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
  };
}

export function RatingBreakdown({
  averageRating,
  ratingCount,
  distribution,
}: RatingBreakdownProps) {
  const total = Object.values(distribution).reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="flex gap-8 items-center">
      {/* Average rating */}
      <div className="text-center">
        <div className="text-6xl font-bold text-gray-900">
          {averageRating.toFixed(1)}
        </div>
        <StarRating rating={averageRating} size="lg" />
        <div className="text-sm text-gray-500 mt-2">
          {ratingCount.toLocaleString()} Ratings
        </div>
      </div>

      {/* Distribution bars */}
      <div className="flex-1 space-y-2">
        {[5, 4, 3, 2, 1].map(stars => {
          const count = distribution[stars as keyof typeof distribution];
          const percentage = (count / total) * 100;

          return (
            <div key={stars} className="flex items-center gap-2">
              <span className="text-sm text-gray-500 w-4">{stars}</span>
              <StarIcon className="w-4 h-4 text-yellow-400 fill-current" />
              <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-yellow-400 rounded-full transition-all"
                  style={{ width: `${percentage}%` }}
                  role="progressbar"
                  aria-valuenow={percentage}
                  aria-label={`${stars} stars: ${count} reviews`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

## Deep Dive: Developer Dashboard

### App Management Tabs

```tsx
/**
 * @fileoverview Developer app management page with tabbed interface
 */

import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  DeveloperAppHeader,
  AppDetailsTab,
  AppReviewsTab,
  AppAnalyticsTab,
} from '../components/developer';
import { api } from '../services/api';

type TabId = 'details' | 'reviews' | 'analytics';

export function DeveloperAppPage() {
  const { id } = useParams({ from: '/developer/app/$id' });
  const [activeTab, setActiveTab] = useState<TabId>('details');

  const { data: app, isLoading } = useQuery({
    queryKey: ['developer-app', id],
    queryFn: async () => {
      const response = await api.get(`/developer/apps/${id}`);
      return response.data;
    },
  });

  const tabs: { id: TabId; label: string }[] = [
    { id: 'details', label: 'App Details' },
    { id: 'reviews', label: 'Reviews' },
    { id: 'analytics', label: 'Analytics' },
  ];

  if (isLoading) return <LoadingSpinner />;
  if (!app) return <NotFound />;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <DeveloperAppHeader app={app} />

      {/* Tab navigation */}
      <nav className="mt-8 border-b border-gray-200">
        <ul className="flex gap-8" role="tablist">
          {tabs.map(tab => (
            <li key={tab.id}>
              <button
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`panel-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={`py-3 px-1 border-b-2 transition-colors
                  ${activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
              >
                {tab.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Tab panels */}
      <div className="mt-6">
        {activeTab === 'details' && (
          <div id="panel-details" role="tabpanel">
            <AppDetailsTab app={app} />
          </div>
        )}
        {activeTab === 'reviews' && (
          <div id="panel-reviews" role="tabpanel">
            <AppReviewsTab appId={app.id} />
          </div>
        )}
        {activeTab === 'analytics' && (
          <div id="panel-analytics" role="tabpanel">
            <AppAnalyticsTab appId={app.id} />
          </div>
        )}
      </div>
    </div>
  );
}
```

### Analytics Dashboard

```tsx
/**
 * @fileoverview Analytics tab with key metrics and charts
 */

import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../../services/api';

interface AnalyticsData {
  downloads: { date: string; count: number }[];
  revenue: { date: string; amount: number }[];
  ratings: { date: string; average: number }[];
  summary: {
    totalDownloads: number;
    totalRevenue: number;
    averageRating: number;
    conversionRate: number;
  };
}

export function AppAnalyticsTab({ appId }: { appId: string }) {
  const { data, isLoading } = useQuery<AnalyticsData>({
    queryKey: ['app-analytics', appId],
    queryFn: async () => {
      const response = await api.get(`/developer/apps/${appId}/analytics`);
      return response.data;
    },
  });

  if (isLoading) return <LoadingSpinner />;
  if (!data) return null;

  return (
    <div className="space-y-8">
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <MetricCard
          label="Total Downloads"
          value={data.summary.totalDownloads.toLocaleString()}
          trend="+12.5%"
          trendUp={true}
        />
        <MetricCard
          label="Total Revenue"
          value={`$${data.summary.totalRevenue.toLocaleString()}`}
          trend="+8.3%"
          trendUp={true}
        />
        <MetricCard
          label="Average Rating"
          value={data.summary.averageRating.toFixed(1)}
          trend="+0.2"
          trendUp={true}
        />
        <MetricCard
          label="Conversion Rate"
          value={`${data.summary.conversionRate.toFixed(1)}%`}
          trend="-0.5%"
          trendUp={false}
        />
      </div>

      {/* Downloads chart */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-lg font-semibold mb-4">Downloads Over Time</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.downloads}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12 }}
                tickFormatter={date => new Date(date).toLocaleDateString()}
              />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip
                contentStyle={{
                  borderRadius: '8px',
                  border: '1px solid #e5e7eb',
                }}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  trend,
  trendUp,
}: {
  label: string;
  value: string;
  trend: string;
  trendUp: boolean;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      <p
        className={`text-sm mt-2 ${
          trendUp ? 'text-green-600' : 'text-red-600'
        }`}
      >
        {trend} vs last period
      </p>
    </div>
  );
}
```

## Deep Dive: Screenshot Gallery

```tsx
/**
 * @fileoverview Screenshot gallery with lightbox and swipe gestures
 */

import { useState, useCallback } from 'react';
import { useSwipeable } from 'react-swipeable';
import { motion, AnimatePresence } from 'framer-motion';

interface Screenshot {
  id: string;
  url: string;
  caption?: string;
}

export function ScreenshotGallery({ screenshots }: { screenshots: Screenshot[] }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const handlers = useSwipeable({
    onSwipedLeft: () => navigateLightbox(1),
    onSwipedRight: () => navigateLightbox(-1),
    trackMouse: true,
  });

  const navigateLightbox = useCallback((direction: number) => {
    if (lightboxIndex === null) return;
    const newIndex = lightboxIndex + direction;
    if (newIndex >= 0 && newIndex < screenshots.length) {
      setLightboxIndex(newIndex);
    }
  }, [lightboxIndex, screenshots.length]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (lightboxIndex === null) return;
    if (e.key === 'ArrowLeft') navigateLightbox(-1);
    if (e.key === 'ArrowRight') navigateLightbox(1);
    if (e.key === 'Escape') setLightboxIndex(null);
  }, [lightboxIndex, navigateLightbox]);

  return (
    <>
      {/* Thumbnail strip */}
      <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
        {screenshots.map((screenshot, index) => (
          <button
            key={screenshot.id}
            onClick={() => setLightboxIndex(index)}
            className="flex-shrink-0 focus:outline-none focus:ring-2
                       focus:ring-blue-500 rounded-xl"
          >
            <img
              src={screenshot.url}
              alt={screenshot.caption || `Screenshot ${index + 1}`}
              className="h-80 rounded-xl shadow-lg hover:shadow-xl
                         transition-shadow object-cover"
              loading="lazy"
            />
          </button>
        ))}
      </div>

      {/* Lightbox */}
      <AnimatePresence>
        {lightboxIndex !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/90 flex items-center
                       justify-center"
            onClick={() => setLightboxIndex(null)}
            {...handlers}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigateLightbox(-1);
              }}
              disabled={lightboxIndex === 0}
              className="absolute left-4 p-2 text-white/80 hover:text-white
                         disabled:opacity-30"
              aria-label="Previous screenshot"
            >
              <ChevronLeftIcon className="w-8 h-8" />
            </button>

            <motion.img
              key={lightboxIndex}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              src={screenshots[lightboxIndex].url}
              alt={screenshots[lightboxIndex].caption || ''}
              className="max-h-[90vh] max-w-[90vw] rounded-xl"
              onClick={(e) => e.stopPropagation()}
            />

            <button
              onClick={(e) => {
                e.stopPropagation();
                navigateLightbox(1);
              }}
              disabled={lightboxIndex === screenshots.length - 1}
              className="absolute right-4 p-2 text-white/80 hover:text-white
                         disabled:opacity-30"
              aria-label="Next screenshot"
            >
              <ChevronRightIcon className="w-8 h-8" />
            </button>

            <button
              onClick={() => setLightboxIndex(null)}
              className="absolute top-4 right-4 p-2 text-white/80 hover:text-white"
              aria-label="Close lightbox"
            >
              <XIcon className="w-6 h-6" />
            </button>

            {/* Pagination dots */}
            <div className="absolute bottom-8 flex gap-2">
              {screenshots.map((_, index) => (
                <button
                  key={index}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxIndex(index);
                  }}
                  className={`w-2 h-2 rounded-full transition-colors
                    ${index === lightboxIndex ? 'bg-white' : 'bg-white/40'}`}
                  aria-label={`Go to screenshot ${index + 1}`}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
```

## Accessibility Patterns

### Keyboard Navigation

```tsx
// Focus management for modal dialogs
function useModalFocus(isOpen: boolean, modalRef: RefObject<HTMLElement>) {
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousFocus.current = document.activeElement as HTMLElement;
      modalRef.current?.focus();
    } else {
      previousFocus.current?.focus();
    }
  }, [isOpen]);
}

// Roving tabindex for chart navigation
function ChartRow({ apps }: { apps: App[] }) {
  const [focusIndex, setFocusIndex] = useState(0);

  const handleKeyDown = (e: KeyboardEvent, index: number) => {
    if (e.key === 'ArrowRight') {
      setFocusIndex(Math.min(index + 1, apps.length - 1));
    } else if (e.key === 'ArrowLeft') {
      setFocusIndex(Math.max(index - 1, 0));
    }
  };

  return (
    <div role="list" className="flex gap-4 overflow-x-auto">
      {apps.map((app, index) => (
        <AppCard
          key={app.id}
          app={app}
          tabIndex={index === focusIndex ? 0 : -1}
          onKeyDown={(e) => handleKeyDown(e, index)}
        />
      ))}
    </div>
  );
}
```

### Screen Reader Announcements

```tsx
// Live region for search results
function SearchResults({ results, query }: Props) {
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        {results.length} apps found for "{query}"
      </div>

      <ul aria-label="Search results">
        {results.map(app => (
          <li key={app.id}>
            <AppCard app={app} />
          </li>
        ))}
      </ul>
    </>
  );
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Search debounce | 150ms | Instant | Balance responsiveness with server load |
| Result virtualization | @tanstack/react-virtual | Native scroll | Performance with 1000+ results |
| Screenshot gallery | Swipeable lightbox | Modal carousel | Mobile-first, touch-friendly |
| State management | Zustand + TanStack Query | Redux | Simpler, separates server/client state |
| Rating display | Interactive star component | Static SVG | Reusable, accessible |
| Filter persistence | URL search params | Local state | Shareable, back-button works |

## Future Frontend Enhancements

1. **Offline Support**: Service worker for caching recently viewed apps
2. **Skeleton Loading**: Content placeholders during data fetch
3. **Lazy Loading**: Code split routes for faster initial load
4. **Dark Mode**: System preference detection with toggle
5. **Gesture Navigation**: Swipe to go back on mobile
6. **Voice Search**: Web Speech API integration
