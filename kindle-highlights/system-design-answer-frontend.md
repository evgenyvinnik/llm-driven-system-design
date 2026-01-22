# Kindle Community Highlights - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design a Kindle Community Highlights system - a social reading platform that enables users to highlight passages in books, sync highlights across devices in real-time, and discover popular highlights from the community.

From a frontend perspective, the key challenges are: building an offline-first experience with local storage and sync queue, creating intuitive highlight interactions in a reading interface, and displaying community data with privacy controls while maintaining a responsive UI across devices."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Highlight Management** - Create, edit, delete highlights with notes and colors
- **Cross-device Sync** - Real-time synchronization across Kindle, iOS, Android, Web
- **Community Discovery** - View popular/trending highlights in any book
- **Social Features** - Follow readers, share highlights, friends-only sharing
- **Export** - Export personal highlights to Markdown, CSV, or PDF

### User Experience Requirements
- **Offline Support** - Full functionality without network connection
- **Instant Feedback** - Optimistic updates for highlight actions
- **Reading Flow** - Non-intrusive highlight creation during reading
- **Discovery** - Easy navigation between personal and community highlights

## High-Level Frontend Architecture (4 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Web Application                              │
├─────────────────────────────────────────────────────────────────┤
│  Routes                                                          │
│  ┌───────────┬───────────┬───────────┬───────────┬───────────┐ │
│  │  Home     │  Library  │  Book     │  Trending │  Export   │ │
│  │  Page     │  Page     │  Detail   │  Page     │  Page     │ │
│  └───────────┴───────────┴───────────┴───────────┴───────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Components                                                      │
│  ┌───────────┬───────────┬───────────┬───────────┬───────────┐ │
│  │  Book     │  Highlight│  Popular  │  Color    │  Export   │ │
│  │  Grid     │  Card     │  Passage  │  Picker   │  Preview  │ │
│  └───────────┴───────────┴───────────┴───────────┴───────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  State Management (Zustand)                                      │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Auth │ Library │ Highlights │ Sync Queue │ UI State     │ │
│  └───────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Services                                                        │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  API Client │ WebSocket Manager │ LocalStorage │ Exporter │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Technology | Purpose |
|------------|---------|
| **React 19** | UI framework with concurrent features |
| **TypeScript** | Type safety and developer experience |
| **Vite** | Fast development server and build tool |
| **TanStack Router** | Type-safe file-based routing |
| **Zustand** | Lightweight state management |
| **Tailwind CSS** | Utility-first styling |

## Deep Dive: Component Architecture (10 minutes)

### Route Structure

```
frontend/src/routes/
├── __root.tsx           # Root layout with navigation
├── index.tsx            # Landing page
├── login.tsx            # User login
├── register.tsx         # User registration
├── library.tsx          # User's book library
├── books.$bookId.tsx    # Book detail with highlights
├── trending.tsx         # Trending highlights
└── export.tsx           # Export functionality
```

### RootLayout Component

```tsx
// routes/__root.tsx
import { Outlet, Link, useNavigate } from '@tanstack/react-router'
import { useStore } from '../stores/useStore'

export function RootLayout() {
  const { user, isAuthenticated, logout } = useStore()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate({ to: '/login' })
  }

  return (
    <div className="min-h-screen bg-kindle-cream">
      <header className="bg-white shadow-sm border-b border-kindle-sepia">
        <nav className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="text-xl font-serif text-gray-800">
            Community Highlights
          </Link>

          <div className="flex items-center gap-6">
            {isAuthenticated ? (
              <>
                <Link
                  to="/library"
                  className="text-gray-600 hover:text-gray-900 transition-colors"
                >
                  My Library
                </Link>
                <Link
                  to="/trending"
                  className="text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Trending
                </Link>
                <Link
                  to="/export"
                  className="text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Export
                </Link>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-500">{user?.email}</span>
                  <button
                    onClick={handleLogout}
                    className="text-sm text-red-600 hover:text-red-700"
                  >
                    Logout
                  </button>
                </div>
              </>
            ) : (
              <>
                <Link to="/login" className="text-gray-600 hover:text-gray-900">
                  Login
                </Link>
                <Link
                  to="/register"
                  className="bg-amber-600 text-white px-4 py-2 rounded-lg
                           hover:bg-amber-700 transition-colors"
                >
                  Get Started
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
```

### Library Page with Book Grid

```tsx
// routes/library.tsx
import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useStore } from '../stores/useStore'
import { getLibrary, getHighlights } from '../api/client'
import { BookCard } from '../components/BookCard'
import { HighlightCard } from '../components/HighlightCard'

export function LibraryPage() {
  const { library, setLibrary, highlights, setHighlights } = useStore()
  const [view, setView] = useState<'books' | 'highlights'>('books')
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadData() {
      const [booksRes, highlightsRes] = await Promise.all([
        getLibrary(),
        getHighlights()
      ])
      setLibrary(booksRes.books)
      setHighlights(highlightsRes.highlights)
      setLoading(false)
    }
    loadData()
  }, [])

  const filteredBooks = library.filter(book =>
    book.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    book.author.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const filteredHighlights = highlights.filter(h =>
    h.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
    h.note?.toLowerCase().includes(searchQuery.toLowerCase())
  )

  if (loading) {
    return <LibraryLoading />
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-serif text-gray-800">My Library</h1>

        <div className="flex items-center gap-4">
          {/* Search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg
                       focus:ring-2 focus:ring-amber-500 focus:border-transparent"
            />
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2
                                 text-gray-400 w-4 h-4" />
          </div>

          {/* View Toggle */}
          <div className="flex bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setView('books')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors
                ${view === 'books'
                  ? 'bg-white shadow text-gray-900'
                  : 'text-gray-600 hover:text-gray-900'
                }`}
            >
              Books ({library.length})
            </button>
            <button
              onClick={() => setView('highlights')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors
                ${view === 'highlights'
                  ? 'bg-white shadow text-gray-900'
                  : 'text-gray-600 hover:text-gray-900'
                }`}
            >
              Highlights ({highlights.length})
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      {view === 'books' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {filteredBooks.map(book => (
            <BookCard key={book.id} book={book} />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredHighlights.map(highlight => (
            <HighlightCard key={highlight.id} highlight={highlight} />
          ))}
        </div>
      )}
    </div>
  )
}
```

### BookCard Component

```tsx
// components/BookCard.tsx
import { Link } from '@tanstack/react-router'
import type { Book } from '../types'

interface BookCardProps {
  book: Book
}

export function BookCard({ book }: BookCardProps) {
  return (
    <Link
      to="/books/$bookId"
      params={{ bookId: book.id }}
      className="group block"
    >
      <div className="relative overflow-hidden rounded-lg shadow-md
                    group-hover:shadow-lg transition-shadow">
        {/* Cover Image */}
        <div className="aspect-[2/3] bg-gradient-to-br from-kindle-sepia to-kindle-cream">
          {book.coverUrl ? (
            <img
              src={book.coverUrl}
              alt={book.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center p-4">
              <span className="text-center font-serif text-gray-600 text-sm">
                {book.title}
              </span>
            </div>
          )}
        </div>

        {/* Highlight Count Badge */}
        <div className="absolute top-2 right-2 bg-amber-500 text-white
                      text-xs font-medium px-2 py-1 rounded-full">
          {book.highlightCount} highlights
        </div>
      </div>

      {/* Book Info */}
      <div className="mt-3">
        <h3 className="font-medium text-gray-900 truncate
                     group-hover:text-amber-700 transition-colors">
          {book.title}
        </h3>
        <p className="text-sm text-gray-500 truncate">{book.author}</p>
      </div>
    </Link>
  )
}
```

### HighlightCard Component

```tsx
// components/HighlightCard.tsx
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useStore } from '../stores/useStore'
import { deleteHighlight, updateHighlight } from '../api/client'
import { ColorPicker } from './ColorPicker'
import { VisibilitySelect } from './VisibilitySelect'
import type { Highlight } from '../types'

interface HighlightCardProps {
  highlight: Highlight
  showBookInfo?: boolean
}

const colorClasses = {
  yellow: 'bg-kindle-yellow/60 border-kindle-yellow',
  orange: 'bg-kindle-orange/60 border-kindle-orange',
  blue: 'bg-kindle-blue/60 border-kindle-blue',
  green: 'bg-kindle-green/60 border-kindle-green',
  pink: 'bg-kindle-pink/60 border-kindle-pink',
}

export function HighlightCard({ highlight, showBookInfo = true }: HighlightCardProps) {
  const { removeHighlight, updateHighlightInStore } = useStore()
  const [isEditing, setIsEditing] = useState(false)
  const [note, setNote] = useState(highlight.note || '')

  const handleDelete = async () => {
    // Optimistic update
    removeHighlight(highlight.id)

    try {
      await deleteHighlight(highlight.id)
    } catch (error) {
      // Revert on failure (would need to re-add)
      console.error('Failed to delete highlight:', error)
    }
  }

  const handleColorChange = async (color: string) => {
    updateHighlightInStore(highlight.id, { color })

    try {
      await updateHighlight(highlight.id, { color })
    } catch (error) {
      // Revert on failure
      updateHighlightInStore(highlight.id, { color: highlight.color })
    }
  }

  const handleSaveNote = async () => {
    updateHighlightInStore(highlight.id, { note })
    setIsEditing(false)

    try {
      await updateHighlight(highlight.id, { note })
    } catch (error) {
      updateHighlightInStore(highlight.id, { note: highlight.note })
    }
  }

  return (
    <div className={`rounded-lg border-l-4 p-4 ${colorClasses[highlight.color]}`}>
      {/* Book info */}
      {showBookInfo && highlight.book && (
        <Link
          to="/books/$bookId"
          params={{ bookId: highlight.bookId }}
          className="text-sm text-gray-600 hover:text-amber-700 mb-2 block"
        >
          {highlight.book.title} by {highlight.book.author}
        </Link>
      )}

      {/* Highlighted text */}
      <blockquote className="text-gray-800 font-serif italic mb-3">
        "{highlight.text}"
      </blockquote>

      {/* Note */}
      {isEditing ? (
        <div className="mb-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note..."
            className="w-full p-2 border border-gray-300 rounded-lg
                     focus:ring-2 focus:ring-amber-500 resize-none"
            rows={3}
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleSaveNote}
              className="text-sm bg-amber-600 text-white px-3 py-1 rounded"
            >
              Save
            </button>
            <button
              onClick={() => setIsEditing(false)}
              className="text-sm text-gray-600 px-3 py-1"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : highlight.note ? (
        <p className="text-sm text-gray-600 mb-3">
          <span className="font-medium">Note:</span> {highlight.note}
        </p>
      ) : null}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ColorPicker
            selected={highlight.color}
            onChange={handleColorChange}
          />
          <VisibilitySelect
            value={highlight.visibility}
            onChange={(v) => updateHighlight(highlight.id, { visibility: v })}
          />
        </div>

        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={() => setIsEditing(true)}
            className="text-gray-500 hover:text-gray-700"
          >
            Edit note
          </button>
          <span className="text-gray-300">|</span>
          <button
            onClick={handleDelete}
            className="text-red-500 hover:text-red-700"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Timestamp */}
      <div className="mt-2 text-xs text-gray-400">
        {formatDate(highlight.createdAt)}
      </div>
    </div>
  )
}
```

### ColorPicker Component

```tsx
// components/ColorPicker.tsx
interface ColorPickerProps {
  selected: string
  onChange: (color: string) => void
}

const colors = [
  { name: 'yellow', class: 'bg-kindle-yellow' },
  { name: 'orange', class: 'bg-kindle-orange' },
  { name: 'blue', class: 'bg-kindle-blue' },
  { name: 'green', class: 'bg-kindle-green' },
  { name: 'pink', class: 'bg-kindle-pink' },
]

export function ColorPicker({ selected, onChange }: ColorPickerProps) {
  return (
    <div className="flex items-center gap-1">
      {colors.map(({ name, class: colorClass }) => (
        <button
          key={name}
          onClick={() => onChange(name)}
          className={`w-5 h-5 rounded-full ${colorClass} border-2 transition-transform
            ${selected === name
              ? 'border-gray-700 scale-110'
              : 'border-transparent hover:scale-105'
            }`}
          aria-label={`Select ${name} highlight color`}
        />
      ))}
    </div>
  )
}
```

## Deep Dive: Book Detail Page (8 minutes)

### Multi-Tab Layout

```tsx
// routes/books.$bookId.tsx
import { useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getBook, getHighlights, getPopularHighlights, getFriendsHighlights } from '../api/client'
import { useStore } from '../stores/useStore'
import { HighlightCard } from '../components/HighlightCard'
import { PopularPassage } from '../components/PopularPassage'
import { TabButton } from '../components/TabButton'

type Tab = 'my' | 'popular' | 'friends'

export function BookDetailPage() {
  const { bookId } = useParams({ from: '/books/$bookId' })
  const { highlights, setHighlights } = useStore()
  const [book, setBook] = useState<Book | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('my')
  const [popularHighlights, setPopularHighlights] = useState<PopularHighlight[]>([])
  const [friendsHighlights, setFriendsHighlights] = useState<Highlight[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadBook() {
      const [bookRes, highlightsRes] = await Promise.all([
        getBook(bookId),
        getHighlights({ bookId })
      ])
      setBook(bookRes)
      setHighlights(highlightsRes.highlights)
      setLoading(false)
    }
    loadBook()
  }, [bookId])

  useEffect(() => {
    async function loadTabData() {
      if (activeTab === 'popular') {
        const res = await getPopularHighlights(bookId)
        setPopularHighlights(res.highlights)
      } else if (activeTab === 'friends') {
        const res = await getFriendsHighlights(bookId)
        setFriendsHighlights(res.highlights)
      }
    }
    loadTabData()
  }, [activeTab, bookId])

  const myHighlights = highlights.filter(h => h.bookId === bookId)

  if (loading || !book) {
    return <BookDetailLoading />
  }

  return (
    <div className="space-y-6">
      {/* Book Header */}
      <div className="flex items-start gap-6">
        <div className="w-32 aspect-[2/3] bg-kindle-sepia rounded-lg shadow overflow-hidden">
          {book.coverUrl && (
            <img src={book.coverUrl} alt={book.title} className="w-full h-full object-cover" />
          )}
        </div>

        <div className="flex-1">
          <h1 className="text-2xl font-serif text-gray-800">{book.title}</h1>
          <p className="text-gray-600">by {book.author}</p>

          <div className="flex items-center gap-4 mt-4 text-sm text-gray-500">
            <span>{myHighlights.length} highlights</span>
            <span>{book.totalLocations} locations</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <div className="flex gap-6">
          <TabButton
            active={activeTab === 'my'}
            onClick={() => setActiveTab('my')}
          >
            My Highlights ({myHighlights.length})
          </TabButton>
          <TabButton
            active={activeTab === 'popular'}
            onClick={() => setActiveTab('popular')}
          >
            Popular Highlights
          </TabButton>
          <TabButton
            active={activeTab === 'friends'}
            onClick={() => setActiveTab('friends')}
          >
            Friends' Highlights
          </TabButton>
        </div>
      </div>

      {/* Tab Content */}
      <div className="min-h-[400px]">
        {activeTab === 'my' && (
          <div className="space-y-4">
            {myHighlights.length > 0 ? (
              myHighlights.map(h => (
                <HighlightCard key={h.id} highlight={h} showBookInfo={false} />
              ))
            ) : (
              <EmptyState
                title="No highlights yet"
                description="Start reading and highlight passages you want to remember."
              />
            )}
          </div>
        )}

        {activeTab === 'popular' && (
          <div className="space-y-4">
            {popularHighlights.map((passage, idx) => (
              <PopularPassage key={idx} passage={passage} rank={idx + 1} />
            ))}
          </div>
        )}

        {activeTab === 'friends' && (
          <div className="space-y-4">
            {friendsHighlights.length > 0 ? (
              friendsHighlights.map(h => (
                <FriendHighlightCard key={h.id} highlight={h} />
              ))
            ) : (
              <EmptyState
                title="No friends' highlights"
                description="Follow other readers to see their highlights here."
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
```

### PopularPassage Component

```tsx
// components/PopularPassage.tsx
interface PopularPassageProps {
  passage: {
    text: string
    count: number
    location: { start: number; end: number }
  }
  rank: number
}

export function PopularPassage({ passage, rank }: PopularPassageProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
      <div className="flex items-start gap-4">
        {/* Rank Badge */}
        <div className="flex-shrink-0 w-8 h-8 bg-amber-100 rounded-full
                      flex items-center justify-center">
          <span className="text-amber-700 font-bold text-sm">#{rank}</span>
        </div>

        <div className="flex-1">
          {/* Passage text */}
          <blockquote className="text-gray-800 font-serif italic text-lg mb-3">
            "{passage.text}"
          </blockquote>

          {/* Stats */}
          <div className="flex items-center gap-4 text-sm text-gray-500">
            <span className="flex items-center gap-1">
              <UsersIcon className="w-4 h-4" />
              {passage.count.toLocaleString()} readers highlighted this
            </span>
            <span>
              Location {passage.location.start}-{passage.location.end}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
```

## Deep Dive: State Management (6 minutes)

### Zustand Store

```typescript
// stores/useStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

interface User {
  id: string
  email: string
  username: string
}

interface Book {
  id: string
  title: string
  author: string
  coverUrl?: string
  highlightCount: number
}

interface Highlight {
  id: string
  bookId: string
  text: string
  note?: string
  color: string
  visibility: 'private' | 'friends' | 'public'
  locationStart: number
  locationEnd: number
  createdAt: string
  book?: Book
}

interface SyncQueueItem {
  id: string
  type: 'create' | 'update' | 'delete'
  highlightId: string
  data?: Partial<Highlight>
  createdAt: number
}

interface AppState {
  // Authentication
  user: User | null
  sessionId: string | null
  isAuthenticated: boolean
  setUser: (user: User | null) => void
  setSession: (sessionId: string | null) => void
  logout: () => void

  // Library
  library: Book[]
  setLibrary: (books: Book[]) => void

  // Highlights
  highlights: Highlight[]
  setHighlights: (highlights: Highlight[]) => void
  addHighlight: (highlight: Highlight) => void
  removeHighlight: (id: string) => void
  updateHighlightInStore: (id: string, updates: Partial<Highlight>) => void

  // Sync Queue (offline support)
  syncQueue: SyncQueueItem[]
  addToSyncQueue: (item: Omit<SyncQueueItem, 'id' | 'createdAt'>) => void
  removeFromSyncQueue: (id: string) => void
  clearSyncQueue: () => void

  // UI State
  searchQuery: string
  setSearchQuery: (query: string) => void
  selectedBookId: string | null
  setSelectedBookId: (id: string | null) => void
}

export const useStore = create<AppState>()(
  persist(
    immer((set) => ({
      // Authentication
      user: null,
      sessionId: null,
      isAuthenticated: false,

      setUser: (user) => set((state) => {
        state.user = user
        state.isAuthenticated = !!user
      }),

      setSession: (sessionId) => set((state) => {
        state.sessionId = sessionId
      }),

      logout: () => set((state) => {
        state.user = null
        state.sessionId = null
        state.isAuthenticated = false
        state.library = []
        state.highlights = []
      }),

      // Library
      library: [],
      setLibrary: (books) => set((state) => {
        state.library = books
      }),

      // Highlights
      highlights: [],

      setHighlights: (highlights) => set((state) => {
        state.highlights = highlights
      }),

      addHighlight: (highlight) => set((state) => {
        state.highlights.unshift(highlight)
      }),

      removeHighlight: (id) => set((state) => {
        state.highlights = state.highlights.filter(h => h.id !== id)
      }),

      updateHighlightInStore: (id, updates) => set((state) => {
        const index = state.highlights.findIndex(h => h.id === id)
        if (index !== -1) {
          state.highlights[index] = { ...state.highlights[index], ...updates }
        }
      }),

      // Sync Queue
      syncQueue: [],

      addToSyncQueue: (item) => set((state) => {
        state.syncQueue.push({
          ...item,
          id: crypto.randomUUID(),
          createdAt: Date.now()
        })
      }),

      removeFromSyncQueue: (id) => set((state) => {
        state.syncQueue = state.syncQueue.filter(item => item.id !== id)
      }),

      clearSyncQueue: () => set((state) => {
        state.syncQueue = []
      }),

      // UI State
      searchQuery: '',
      setSearchQuery: (query) => set((state) => {
        state.searchQuery = query
      }),

      selectedBookId: null,
      setSelectedBookId: (id) => set((state) => {
        state.selectedBookId = id
      }),
    })),
    {
      name: 'kindle-highlights-storage',
      partialize: (state) => ({
        user: state.user,
        sessionId: state.sessionId,
        isAuthenticated: state.isAuthenticated,
        syncQueue: state.syncQueue,
      }),
    }
  )
)
```

## Deep Dive: WebSocket Sync (5 minutes)

### useWebSocket Hook

```typescript
// hooks/useWebSocket.ts
import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '../stores/useStore'

interface SyncEvent {
  type: 'highlight_sync' | 'sync_batch' | 'sync_response'
  event?: {
    action: 'create' | 'update' | 'delete'
    highlight: Highlight
  }
  highlights?: Highlight[]
  deleted?: string[]
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number>()
  const { sessionId, addHighlight, removeHighlight, updateHighlightInStore, syncQueue, removeFromSyncQueue } = useStore()

  const connect = useCallback(() => {
    if (!sessionId) return

    const ws = new WebSocket(`ws://localhost:3002?session=${sessionId}`)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('WebSocket connected')

      // Request sync from last known timestamp
      const lastSync = localStorage.getItem('lastSyncTimestamp') || '0'
      ws.send(JSON.stringify({
        type: 'sync_request',
        lastSyncTimestamp: parseInt(lastSync)
      }))

      // Process offline queue
      processSyncQueue()
    }

    ws.onmessage = (event) => {
      const data: SyncEvent = JSON.parse(event.data)
      handleSyncEvent(data)
    }

    ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...')
      reconnectTimeoutRef.current = window.setTimeout(connect, 3000)
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
    }
  }, [sessionId])

  const handleSyncEvent = (data: SyncEvent) => {
    switch (data.type) {
      case 'highlight_sync':
        if (data.event) {
          const { action, highlight } = data.event
          if (action === 'create') {
            addHighlight(highlight)
          } else if (action === 'update') {
            updateHighlightInStore(highlight.id, highlight)
          } else if (action === 'delete') {
            removeHighlight(highlight.id)
          }
        }
        break

      case 'sync_response':
        // Merge server state with local
        if (data.highlights) {
          data.highlights.forEach(h => {
            updateHighlightInStore(h.id, h)
          })
        }
        if (data.deleted) {
          data.deleted.forEach(id => removeHighlight(id))
        }
        // Update last sync timestamp
        localStorage.setItem('lastSyncTimestamp', Date.now().toString())
        break
    }
  }

  const processSyncQueue = async () => {
    for (const item of syncQueue) {
      try {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: `highlight_${item.type}`,
            highlightId: item.highlightId,
            data: item.data
          }))
          removeFromSyncQueue(item.id)
        }
      } catch (error) {
        console.error('Failed to process sync queue item:', error)
        break
      }
    }
  }

  const sendHighlightEvent = useCallback((type: string, data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, ...data }))
    }
  }, [])

  useEffect(() => {
    connect()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect])

  return { sendHighlightEvent }
}
```

## Deep Dive: Export Page (4 minutes)

### Export Functionality

```tsx
// routes/export.tsx
import { useState } from 'react'
import { exportHighlights } from '../api/client'
import { FormatOption } from '../components/FormatOption'

type ExportFormat = 'markdown' | 'csv' | 'json'

export function ExportPage() {
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [includeNotes, setIncludeNotes] = useState(true)
  const [includeDates, setIncludeDates] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)

  const handleExport = async () => {
    setExporting(true)
    try {
      const result = await exportHighlights({
        format,
        includeNotes,
        includeDates
      })

      // Trigger download
      const blob = new Blob([result.content], {
        type: format === 'json' ? 'application/json' : 'text/plain'
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `highlights.${format === 'markdown' ? 'md' : format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Export failed:', error)
    } finally {
      setExporting(false)
    }
  }

  const handlePreview = async () => {
    const result = await exportHighlights({
      format,
      includeNotes,
      includeDates,
      preview: true
    })
    setPreview(result.content)
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <h1 className="text-2xl font-serif text-gray-800">Export Highlights</h1>

      {/* Format Selection */}
      <div>
        <h2 className="text-lg font-medium text-gray-700 mb-4">Choose Format</h2>
        <div className="grid grid-cols-3 gap-4">
          <FormatOption
            format="markdown"
            icon={<MarkdownIcon />}
            label="Markdown"
            description="Great for note-taking apps"
            selected={format === 'markdown'}
            onSelect={setFormat}
          />
          <FormatOption
            format="csv"
            icon={<TableIcon />}
            label="CSV"
            description="For spreadsheets"
            selected={format === 'csv'}
            onSelect={setFormat}
          />
          <FormatOption
            format="json"
            icon={<CodeIcon />}
            label="JSON"
            description="For developers"
            selected={format === 'json'}
            onSelect={setFormat}
          />
        </div>
      </div>

      {/* Options */}
      <div className="space-y-4">
        <h2 className="text-lg font-medium text-gray-700">Options</h2>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={includeNotes}
            onChange={(e) => setIncludeNotes(e.target.checked)}
            className="w-4 h-4 text-amber-600 rounded focus:ring-amber-500"
          />
          <span className="text-gray-700">Include notes</span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={includeDates}
            onChange={(e) => setIncludeDates(e.target.checked)}
            className="w-4 h-4 text-amber-600 rounded focus:ring-amber-500"
          />
          <span className="text-gray-700">Include dates</span>
        </label>
      </div>

      {/* Actions */}
      <div className="flex gap-4">
        <button
          onClick={handlePreview}
          className="px-6 py-2 border border-gray-300 rounded-lg
                   text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Preview
        </button>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="px-6 py-2 bg-amber-600 text-white rounded-lg
                   hover:bg-amber-700 transition-colors disabled:opacity-50"
        >
          {exporting ? 'Exporting...' : 'Download'}
        </button>
      </div>

      {/* Preview */}
      {preview && (
        <div className="mt-8">
          <h2 className="text-lg font-medium text-gray-700 mb-4">Preview</h2>
          <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto
                        text-sm font-mono max-h-96">
            {preview}
          </pre>
        </div>
      )}
    </div>
  )
}
```

## Tailwind Configuration (2 minutes)

```javascript
// tailwind.config.js
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        kindle: {
          cream: '#faf8f5',
          sepia: '#f4ecd8',
          yellow: '#fff59d',
          orange: '#ffab91',
          blue: '#90caf9',
          green: '#a5d6a7',
          pink: '#f48fb1',
        },
      },
      fontFamily: {
        serif: ['Georgia', 'Cambria', 'serif'],
      },
    },
  },
}
```

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| State Management | Zustand | Redux Toolkit | Simpler API, less boilerplate |
| Routing | TanStack Router | React Router | Type-safe params and search |
| Offline Storage | localStorage + Zustand persist | IndexedDB | Simpler for highlight data |
| Styling | Tailwind CSS | CSS Modules | Faster iteration, consistent design |
| Sync | WebSocket | Polling | Real-time updates, lower latency |

## Closing Summary (1 minute)

"The Kindle Community Highlights frontend is built around three pillars:

1. **Offline-first design** using Zustand with persistence and a sync queue for operations made without connectivity
2. **Component composition** with reusable HighlightCard, ColorPicker, and TabButton components that maintain consistent UX
3. **Real-time sync** via WebSocket with automatic reconnection and conflict merging

Key patterns include optimistic updates for instant feedback, multi-tab navigation for switching between personal/popular/friends highlights, and a clean export flow with format preview. The Kindle-inspired color palette and serif typography create a reading-focused aesthetic."
