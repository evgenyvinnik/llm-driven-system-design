# Bitly (URL Shortener) - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the frontend architecture for a URL shortening service that:
- Provides instant feedback when shortening URLs
- Displays real-time analytics with interactive charts
- Supports custom short codes with live validation
- Works seamlessly across desktop and mobile devices

## Requirements Clarification

### Functional Requirements
1. **URL Shortener Component**: Input field with instant validation and shortening
2. **Link Management Dashboard**: List, search, filter, and manage user's URLs
3. **Analytics Visualization**: Charts for clicks, referrers, devices, geography
4. **Custom Code Input**: Live availability checking as user types
5. **Admin Dashboard**: System stats, user management, key pool monitoring
6. **Authentication UI**: Login, register, session management

### Non-Functional Requirements
1. **Performance**: < 100ms interaction response, < 3s initial load
2. **Accessibility**: WCAG 2.1 AA compliant
3. **Responsiveness**: Mobile-first design, works on all screen sizes
4. **Offline Support**: Show cached URLs when offline
5. **Bundle Size**: < 200KB gzipped for initial load

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           React Application                              │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Routes    │  │   Stores    │  │    Hooks    │  │   Services  │    │
│  │  (TanStack) │  │  (Zustand)  │  │  (Custom)   │  │  (API/WS)   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      Component Library                          │    │
│  │  URLShortener | URLList | Analytics | AdminDashboard | Auth     │    │
│  └─────────────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      UI Primitives                              │    │
│  │  Button | Input | Modal | Toast | Tooltip | Chart | Table       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: State Management with Zustand

### Auth Store

```typescript
// stores/authStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
    id: string;
    email: string;
    role: 'user' | 'admin';
}

interface AuthState {
    user: User | null;
    isLoading: boolean;
    error: string | null;

    // Actions
    login: (email: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
    checkSession: () => Promise<void>;
    clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
    persist(
        (set, get) => ({
            user: null,
            isLoading: false,
            error: null,

            login: async (email, password) => {
                set({ isLoading: true, error: null });
                try {
                    const response = await api.post('/auth/login', { email, password });
                    set({ user: response.data.user, isLoading: false });
                } catch (error) {
                    set({ error: 'Invalid credentials', isLoading: false });
                    throw error;
                }
            },

            logout: async () => {
                set({ isLoading: true });
                try {
                    await api.post('/auth/logout');
                } finally {
                    set({ user: null, isLoading: false });
                }
            },

            checkSession: async () => {
                set({ isLoading: true });
                try {
                    const response = await api.get('/auth/me');
                    set({ user: response.data.user, isLoading: false });
                } catch {
                    set({ user: null, isLoading: false });
                }
            },

            clearError: () => set({ error: null })
        }),
        {
            name: 'bitly-auth',
            partialize: (state) => ({ user: state.user })
        }
    )
);
```

### URL Store

```typescript
// stores/urlStore.ts
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface ShortenedUrl {
    id: string;
    shortCode: string;
    shortUrl: string;
    longUrl: string;
    clickCount: number;
    isCustom: boolean;
    expiresAt: string | null;
    createdAt: string;
}

interface UrlFilters {
    search: string;
    sortBy: 'createdAt' | 'clickCount';
    sortOrder: 'asc' | 'desc';
}

interface UrlState {
    urls: ShortenedUrl[];
    selectedUrl: ShortenedUrl | null;
    filters: UrlFilters;
    isLoading: boolean;
    isShortening: boolean;
    error: string | null;

    // Optimistic updates
    pendingDeletions: Set<string>;

    // Actions
    fetchUrls: () => Promise<void>;
    shortenUrl: (longUrl: string, options?: ShortenOptions) => Promise<ShortenedUrl>;
    deleteUrl: (shortCode: string) => Promise<void>;
    selectUrl: (url: ShortenedUrl | null) => void;
    setFilters: (filters: Partial<UrlFilters>) => void;
}

interface ShortenOptions {
    customCode?: string;
    expiresAt?: string;
}

export const useUrlStore = create<UrlState>()(
    immer((set, get) => ({
        urls: [],
        selectedUrl: null,
        filters: {
            search: '',
            sortBy: 'createdAt',
            sortOrder: 'desc'
        },
        isLoading: false,
        isShortening: false,
        error: null,
        pendingDeletions: new Set(),

        fetchUrls: async () => {
            set({ isLoading: true, error: null });
            try {
                const response = await api.get('/user/urls');
                set({ urls: response.data, isLoading: false });
            } catch (error) {
                set({ error: 'Failed to load URLs', isLoading: false });
            }
        },

        shortenUrl: async (longUrl, options) => {
            set({ isShortening: true, error: null });
            try {
                const response = await api.post('/shorten', {
                    long_url: longUrl,
                    custom_code: options?.customCode,
                    expires_at: options?.expiresAt
                });

                const newUrl = response.data;

                set((state) => {
                    state.urls.unshift(newUrl);
                    state.isShortening = false;
                });

                return newUrl;
            } catch (error: any) {
                const message = error.response?.data?.error || 'Failed to shorten URL';
                set({ error: message, isShortening: false });
                throw error;
            }
        },

        deleteUrl: async (shortCode) => {
            // Optimistic update
            set((state) => {
                state.pendingDeletions.add(shortCode);
            });

            try {
                await api.delete(`/urls/${shortCode}`);
                set((state) => {
                    state.urls = state.urls.filter(u => u.shortCode !== shortCode);
                    state.pendingDeletions.delete(shortCode);
                });
            } catch (error) {
                // Rollback
                set((state) => {
                    state.pendingDeletions.delete(shortCode);
                    state.error = 'Failed to delete URL';
                });
            }
        },

        selectUrl: (url) => set({ selectedUrl: url }),

        setFilters: (newFilters) => set((state) => {
            state.filters = { ...state.filters, ...newFilters };
        })
    }))
);

// Selector for filtered and sorted URLs
export const useFilteredUrls = () => {
    const { urls, filters, pendingDeletions } = useUrlStore();

    return useMemo(() => {
        let filtered = urls.filter(url =>
            !pendingDeletions.has(url.shortCode) &&
            (url.longUrl.toLowerCase().includes(filters.search.toLowerCase()) ||
             url.shortCode.toLowerCase().includes(filters.search.toLowerCase()))
        );

        filtered.sort((a, b) => {
            const aVal = a[filters.sortBy];
            const bVal = b[filters.sortBy];
            const order = filters.sortOrder === 'asc' ? 1 : -1;

            if (typeof aVal === 'number' && typeof bVal === 'number') {
                return (aVal - bVal) * order;
            }
            return String(aVal).localeCompare(String(bVal)) * order;
        });

        return filtered;
    }, [urls, filters, pendingDeletions]);
};
```

### Analytics Store

```typescript
// stores/analyticsStore.ts
interface AnalyticsData {
    totalClicks: number;
    uniqueVisitors: number;
    clicksByDay: { date: string; count: number }[];
    topReferrers: { referrer: string; count: number }[];
    devices: { mobile: number; desktop: number; tablet: number };
    countries: { code: string; count: number }[];
}

interface AnalyticsState {
    data: AnalyticsData | null;
    dateRange: { start: Date; end: Date };
    isLoading: boolean;
    error: string | null;

    fetchAnalytics: (shortCode: string) => Promise<void>;
    setDateRange: (start: Date, end: Date) => void;
}

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
    data: null,
    dateRange: {
        start: subDays(new Date(), 30),
        end: new Date()
    },
    isLoading: false,
    error: null,

    fetchAnalytics: async (shortCode) => {
        const { dateRange } = get();
        set({ isLoading: true, error: null });

        try {
            const response = await api.get(`/urls/${shortCode}/stats`, {
                params: {
                    start: dateRange.start.toISOString(),
                    end: dateRange.end.toISOString()
                }
            });
            set({ data: response.data, isLoading: false });
        } catch (error) {
            set({ error: 'Failed to load analytics', isLoading: false });
        }
    },

    setDateRange: (start, end) => set({ dateRange: { start, end } })
}));
```

## Deep Dive: URL Shortener Component

### Main Shortener Form

```tsx
// components/URLShortener.tsx
import { useState, useCallback } from 'react';
import { useUrlStore } from '../stores/urlStore';
import { useDebounce } from '../hooks/useDebounce';
import { validateUrl } from '../utils/validation';

export function URLShortener() {
    const [longUrl, setLongUrl] = useState('');
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [customCode, setCustomCode] = useState('');
    const [expiresAt, setExpiresAt] = useState('');
    const [codeAvailable, setCodeAvailable] = useState<boolean | null>(null);
    const [isCheckingCode, setIsCheckingCode] = useState(false);

    const { shortenUrl, isShortening, error } = useUrlStore();
    const [result, setResult] = useState<ShortenedUrl | null>(null);

    const debouncedCustomCode = useDebounce(customCode, 300);

    // Check custom code availability
    useEffect(() => {
        if (!debouncedCustomCode || debouncedCustomCode.length < 4) {
            setCodeAvailable(null);
            return;
        }

        const checkAvailability = async () => {
            setIsCheckingCode(true);
            try {
                const response = await api.get(`/urls/${debouncedCustomCode}/available`);
                setCodeAvailable(response.data.available);
            } catch {
                setCodeAvailable(false);
            } finally {
                setIsCheckingCode(false);
            }
        };

        checkAvailability();
    }, [debouncedCustomCode]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!validateUrl(longUrl)) {
            return;
        }

        try {
            const shortened = await shortenUrl(longUrl, {
                customCode: customCode || undefined,
                expiresAt: expiresAt || undefined
            });
            setResult(shortened);
            setLongUrl('');
            setCustomCode('');
            setExpiresAt('');
        } catch (error) {
            // Error handled by store
        }
    };

    const urlError = longUrl && !validateUrl(longUrl)
        ? 'Please enter a valid URL'
        : null;

    return (
        <div className="max-w-2xl mx-auto">
            <form onSubmit={handleSubmit} className="space-y-4">
                {/* URL Input */}
                <div className="relative">
                    <input
                        type="url"
                        value={longUrl}
                        onChange={(e) => setLongUrl(e.target.value)}
                        placeholder="Paste your long URL here..."
                        className={`
                            w-full px-4 py-3 text-lg border rounded-lg
                            focus:ring-2 focus:ring-orange-500 focus:border-transparent
                            ${urlError ? 'border-red-500' : 'border-gray-300'}
                        `}
                        aria-label="Long URL to shorten"
                        aria-invalid={!!urlError}
                        aria-describedby={urlError ? 'url-error' : undefined}
                    />
                    {urlError && (
                        <p id="url-error" className="mt-1 text-sm text-red-600">
                            {urlError}
                        </p>
                    )}
                </div>

                {/* Advanced Options Toggle */}
                <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="text-sm text-gray-600 hover:text-gray-900 flex items-center gap-1"
                >
                    <ChevronIcon className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                    Advanced options
                </button>

                {/* Advanced Options */}
                {showAdvanced && (
                    <div className="p-4 bg-gray-50 rounded-lg space-y-4">
                        <CustomCodeInput
                            value={customCode}
                            onChange={setCustomCode}
                            isAvailable={codeAvailable}
                            isChecking={isCheckingCode}
                        />

                        <ExpirationPicker
                            value={expiresAt}
                            onChange={setExpiresAt}
                        />
                    </div>
                )}

                {/* Submit Button */}
                <button
                    type="submit"
                    disabled={isShortening || !!urlError || (customCode && codeAvailable === false)}
                    className={`
                        w-full py-3 px-6 text-white font-medium rounded-lg
                        transition-colors
                        ${isShortening ? 'bg-orange-400 cursor-wait' : 'bg-orange-600 hover:bg-orange-700'}
                        disabled:opacity-50 disabled:cursor-not-allowed
                    `}
                >
                    {isShortening ? (
                        <span className="flex items-center justify-center gap-2">
                            <Spinner className="w-5 h-5" />
                            Shortening...
                        </span>
                    ) : (
                        'Shorten URL'
                    )}
                </button>

                {/* Error Display */}
                {error && (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
                        {error}
                    </div>
                )}
            </form>

            {/* Result Display */}
            {result && (
                <ShortenedResult url={result} onDismiss={() => setResult(null)} />
            )}
        </div>
    );
}
```

### Custom Code Input with Live Validation

```tsx
// components/CustomCodeInput.tsx
interface CustomCodeInputProps {
    value: string;
    onChange: (value: string) => void;
    isAvailable: boolean | null;
    isChecking: boolean;
}

export function CustomCodeInput({
    value,
    onChange,
    isAvailable,
    isChecking
}: CustomCodeInputProps) {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        // Only allow alphanumeric, dash, underscore
        const sanitized = e.target.value.replace(/[^a-zA-Z0-9-_]/g, '');
        onChange(sanitized.slice(0, 20));  // Max 20 chars
    };

    const getStatusIcon = () => {
        if (isChecking) {
            return <Spinner className="w-4 h-4 text-gray-400" />;
        }
        if (isAvailable === true) {
            return <CheckIcon className="w-4 h-4 text-green-500" />;
        }
        if (isAvailable === false) {
            return <XIcon className="w-4 h-4 text-red-500" />;
        }
        return null;
    };

    return (
        <div>
            <label htmlFor="custom-code" className="block text-sm font-medium text-gray-700 mb-1">
                Custom short code (optional)
            </label>
            <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
                    bit.ly/
                </span>
                <input
                    id="custom-code"
                    type="text"
                    value={value}
                    onChange={handleChange}
                    placeholder="my-link"
                    className={`
                        w-full pl-16 pr-10 py-2 border rounded-md
                        focus:ring-2 focus:ring-orange-500
                        ${isAvailable === false ? 'border-red-500' : 'border-gray-300'}
                    `}
                    aria-describedby="custom-code-hint"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                    {getStatusIcon()}
                </span>
            </div>
            <p id="custom-code-hint" className="mt-1 text-xs text-gray-500">
                4-20 characters. Letters, numbers, dash, underscore only.
            </p>
            {isAvailable === false && (
                <p className="mt-1 text-sm text-red-600">
                    This code is already taken
                </p>
            )}
        </div>
    );
}
```

### Shortened Result with Copy Animation

```tsx
// components/ShortenedResult.tsx
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ShortenedResultProps {
    url: ShortenedUrl;
    onDismiss: () => void;
}

export function ShortenedResult({ url, onDismiss }: ShortenedResultProps) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(url.shortUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="mt-6 p-6 bg-green-50 border border-green-200 rounded-lg"
        >
            <div className="flex items-center justify-between">
                <div>
                    <p className="text-sm text-green-700 font-medium">Your short URL is ready!</p>
                    <a
                        href={url.shortUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xl font-mono text-green-800 hover:underline"
                    >
                        {url.shortUrl}
                    </a>
                </div>

                <div className="flex items-center gap-2">
                    <button
                        onClick={handleCopy}
                        className={`
                            px-4 py-2 rounded-md font-medium transition-colors
                            ${copied
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-green-700 border border-green-300 hover:bg-green-100'
                            }
                        `}
                    >
                        <AnimatePresence mode="wait">
                            {copied ? (
                                <motion.span
                                    key="copied"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="flex items-center gap-1"
                                >
                                    <CheckIcon className="w-4 h-4" />
                                    Copied!
                                </motion.span>
                            ) : (
                                <motion.span
                                    key="copy"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="flex items-center gap-1"
                                >
                                    <ClipboardIcon className="w-4 h-4" />
                                    Copy
                                </motion.span>
                            )}
                        </AnimatePresence>
                    </button>

                    <button
                        onClick={onDismiss}
                        className="p-2 text-green-600 hover:bg-green-100 rounded-md"
                        aria-label="Dismiss"
                    >
                        <XIcon className="w-5 h-5" />
                    </button>
                </div>
            </div>

            <p className="mt-2 text-sm text-green-600 truncate">
                Redirects to: {url.longUrl}
            </p>
        </motion.div>
    );
}
```

## Deep Dive: URL List Component

### Virtualized URL List with Search

```tsx
// components/URLList.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useFilteredUrls, useUrlStore } from '../stores/urlStore';

export function URLList() {
    const parentRef = useRef<HTMLDivElement>(null);
    const urls = useFilteredUrls();
    const { filters, setFilters, selectUrl, deleteUrl } = useUrlStore();

    const virtualizer = useVirtualizer({
        count: urls.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 80,  // Estimated row height
        overscan: 5
    });

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="flex items-center gap-4 p-4 border-b">
                {/* Search */}
                <div className="relative flex-1">
                    <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                        type="search"
                        value={filters.search}
                        onChange={(e) => setFilters({ search: e.target.value })}
                        placeholder="Search URLs..."
                        className="w-full pl-10 pr-4 py-2 border rounded-lg"
                    />
                </div>

                {/* Sort Controls */}
                <SortDropdown
                    sortBy={filters.sortBy}
                    sortOrder={filters.sortOrder}
                    onChange={(sortBy, sortOrder) => setFilters({ sortBy, sortOrder })}
                />
            </div>

            {/* URL List */}
            {urls.length === 0 ? (
                <EmptyState
                    title="No URLs yet"
                    description="Shorten your first URL to get started"
                    icon={<LinkIcon className="w-12 h-12 text-gray-300" />}
                />
            ) : (
                <div
                    ref={parentRef}
                    className="flex-1 overflow-auto"
                >
                    <div
                        style={{
                            height: `${virtualizer.getTotalSize()}px`,
                            width: '100%',
                            position: 'relative'
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const url = urls[virtualRow.index];
                            return (
                                <div
                                    key={url.id}
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        height: `${virtualRow.size}px`,
                                        transform: `translateY(${virtualRow.start}px)`
                                    }}
                                >
                                    <URLListItem
                                        url={url}
                                        onSelect={() => selectUrl(url)}
                                        onDelete={() => deleteUrl(url.shortCode)}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
```

### URL List Item

```tsx
// components/URLListItem.tsx
interface URLListItemProps {
    url: ShortenedUrl;
    onSelect: () => void;
    onDelete: () => void;
}

export function URLListItem({ url, onSelect, onDelete }: URLListItemProps) {
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const { pendingDeletions } = useUrlStore();
    const isDeleting = pendingDeletions.has(url.shortCode);

    return (
        <div
            className={`
                p-4 border-b hover:bg-gray-50 transition-colors
                ${isDeleting ? 'opacity-50' : ''}
            `}
        >
            <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                    {/* Short URL */}
                    <div className="flex items-center gap-2">
                        <a
                            href={url.shortUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-orange-600 hover:underline"
                        >
                            {url.shortCode}
                        </a>
                        {url.isCustom && (
                            <span className="px-2 py-0.5 text-xs bg-purple-100 text-purple-700 rounded">
                                Custom
                            </span>
                        )}
                        {url.expiresAt && new Date(url.expiresAt) < new Date() && (
                            <span className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded">
                                Expired
                            </span>
                        )}
                    </div>

                    {/* Long URL */}
                    <p className="mt-1 text-sm text-gray-600 truncate" title={url.longUrl}>
                        {url.longUrl}
                    </p>

                    {/* Stats */}
                    <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                            <ClickIcon className="w-3 h-3" />
                            {formatNumber(url.clickCount)} clicks
                        </span>
                        <span className="flex items-center gap-1">
                            <ClockIcon className="w-3 h-3" />
                            {formatRelativeTime(url.createdAt)}
                        </span>
                        {url.expiresAt && (
                            <span className="flex items-center gap-1">
                                <CalendarIcon className="w-3 h-3" />
                                Expires {formatDate(url.expiresAt)}
                            </span>
                        )}
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 ml-4">
                    <button
                        onClick={onSelect}
                        className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                        aria-label="View analytics"
                    >
                        <ChartIcon className="w-5 h-5" />
                    </button>

                    <CopyButton text={url.shortUrl} />

                    {showDeleteConfirm ? (
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => {
                                    onDelete();
                                    setShowDeleteConfirm(false);
                                }}
                                className="p-2 text-red-600 hover:bg-red-50 rounded"
                                aria-label="Confirm delete"
                            >
                                <CheckIcon className="w-5 h-5" />
                            </button>
                            <button
                                onClick={() => setShowDeleteConfirm(false)}
                                className="p-2 text-gray-400 hover:bg-gray-100 rounded"
                                aria-label="Cancel delete"
                            >
                                <XIcon className="w-5 h-5" />
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                            aria-label="Delete URL"
                        >
                            <TrashIcon className="w-5 h-5" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
```

## Deep Dive: Analytics Dashboard

### Analytics Modal

```tsx
// components/AnalyticsModal.tsx
import { useEffect } from 'react';
import { useAnalyticsStore } from '../stores/analyticsStore';

interface AnalyticsModalProps {
    url: ShortenedUrl;
    onClose: () => void;
}

export function AnalyticsModal({ url, onClose }: AnalyticsModalProps) {
    const { data, isLoading, error, fetchAnalytics, dateRange, setDateRange } = useAnalyticsStore();

    useEffect(() => {
        fetchAnalytics(url.shortCode);
    }, [url.shortCode, dateRange]);

    return (
        <Dialog open onOpenChange={onClose}>
            <DialogContent className="max-w-4xl max-h-[90vh] overflow-auto">
                <DialogHeader>
                    <DialogTitle>Analytics for {url.shortCode}</DialogTitle>
                    <DialogDescription>
                        <a href={url.shortUrl} target="_blank" className="text-orange-600 hover:underline">
                            {url.shortUrl}
                        </a>
                    </DialogDescription>
                </DialogHeader>

                {/* Date Range Picker */}
                <DateRangePicker
                    start={dateRange.start}
                    end={dateRange.end}
                    onChange={(start, end) => setDateRange(start, end)}
                />

                {isLoading && <AnalyticsSkeleton />}

                {error && (
                    <div className="p-4 bg-red-50 text-red-700 rounded-lg">
                        {error}
                    </div>
                )}

                {data && (
                    <div className="space-y-6">
                        {/* Summary Cards */}
                        <div className="grid grid-cols-3 gap-4">
                            <StatsCard
                                title="Total Clicks"
                                value={data.totalClicks}
                                icon={<ClickIcon />}
                            />
                            <StatsCard
                                title="Unique Visitors"
                                value={data.uniqueVisitors}
                                icon={<UsersIcon />}
                            />
                            <StatsCard
                                title="Click Rate"
                                value={`${((data.uniqueVisitors / data.totalClicks) * 100).toFixed(1)}%`}
                                icon={<TrendingIcon />}
                            />
                        </div>

                        {/* Clicks Over Time Chart */}
                        <ClicksChart data={data.clicksByDay} />

                        {/* Breakdown Charts */}
                        <div className="grid grid-cols-2 gap-6">
                            <ReferrersChart data={data.topReferrers} />
                            <DevicesChart data={data.devices} />
                        </div>

                        {/* Geography Map */}
                        <GeoChart data={data.countries} />
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
```

### Clicks Over Time Chart

```tsx
// components/ClicksChart.tsx
import { Line } from 'react-chartjs-2';

interface ClicksChartProps {
    data: { date: string; count: number }[];
}

export function ClicksChart({ data }: ClicksChartProps) {
    const chartData = {
        labels: data.map(d => formatDate(d.date)),
        datasets: [{
            label: 'Clicks',
            data: data.map(d => d.count),
            borderColor: 'rgb(234, 88, 12)',  // orange-600
            backgroundColor: 'rgba(234, 88, 12, 0.1)',
            fill: true,
            tension: 0.3
        }]
    };

    const options = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                mode: 'index' as const,
                intersect: false
            }
        },
        scales: {
            y: {
                beginAtZero: true,
                ticks: { precision: 0 }
            }
        }
    };

    return (
        <div className="p-4 bg-white border rounded-lg">
            <h3 className="text-lg font-medium mb-4">Clicks Over Time</h3>
            <div className="h-64">
                <Line data={chartData} options={options} />
            </div>
        </div>
    );
}
```

### Devices Pie Chart

```tsx
// components/DevicesChart.tsx
import { Doughnut } from 'react-chartjs-2';

interface DevicesChartProps {
    data: { mobile: number; desktop: number; tablet: number };
}

export function DevicesChart({ data }: DevicesChartProps) {
    const chartData = {
        labels: ['Mobile', 'Desktop', 'Tablet'],
        datasets: [{
            data: [data.mobile, data.desktop, data.tablet],
            backgroundColor: [
                'rgb(34, 197, 94)',   // green
                'rgb(59, 130, 246)',  // blue
                'rgb(168, 85, 247)'   // purple
            ],
            borderWidth: 0
        }]
    };

    const options = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { position: 'bottom' as const }
        }
    };

    return (
        <div className="p-4 bg-white border rounded-lg">
            <h3 className="text-lg font-medium mb-4">Devices</h3>
            <div className="h-48">
                <Doughnut data={chartData} options={options} />
            </div>
        </div>
    );
}
```

## Deep Dive: Custom Hooks

### useDebounce Hook

```typescript
// hooks/useDebounce.ts
import { useState, useEffect } from 'react';

export function useDebounce<T>(value: T, delay: number): T {
    const [debouncedValue, setDebouncedValue] = useState(value);

    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedValue(value);
        }, delay);

        return () => {
            clearTimeout(handler);
        };
    }, [value, delay]);

    return debouncedValue;
}
```

### useCopyToClipboard Hook

```typescript
// hooks/useCopyToClipboard.ts
import { useState, useCallback } from 'react';

interface UseCopyResult {
    copied: boolean;
    copy: (text: string) => Promise<boolean>;
}

export function useCopyToClipboard(resetDelay = 2000): UseCopyResult {
    const [copied, setCopied] = useState(false);

    const copy = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), resetDelay);
            return true;
        } catch (error) {
            console.error('Failed to copy:', error);
            return false;
        }
    }, [resetDelay]);

    return { copied, copy };
}
```

### useUrlValidation Hook

```typescript
// hooks/useUrlValidation.ts
import { useState, useEffect } from 'react';

interface ValidationResult {
    isValid: boolean;
    error: string | null;
}

export function useUrlValidation(url: string): ValidationResult {
    const [result, setResult] = useState<ValidationResult>({
        isValid: true,
        error: null
    });

    useEffect(() => {
        if (!url) {
            setResult({ isValid: true, error: null });
            return;
        }

        try {
            const parsed = new URL(url);

            if (!['http:', 'https:'].includes(parsed.protocol)) {
                setResult({ isValid: false, error: 'Only HTTP and HTTPS URLs are supported' });
                return;
            }

            if (url.length > 2048) {
                setResult({ isValid: false, error: 'URL is too long (max 2048 characters)' });
                return;
            }

            setResult({ isValid: true, error: null });
        } catch {
            setResult({ isValid: false, error: 'Please enter a valid URL' });
        }
    }, [url]);

    return result;
}
```

## Deep Dive: Accessibility

### Focus Management

```tsx
// components/URLShortener.tsx
export function URLShortener() {
    const inputRef = useRef<HTMLInputElement>(null);
    const resultRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Focus input on mount
        inputRef.current?.focus();
    }, []);

    const handleSuccess = async (url: ShortenedUrl) => {
        setResult(url);
        // Announce to screen readers
        announceToScreenReader(`URL shortened successfully. Your short URL is ${url.shortUrl}`);
        // Move focus to result
        setTimeout(() => resultRef.current?.focus(), 100);
    };

    return (
        <div role="form" aria-labelledby="shortener-title">
            <h2 id="shortener-title" className="sr-only">URL Shortener</h2>
            {/* ... form content ... */}
        </div>
    );
}

// utils/accessibility.ts
export function announceToScreenReader(message: string) {
    const announcement = document.createElement('div');
    announcement.setAttribute('aria-live', 'polite');
    announcement.setAttribute('aria-atomic', 'true');
    announcement.className = 'sr-only';
    announcement.textContent = message;
    document.body.appendChild(announcement);
    setTimeout(() => announcement.remove(), 1000);
}
```

### Keyboard Navigation

```tsx
// components/URLList.tsx
export function URLList() {
    const [focusedIndex, setFocusedIndex] = useState(-1);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setFocusedIndex(prev => Math.min(prev + 1, urls.length - 1));
                break;
            case 'ArrowUp':
                e.preventDefault();
                setFocusedIndex(prev => Math.max(prev - 1, 0));
                break;
            case 'Enter':
                if (focusedIndex >= 0) {
                    selectUrl(urls[focusedIndex]);
                }
                break;
        }
    };

    return (
        <div
            role="listbox"
            aria-label="Your shortened URLs"
            tabIndex={0}
            onKeyDown={handleKeyDown}
        >
            {urls.map((url, index) => (
                <div
                    key={url.id}
                    role="option"
                    aria-selected={focusedIndex === index}
                    tabIndex={focusedIndex === index ? 0 : -1}
                >
                    <URLListItem url={url} />
                </div>
            ))}
        </div>
    );
}
```

## Responsive Design

### Mobile-First Layout

```tsx
// components/Dashboard.tsx
export function Dashboard() {
    return (
        <div className="min-h-screen bg-gray-50">
            {/* Mobile Header */}
            <header className="lg:hidden sticky top-0 z-10 bg-white border-b p-4">
                <MobileHeader />
            </header>

            <div className="flex">
                {/* Desktop Sidebar */}
                <aside className="hidden lg:block w-64 bg-white border-r min-h-screen sticky top-0">
                    <DesktopSidebar />
                </aside>

                {/* Main Content */}
                <main className="flex-1 p-4 lg:p-8">
                    <div className="max-w-4xl mx-auto">
                        <URLShortener />
                        <div className="mt-8">
                            <URLList />
                        </div>
                    </div>
                </main>
            </div>

            {/* Mobile Bottom Navigation */}
            <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-white border-t">
                <MobileNav />
            </nav>
        </div>
    );
}
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Zustand over Redux | Simpler API, less boilerplate | Fewer dev tools |
| Optimistic updates | Instant feedback | Rollback complexity |
| Chart.js | Lightweight, simple API | Less customization than D3 |
| CSS-in-Tailwind | Consistent design system | Class verbosity |
| Virtualized lists | Handles large datasets | Setup complexity |
| Debounced validation | Reduces API calls | Slight delay in feedback |

## Future Frontend Enhancements

1. **Offline Support**: Service worker for cached URL access
2. **QR Code Generation**: Generate and download QR codes for short URLs
3. **Bulk Import**: CSV upload for multiple URLs
4. **Link Previews**: OG image generation for social sharing
5. **Dark Mode**: Theme switching with system preference
6. **Keyboard Shortcuts**: Power user navigation
7. **Export Analytics**: Download CSV/PDF reports
8. **Real-time Updates**: WebSocket for live click counts
