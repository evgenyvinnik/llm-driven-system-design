# Kindle Community Highlights - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Opening Statement (1 minute)

"I'll design a Kindle Community Highlights system - a social reading platform that enables users to highlight passages in books, sync highlights across devices in real-time, and discover popular highlights from the community.

As a fullstack engineer, I'll focus on the end-to-end data flow from user interactions through WebSocket sync to aggregation pipelines, emphasizing the integration points between frontend components and backend services, shared type contracts, and the complete lifecycle of a highlight from creation to community discovery."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Highlight Management** - Create, edit, delete highlights with notes and colors
- **Cross-device Sync** - Real-time synchronization across Kindle, iOS, Android, Web
- **Community Discovery** - View popular/trending highlights in any book
- **Social Features** - Follow readers, share highlights, friends-only sharing
- **Export** - Export personal highlights to Markdown, CSV, or PDF

### Non-Functional Requirements
- **Sync Latency** - < 2 seconds cross-device propagation
- **Scale** - 10M users, 1B highlights, 100K highlight views/second
- **Availability** - 99.9% uptime
- **Privacy** - Community highlights are anonymized, opt-out available

## High-Level Architecture (4 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Web Application                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Library   │  │   Book      │  │   Export    │             │
│  │   Page      │  │   Detail    │  │   Page      │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│  ┌──────▼────────────────▼────────────────▼──────┐             │
│  │              Zustand Store                     │             │
│  │   (user, library, highlights, syncQueue)      │             │
│  └──────────────────────┬────────────────────────┘             │
│                         │                                       │
│  ┌──────────────────────▼────────────────────────┐             │
│  │        API Client / WebSocket Manager          │             │
│  └──────────────────────┬────────────────────────┘             │
└─────────────────────────┼───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     API Gateway                                  │
│              (Authentication, Rate Limiting)                     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│  Sync Service │ │  Highlight    │ │  Aggregation  │
│  (WebSocket)  │ │  Service      │ │  Service      │
└───────────────┘ └───────────────┘ └───────────────┘
         │                │                │
         └────────────────┼────────────────┘
                          │
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│  PostgreSQL   │ │    Redis      │ │ Elasticsearch │
└───────────────┘ └───────────────┘ └───────────────┘
```

## Deep Dive: Shared Type Contracts (5 minutes)

### Core Types

```typescript
// shared/types.ts - Used by both frontend and backend

export interface User {
  id: string
  email: string
  username: string
  avatarUrl?: string
  createdAt: string
}

export interface Book {
  id: string
  title: string
  author: string
  isbn?: string
  coverUrl?: string
  totalLocations: number
  highlightCount?: number
}

export interface Highlight {
  id: string
  userId: string
  bookId: string
  locationStart: number
  locationEnd: number
  text: string
  note?: string
  color: HighlightColor
  visibility: Visibility
  fingerprint?: string
  createdAt: string
  updatedAt: string
  book?: Book
}

export type HighlightColor = 'yellow' | 'orange' | 'blue' | 'green' | 'pink'
export type Visibility = 'private' | 'friends' | 'public'

export interface PopularHighlight {
  fingerprint: string
  text: string
  count: number
  location: {
    start: number
    end: number
  }
}

// WebSocket message types
export type SyncMessageType =
  | 'sync_request'
  | 'sync_response'
  | 'highlight_create'
  | 'highlight_update'
  | 'highlight_delete'
  | 'highlight_sync'

export interface SyncMessage {
  type: SyncMessageType
  timestamp?: number
}

export interface SyncRequest extends SyncMessage {
  type: 'sync_request'
  lastSyncTimestamp: number
}

export interface SyncResponse extends SyncMessage {
  type: 'sync_response'
  highlights: Highlight[]
  deleted: string[]
  serverTime: number
}

export interface HighlightCreateMessage extends SyncMessage {
  type: 'highlight_create'
  highlight: Omit<Highlight, 'id' | 'createdAt' | 'updatedAt'>
  idempotencyKey: string
}

export interface HighlightSyncMessage extends SyncMessage {
  type: 'highlight_sync'
  event: {
    action: 'create' | 'update' | 'delete'
    highlight: Highlight
  }
}

// API Response types
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}
```

## Deep Dive: Highlight Creation Flow (10 minutes)

### End-to-End Lifecycle

```
User selects text → Create Highlight → Optimistic Update → WebSocket Send →
Backend Validation → Database Insert → Aggregation Update →
Broadcast to Devices → Confirm to Original Client
```

### Frontend: Highlight Creation

```tsx
// components/TextSelection.tsx
import { useCallback, useState } from 'react'
import { useStore } from '../stores/useStore'
import { useWebSocket } from '../hooks/useWebSocket'
import { ColorPicker } from './ColorPicker'
import type { Highlight, HighlightColor } from '../types'

interface TextSelectionProps {
  bookId: string
  onHighlightCreated?: (highlight: Highlight) => void
}

export function TextSelection({ bookId, onHighlightCreated }: TextSelectionProps) {
  const { addHighlight, addToSyncQueue } = useStore()
  const { sendHighlightEvent, isConnected } = useWebSocket()
  const [selectionPopup, setSelectionPopup] = useState<{
    x: number
    y: number
    text: string
    range: Range
  } | null>(null)

  const handleTextSelection = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      setSelectionPopup(null)
      return
    }

    const text = selection.toString().trim()
    if (text.length < 3) return

    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()

    setSelectionPopup({
      x: rect.left + rect.width / 2,
      y: rect.top - 10,
      text,
      range
    })
  }, [])

  const createHighlight = async (color: HighlightColor) => {
    if (!selectionPopup) return

    // Generate temporary ID and idempotency key
    const tempId = `temp-${crypto.randomUUID()}`
    const idempotencyKey = crypto.randomUUID()

    // Calculate location from selection
    const locationStart = getLocationFromRange(selectionPopup.range, 'start')
    const locationEnd = getLocationFromRange(selectionPopup.range, 'end')

    // Create optimistic highlight
    const optimisticHighlight: Highlight = {
      id: tempId,
      userId: '', // Will be set by server
      bookId,
      locationStart,
      locationEnd,
      text: selectionPopup.text,
      color,
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    // Optimistic update
    addHighlight(optimisticHighlight)
    setSelectionPopup(null)
    window.getSelection()?.removeAllRanges()

    // Send via WebSocket or queue for later
    const message: HighlightCreateMessage = {
      type: 'highlight_create',
      highlight: {
        bookId,
        locationStart,
        locationEnd,
        text: selectionPopup.text,
        color,
        visibility: 'private'
      },
      idempotencyKey
    }

    if (isConnected) {
      sendHighlightEvent('highlight_create', message)
    } else {
      // Queue for later sync
      addToSyncQueue({
        type: 'create',
        highlightId: tempId,
        data: message
      })
    }

    onHighlightCreated?.(optimisticHighlight)
  }

  return (
    <div onMouseUp={handleTextSelection}>
      {/* Reading content */}
      {selectionPopup && (
        <div
          className="fixed z-50 bg-white rounded-lg shadow-lg p-2 flex gap-1"
          style={{
            left: selectionPopup.x,
            top: selectionPopup.y,
            transform: 'translate(-50%, -100%)'
          }}
        >
          <ColorPicker onSelect={createHighlight} />
        </div>
      )}
    </div>
  )
}
```

### Backend: Highlight Service

```typescript
// backend/src/highlight/app.ts
import express from 'express'
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'
import { authMiddleware } from '../shared/auth.js'
import { syncService } from '../sync/service.js'
import { aggregationService } from '../aggregation/service.js'
import type { Highlight, ApiResponse } from '../types.js'

const app = express()

app.post('/api/highlights', authMiddleware, async (req, res) => {
  const userId = req.user!.id
  const { bookId, locationStart, locationEnd, text, note, color, visibility } = req.body
  const idempotencyKey = req.headers['x-idempotency-key'] as string

  try {
    // Check idempotency
    const existing = await redis.get(`idempotency:${idempotencyKey}`)
    if (existing) {
      return res.json(JSON.parse(existing))
    }

    // Generate fingerprint for aggregation
    const fingerprint = generateFingerprint(bookId, text)

    // Insert highlight
    const result = await pool.query(`
      INSERT INTO highlights
        (id, user_id, book_id, location_start, location_end,
         highlighted_text, fingerprint, note, color, visibility)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [userId, bookId, locationStart, locationEnd, text, fingerprint, note, color, visibility])

    const highlight = mapRowToHighlight(result.rows[0])

    // Cache idempotency result
    await redis.setex(`idempotency:${idempotencyKey}`, 86400, JSON.stringify({
      success: true,
      data: highlight
    }))

    // Update aggregation (if user opts in)
    const privacySettings = await getPrivacySettings(userId)
    if (privacySettings.contributeToAggregation) {
      await aggregationService.incrementHighlightCount(bookId, fingerprint)
    }

    // Broadcast to user's other devices
    await syncService.pushHighlight(userId, {
      action: 'create',
      highlight
    })

    const response: ApiResponse<Highlight> = { success: true, data: highlight }
    res.json(response)

  } catch (error) {
    console.error('Failed to create highlight:', error)
    res.status(500).json({ success: false, error: 'Failed to create highlight' })
  }
})

// Get highlights with optional filters
app.get('/api/highlights', authMiddleware, async (req, res) => {
  const userId = req.user!.id
  const { bookId, search, page = 1, limit = 50 } = req.query

  let query = `
    SELECT h.*, b.title as book_title, b.author as book_author, b.cover_url
    FROM highlights h
    JOIN books b ON b.id = h.book_id
    WHERE h.user_id = $1
  `
  const params: unknown[] = [userId]
  let paramIndex = 2

  if (bookId) {
    query += ` AND h.book_id = $${paramIndex++}`
    params.push(bookId)
  }

  if (search) {
    query += ` AND (h.highlighted_text ILIKE $${paramIndex} OR h.note ILIKE $${paramIndex})`
    params.push(`%${search}%`)
    paramIndex++
  }

  const offset = (Number(page) - 1) * Number(limit)
  query += ` ORDER BY h.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`
  params.push(Number(limit), offset)

  const result = await pool.query(query, params)

  // Get total count
  const countResult = await pool.query(
    'SELECT COUNT(*) FROM highlights WHERE user_id = $1',
    [userId]
  )

  res.json({
    items: result.rows.map(mapRowToHighlight),
    total: parseInt(countResult.rows[0].count),
    page: Number(page),
    pageSize: Number(limit),
    hasMore: offset + result.rows.length < parseInt(countResult.rows[0].count)
  })
})

function generateFingerprint(bookId: string, text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  return crypto
    .createHash('sha256')
    .update(`${bookId}:${normalized}`)
    .digest('hex')
    .substring(0, 16)
}
```

### WebSocket Sync Service

```typescript
// backend/src/sync/service.ts
import { WebSocket, WebSocketServer } from 'ws'
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import type { SyncMessage, SyncResponse, HighlightSyncMessage } from '../types.js'

class SyncService {
  private connections: Map<string, Map<string, WebSocket>> = new Map()

  handleConnection(ws: WebSocket, userId: string, deviceId: string) {
    // Register connection
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Map())
    }
    this.connections.get(userId)!.set(deviceId, ws)

    // Update Redis presence
    redis.hset(`sync:${userId}`, deviceId, JSON.stringify({
      connectedAt: Date.now(),
      lastSync: null
    }))

    ws.on('message', (data) => this.handleMessage(ws, userId, deviceId, data.toString()))
    ws.on('close', () => this.handleDisconnect(userId, deviceId))

    // Send queued events for this device
    this.drainOfflineQueue(userId, deviceId, ws)
  }

  private async handleMessage(
    ws: WebSocket,
    userId: string,
    deviceId: string,
    data: string
  ) {
    const message: SyncMessage = JSON.parse(data)

    switch (message.type) {
      case 'sync_request':
        await this.handleSyncRequest(ws, userId, message as SyncRequest)
        break

      case 'highlight_create':
      case 'highlight_update':
      case 'highlight_delete':
        // Forward to highlight service and broadcast
        await this.handleHighlightOperation(userId, deviceId, message)
        break
    }
  }

  private async handleSyncRequest(ws: WebSocket, userId: string, request: SyncRequest) {
    const { lastSyncTimestamp } = request

    // Get changes since last sync
    const highlights = await pool.query(`
      SELECT * FROM highlights
      WHERE user_id = $1 AND updated_at > $2
      ORDER BY updated_at
    `, [userId, new Date(lastSyncTimestamp)])

    // Get deleted highlights
    const deleted = await pool.query(`
      SELECT highlight_id FROM deleted_highlights
      WHERE user_id = $1 AND deleted_at > $2
    `, [userId, new Date(lastSyncTimestamp)])

    const response: SyncResponse = {
      type: 'sync_response',
      highlights: highlights.rows.map(mapRowToHighlight),
      deleted: deleted.rows.map(r => r.highlight_id),
      serverTime: Date.now()
    }

    ws.send(JSON.stringify(response))
  }

  async pushHighlight(userId: string, event: { action: string; highlight: Highlight }) {
    const devices = this.connections.get(userId)
    if (!devices) return

    const message: HighlightSyncMessage = {
      type: 'highlight_sync',
      event,
      timestamp: Date.now()
    }

    for (const [deviceId, ws] of devices) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message))
      } else {
        // Queue for offline device
        await this.queueForDevice(userId, deviceId, message)
      }
    }
  }

  private async queueForDevice(userId: string, deviceId: string, message: SyncMessage) {
    const queueKey = `sync:queue:${userId}:${deviceId}`
    await redis.rpush(queueKey, JSON.stringify(message))
    await redis.expire(queueKey, 30 * 24 * 3600) // 30 days
  }

  private async drainOfflineQueue(userId: string, deviceId: string, ws: WebSocket) {
    const queueKey = `sync:queue:${userId}:${deviceId}`

    while (true) {
      const message = await redis.lpop(queueKey)
      if (!message) break

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message)
      }
    }
  }

  private handleDisconnect(userId: string, deviceId: string) {
    this.connections.get(userId)?.delete(deviceId)
    if (this.connections.get(userId)?.size === 0) {
      this.connections.delete(userId)
    }

    redis.hdel(`sync:${userId}`, deviceId)
  }
}

export const syncService = new SyncService()
```

## Deep Dive: Popular Highlights Integration (8 minutes)

### Backend: Aggregation Service

```typescript
// backend/src/aggregation/service.ts
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import type { PopularHighlight } from '../types.js'

class AggregationService {
  async incrementHighlightCount(bookId: string, fingerprint: string) {
    // Increment in Redis sorted set
    await redis.zincrby(`book:${bookId}:popular`, 1, fingerprint)

    // Set expiry on first add
    const exists = await redis.exists(`book:${bookId}:popular`)
    if (!exists) {
      await redis.expire(`book:${bookId}:popular`, 30 * 24 * 3600)
    }
  }

  async decrementHighlightCount(bookId: string, fingerprint: string) {
    await redis.zincrby(`book:${bookId}:popular`, -1, fingerprint)
  }

  async getPopularHighlights(bookId: string, limit = 10): Promise<PopularHighlight[]> {
    // Check cache first
    const cacheKey = `popular:${bookId}:${limit}`
    const cached = await redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached)
    }

    // Get top fingerprints from sorted set
    const results = await redis.zrevrange(
      `book:${bookId}:popular`,
      0,
      limit - 1,
      'WITHSCORES'
    )

    const highlights: PopularHighlight[] = []

    for (let i = 0; i < results.length; i += 2) {
      const fingerprint = results[i]
      const count = parseInt(results[i + 1])

      // Skip if count is below threshold
      if (count < 5) continue

      // Get representative text for this fingerprint
      const sample = await pool.query(`
        SELECT highlighted_text, location_start, location_end
        FROM highlights
        WHERE book_id = $1 AND fingerprint = $2
        LIMIT 1
      `, [bookId, fingerprint])

      if (sample.rows[0]) {
        highlights.push({
          fingerprint,
          text: sample.rows[0].highlighted_text,
          count,
          location: {
            start: sample.rows[0].location_start,
            end: sample.rows[0].location_end
          }
        })
      }
    }

    // Cache for 5 minutes
    await redis.setex(cacheKey, 300, JSON.stringify(highlights))

    return highlights
  }
}

export const aggregationService = new AggregationService()
```

### Backend: Popular Highlights API

```typescript
// backend/src/aggregation/app.ts
import express from 'express'
import { aggregationService } from './service.js'
import type { PopularHighlight } from '../types.js'

const app = express()

// Get popular highlights for a book
app.get('/api/books/:bookId/popular', async (req, res) => {
  const { bookId } = req.params
  const { limit = 10 } = req.query

  try {
    const highlights = await aggregationService.getPopularHighlights(
      bookId,
      Number(limit)
    )

    res.json({
      success: true,
      data: highlights
    })
  } catch (error) {
    console.error('Failed to get popular highlights:', error)
    res.status(500).json({ success: false, error: 'Failed to get popular highlights' })
  }
})

// Get trending highlights across all books
app.get('/api/trending', async (req, res) => {
  const { limit = 20 } = req.query

  try {
    // Get books with most recent highlight activity
    const activeBooks = await pool.query(`
      SELECT book_id, COUNT(*) as recent_count
      FROM highlights
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY book_id
      ORDER BY recent_count DESC
      LIMIT 10
    `)

    const trending: Array<{
      book: Book
      highlights: PopularHighlight[]
    }> = []

    for (const row of activeBooks.rows) {
      const book = await pool.query('SELECT * FROM books WHERE id = $1', [row.book_id])
      const highlights = await aggregationService.getPopularHighlights(row.book_id, 3)

      if (highlights.length > 0) {
        trending.push({
          book: mapRowToBook(book.rows[0]),
          highlights
        })
      }
    }

    res.json({ success: true, data: trending })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get trending' })
  }
})
```

### Frontend: Trending Page

```tsx
// routes/trending.tsx
import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { getTrending } from '../api/client'
import { PopularPassage } from '../components/PopularPassage'
import type { Book, PopularHighlight } from '../types'

interface TrendingItem {
  book: Book
  highlights: PopularHighlight[]
}

export function TrendingPage() {
  const [trending, setTrending] = useState<TrendingItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadTrending() {
      const result = await getTrending()
      setTrending(result.data)
      setLoading(false)
    }
    loadTrending()
  }, [])

  if (loading) {
    return <TrendingLoading />
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-serif text-gray-800">Trending Highlights</h1>
        <p className="text-gray-600 mt-1">
          See what readers are highlighting this week
        </p>
      </div>

      {trending.map(({ book, highlights }) => (
        <div key={book.id} className="bg-white rounded-lg shadow p-6">
          {/* Book Header */}
          <Link
            to="/books/$bookId"
            params={{ bookId: book.id }}
            className="flex items-start gap-4 mb-6"
          >
            <div className="w-16 aspect-[2/3] bg-kindle-sepia rounded shadow overflow-hidden">
              {book.coverUrl && (
                <img src={book.coverUrl} alt={book.title} className="w-full h-full object-cover" />
              )}
            </div>
            <div>
              <h2 className="font-medium text-gray-900 hover:text-amber-700 transition-colors">
                {book.title}
              </h2>
              <p className="text-sm text-gray-500">{book.author}</p>
            </div>
          </Link>

          {/* Top Highlights */}
          <div className="space-y-4">
            {highlights.map((passage, idx) => (
              <PopularPassage key={passage.fingerprint} passage={passage} rank={idx + 1} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
```

## Deep Dive: Export Flow (5 minutes)

### Frontend: Export Configuration

```tsx
// routes/export.tsx
import { useState } from 'react'
import { exportHighlights } from '../api/client'

type ExportFormat = 'markdown' | 'csv' | 'json'

export function ExportPage() {
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [options, setOptions] = useState({
    includeNotes: true,
    includeDates: false,
    bookIds: [] as string[] // Empty = all books
  })
  const [preview, setPreview] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const handleExport = async (previewOnly = false) => {
    setExporting(true)
    try {
      const result = await exportHighlights({
        format,
        ...options,
        preview: previewOnly
      })

      if (previewOnly) {
        setPreview(result.content)
      } else {
        // Trigger download
        downloadFile(result.content, `highlights.${getExtension(format)}`, getMimeType(format))
      }
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Format selection, options, preview button, download button */}
      {/* ... UI implementation ... */}
    </div>
  )
}
```

### Backend: Export Service

```typescript
// backend/src/highlight/export.ts
import { pool } from '../shared/db.js'

interface ExportOptions {
  format: 'markdown' | 'csv' | 'json'
  includeNotes: boolean
  includeDates: boolean
  bookIds?: string[]
}

export async function exportHighlights(userId: string, options: ExportOptions): Promise<string> {
  let query = `
    SELECT h.*, b.title as book_title, b.author as book_author
    FROM highlights h
    JOIN books b ON b.id = h.book_id
    WHERE h.user_id = $1
  `
  const params: unknown[] = [userId]

  if (options.bookIds && options.bookIds.length > 0) {
    query += ` AND h.book_id = ANY($2)`
    params.push(options.bookIds)
  }

  query += ' ORDER BY b.title, h.location_start'

  const result = await pool.query(query, params)
  const highlights = result.rows

  switch (options.format) {
    case 'markdown':
      return formatAsMarkdown(highlights, options)
    case 'csv':
      return formatAsCSV(highlights, options)
    case 'json':
      return formatAsJSON(highlights, options)
  }
}

function formatAsMarkdown(highlights: Highlight[], options: ExportOptions): string {
  let md = '# My Highlights\n\n'

  // Group by book
  const byBook = new Map<string, Highlight[]>()
  for (const h of highlights) {
    const key = h.book_id
    if (!byBook.has(key)) {
      byBook.set(key, [])
    }
    byBook.get(key)!.push(h)
  }

  for (const [bookId, bookHighlights] of byBook) {
    const first = bookHighlights[0]
    md += `## ${first.book_title}\n`
    md += `*by ${first.book_author}*\n\n`

    for (const h of bookHighlights) {
      md += `> ${h.highlighted_text}\n\n`

      if (options.includeNotes && h.note) {
        md += `**Note:** ${h.note}\n\n`
      }

      if (options.includeDates) {
        md += `*Highlighted on ${formatDate(h.created_at)}*\n\n`
      }

      md += '---\n\n'
    }
  }

  return md
}

function formatAsCSV(highlights: Highlight[], options: ExportOptions): string {
  const headers = ['Book', 'Author', 'Highlight', 'Location']
  if (options.includeNotes) headers.push('Note')
  if (options.includeDates) headers.push('Date')

  const rows = highlights.map(h => {
    const row = [
      escapeCsv(h.book_title),
      escapeCsv(h.book_author),
      escapeCsv(h.highlighted_text),
      `${h.location_start}-${h.location_end}`
    ]
    if (options.includeNotes) row.push(escapeCsv(h.note || ''))
    if (options.includeDates) row.push(formatDate(h.created_at))
    return row.join(',')
  })

  return [headers.join(','), ...rows].join('\n')
}

function formatAsJSON(highlights: Highlight[], options: ExportOptions): string {
  const data = highlights.map(h => {
    const item: Record<string, unknown> = {
      book: { title: h.book_title, author: h.book_author },
      text: h.highlighted_text,
      location: { start: h.location_start, end: h.location_end },
      color: h.color
    }
    if (options.includeNotes && h.note) item.note = h.note
    if (options.includeDates) item.createdAt = h.created_at
    return item
  })

  return JSON.stringify(data, null, 2)
}
```

## Deep Dive: Privacy Settings Integration (5 minutes)

### Shared Privacy Types

```typescript
// shared/types.ts
export interface PrivacySettings {
  highlightVisibility: Visibility
  contributeToAggregation: boolean
  allowFollowers: boolean
  showHighlightsToFollowers: boolean
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  highlightVisibility: 'private',
  contributeToAggregation: true,
  allowFollowers: true,
  showHighlightsToFollowers: false
}
```

### Frontend: Privacy Settings Page

```tsx
// routes/settings.tsx
import { useEffect, useState } from 'react'
import { getPrivacySettings, updatePrivacySettings } from '../api/client'
import type { PrivacySettings } from '../types'

export function SettingsPage() {
  const [settings, setSettings] = useState<PrivacySettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function load() {
      const result = await getPrivacySettings()
      setSettings(result.data)
    }
    load()
  }, [])

  const handleChange = async (key: keyof PrivacySettings, value: unknown) => {
    if (!settings) return

    const updated = { ...settings, [key]: value }
    setSettings(updated)
    setSaving(true)

    try {
      await updatePrivacySettings(updated)
    } catch (error) {
      // Revert on failure
      setSettings(settings)
    } finally {
      setSaving(false)
    }
  }

  if (!settings) return <SettingsLoading />

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <h1 className="text-2xl font-serif text-gray-800">Privacy Settings</h1>

      <section className="space-y-4">
        <h2 className="text-lg font-medium text-gray-700">Community</h2>

        <SettingToggle
          label="Contribute to Popular Highlights"
          description="Include your highlights in community aggregates (anonymized)"
          checked={settings.contributeToAggregation}
          onChange={(v) => handleChange('contributeToAggregation', v)}
        />

        <SettingToggle
          label="Allow Followers"
          description="Let other readers follow you"
          checked={settings.allowFollowers}
          onChange={(v) => handleChange('allowFollowers', v)}
        />

        <SettingToggle
          label="Share Highlights with Followers"
          description="Let followers see your public and friends-only highlights"
          checked={settings.showHighlightsToFollowers}
          onChange={(v) => handleChange('showHighlightsToFollowers', v)}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium text-gray-700">Default Visibility</h2>

        <VisibilitySelect
          value={settings.highlightVisibility}
          onChange={(v) => handleChange('highlightVisibility', v)}
        />
      </section>

      {saving && (
        <p className="text-sm text-gray-500">Saving...</p>
      )}
    </div>
  )
}
```

### Backend: Privacy-Aware Queries

```typescript
// backend/src/social/app.ts
import express from 'express'
import { pool } from '../shared/db.js'
import { authMiddleware } from '../shared/auth.js'

const app = express()

// Get a user's highlights (respects privacy)
app.get('/api/users/:userId/highlights', authMiddleware, async (req, res) => {
  const requesterId = req.user!.id
  const { userId: targetUserId } = req.params

  // Check relationship
  const isFollowing = await pool.query(`
    SELECT 1 FROM follows
    WHERE follower_id = $1 AND followee_id = $2
  `, [requesterId, targetUserId])

  // Get target's privacy settings
  const settings = await pool.query(`
    SELECT * FROM user_privacy_settings WHERE user_id = $1
  `, [targetUserId])

  const privacy = settings.rows[0] || DEFAULT_PRIVACY_SETTINGS

  // Check if allowed to view
  if (!privacy.showHighlightsToFollowers && requesterId !== targetUserId) {
    return res.json({ success: true, data: [] })
  }

  // Determine visible visibility levels
  const visibleLevels = ['public']
  if (isFollowing.rows.length > 0) {
    visibleLevels.push('friends')
  }
  if (requesterId === targetUserId) {
    visibleLevels.push('private')
  }

  const highlights = await pool.query(`
    SELECT h.*, b.title as book_title, b.author as book_author
    FROM highlights h
    JOIN books b ON b.id = h.book_id
    WHERE h.user_id = $1 AND h.visibility = ANY($2)
    ORDER BY h.created_at DESC
    LIMIT 50
  `, [targetUserId, visibleLevels])

  res.json({
    success: true,
    data: highlights.rows.map(mapRowToHighlight)
  })
})
```

## Database Schema (2 minutes)

```sql
-- Core tables
CREATE TABLE highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  book_id UUID NOT NULL REFERENCES books(id),
  location_start INTEGER NOT NULL,
  location_end INTEGER NOT NULL,
  highlighted_text TEXT NOT NULL,
  fingerprint VARCHAR(16),
  note TEXT,
  color VARCHAR(20) DEFAULT 'yellow',
  visibility VARCHAR(20) DEFAULT 'private',
  idempotency_key VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_highlights_user ON highlights(user_id, created_at DESC);
CREATE INDEX idx_highlights_book ON highlights(book_id);
CREATE INDEX idx_highlights_fingerprint ON highlights(book_id, fingerprint);

-- Privacy settings
CREATE TABLE user_privacy_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  highlight_visibility VARCHAR(20) DEFAULT 'private',
  contribute_to_aggregation BOOLEAN DEFAULT true,
  allow_followers BOOLEAN DEFAULT true,
  show_highlights_to_followers BOOLEAN DEFAULT false
);

-- Social graph
CREATE TABLE follows (
  follower_id UUID REFERENCES users(id),
  followee_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id)
);
```

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Sync Protocol | WebSocket | Server-Sent Events | Bidirectional needed for conflict resolution |
| Conflict Resolution | Last-Write-Wins | CRDTs | Simpler, works for highlight data |
| Aggregation Storage | Redis + PostgreSQL | Kafka + ClickHouse | Simpler for this scale |
| Offline Queue | Zustand persist | IndexedDB | Sufficient for highlight operations |
| Fingerprinting | SHA256 prefix | MinHash | Exact matching preferred |

## Closing Summary (1 minute)

"The Kindle Community Highlights system is built with a fullstack perspective emphasizing:

1. **Shared type contracts** between frontend and backend ensuring type-safe data flow across the WebSocket and REST APIs
2. **End-to-end highlight lifecycle** from text selection through optimistic updates, WebSocket sync, aggregation updates, and cross-device broadcast
3. **Privacy-integrated data access** with visibility checks at both the API and query levels

Key integration points include the WebSocket sync service bridging frontend state with backend persistence, the aggregation service consuming highlight events while respecting privacy settings, and the export service transforming stored data into user-friendly formats. The architecture enables real-time collaboration while preserving individual control over data sharing."
