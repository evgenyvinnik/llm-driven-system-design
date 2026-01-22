# iCloud Sync - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design iCloud, a file and photo synchronization service that keeps data consistent across all Apple devices. As a frontend engineer, I'll focus on the client-side architecture: building an offline-first experience with local persistence, implementing smooth sync status UI, and creating an efficient photo gallery with virtualization for thousands of images.

The key frontend challenges are: managing complex sync state across file operations, building a responsive UI that works offline and syncs seamlessly when reconnected, and rendering large photo libraries efficiently without overwhelming memory or degrading scroll performance."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **File Browser**: Navigate folders, view files, upload/download content
- **Photo Gallery**: Grid view of photos with thumbnails, full-screen viewer
- **Sync Status**: Clear indication of sync progress and conflicts
- **Offline Support**: Full functionality offline with pending changes queue
- **Sharing**: Share files and photo albums with other users

### Non-Functional Requirements
- **Performance**: 60fps scrolling through 10,000+ photos
- **Responsiveness**: < 100ms UI response for all interactions
- **Offline-first**: Core features work without network
- **Memory efficiency**: Handle large libraries without memory bloat

### Key Frontend Challenges
1. How to represent sync state visually (synced, pending, conflict)?
2. How to handle offline operations and queue them for sync?
3. How to efficiently render thousands of photos?

## High-Level Architecture (4 minutes)

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND APPLICATION                               │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │
│  │  File Browser   │  │  Photo Gallery  │  │  Admin Panel    │            │
│  │  - Tree view    │  │  - Grid view    │  │  - Storage      │            │
│  │  - List view    │  │  - Lightbox     │  │  - Devices      │            │
│  │  - Upload/DL    │  │  - Albums       │  │  - Sharing      │            │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘            │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │                     STATE MANAGEMENT (Zustand)                     │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐      │    │
│  │  │ File Store   │  │ Photo Store  │  │ Sync State Store    │      │    │
│  │  │ - Files tree │  │ - Library    │  │ - Pending ops       │      │    │
│  │  │ - Selection  │  │ - Albums     │  │ - Conflicts         │      │    │
│  │  │ - Operations │  │ - Viewer     │  │ - Device status     │      │    │
│  │  └──────────────┘  └──────────────┘  └─────────────────────┘      │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │                       SERVICE LAYER                                │    │
│  │  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐       │    │
│  │  │ Sync Engine  │  │ Offline Queue  │  │ WebSocket Client │       │    │
│  │  └──────────────┘  └────────────────┘  └──────────────────┘       │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │                     PERSISTENCE LAYER                              │    │
│  │            IndexedDB (files, photos, pending operations)           │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                            BACKEND API                                    │
└───────────────────────────────────────────────────────────────────────────┘
```

### Component Structure

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      COMPONENT ORGANIZATION                               │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  components/                                                              │
│  ├── admin/                      # Admin dashboard components             │
│  │   ├── OverviewTab             # System statistics                      │
│  │   ├── OperationsTab           # Sync operations table                  │
│  │   ├── ConflictsTab            # Conflict management                    │
│  │   └── UsersTab                # User administration                    │
│  │                                                                        │
│  ├── common/                     # Shared UI primitives                   │
│  │   ├── StatCard                # Metric display cards                   │
│  │   ├── LoadingSpinner          # Loading indicators                     │
│  │   ├── Modal                   # Dialog wrapper                         │
│  │   └── ModalActions            # Cancel/confirm buttons                 │
│  │                                                                        │
│  ├── files/                      # File browser components                │
│  │   ├── FileItemComponent       # Single file/folder row                 │
│  │   ├── FileToolbar             # Breadcrumb and actions                 │
│  │   ├── FileList                # File listing container                 │
│  │   ├── FileStatusBanners       # Sync status banners                    │
│  │   ├── NewFolderModal          # Folder creation                        │
│  │   ├── SelectionBar            # Selection count                        │
│  │   └── DragOverlay             # Drop zone indicator                    │
│  │                                                                        │
│  └── photos/                     # Photo gallery components               │
│      ├── PhotoItem               # Single photo thumbnail                 │
│      ├── PhotoViewer             # Full-screen lightbox                   │
│      ├── PhotoToolbar            # Filter controls                        │
│      ├── PhotoGrid               # Virtualized grid                       │
│      └── CreateAlbumModal        # Album creation                         │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Sync State Management (10 minutes)

The sync state is the most complex part of the frontend. We need to track file status, pending operations, and conflicts.

### Zustand Store Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         FILE STORE STRUCTURE                              │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  FileItem                                                                 │
│  ─────────                                                                │
│  ┌─────────────────┐  ┌─────────────────────────────────────────────────┐ │
│  │ id: string      │  │ syncStatus: 'synced' | 'pending' | 'syncing'    │ │
│  │ name: string    │  │            | 'conflict' | 'error'               │ │
│  │ path: string    │  ├─────────────────────────────────────────────────┤ │
│  │ type: file|folder│  │ version: Record<deviceId, sequenceNumber>       │ │
│  │ size: number    │  │  (Version vector for conflict detection)        │ │
│  └─────────────────┘  └─────────────────────────────────────────────────┘ │
│                                                                           │
│  PendingOperation                                                         │
│  ────────────────                                                         │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │ id: string                                                         │   │
│  │ type: 'upload' | 'download' | 'delete' | 'rename' | 'move'         │   │
│  │ fileId: string                                                     │   │
│  │ payload: File | metadata                                           │   │
│  │ createdAt: Date                                                    │   │
│  │ retries: number (max 3)                                            │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### File Upload Flow with Optimistic Updates

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        OPTIMISTIC UPLOAD FLOW                             │
└───────────────────────────────────────────────────────────────────────────┘

  User drops file
        │
        ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 1. OPTIMISTIC UPDATE                                                    │
  │    Create temp file entry with status='pending'                         │
  │    Display immediately in UI                                            │
  └───────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
                        ┌──────────────────────────┐
                        │   navigator.onLine?      │
                        └───────────┬──────────────┘
                                    │
              ┌─────────────────────┴─────────────────────┐
              │ ONLINE                                    │ OFFLINE
              ▼                                           ▼
  ┌───────────────────────────────────┐   ┌───────────────────────────────────┐
  │ 2a. Set status='syncing'          │   │ 2b. Queue operation               │
  │     Show spinner on file          │   │     Store in IndexedDB            │
  └───────────────────┬───────────────┘   │     Will process when online      │
                      │                   └───────────────────────────────────┘
                      ▼
  ┌───────────────────────────────────┐
  │ 3. API upload                     │
  └───────────────────┬───────────────┘
                      │
        ┌─────────────┴─────────────┐
        │ SUCCESS                   │ FAILURE
        ▼                           ▼
  ┌─────────────────────┐   ┌─────────────────────┐
  │ 4a. Replace temp ID │   │ 4b. Set status=     │
  │     with server ID  │   │     'error'         │
  │     status='synced' │   │     Queue for retry │
  └─────────────────────┘   └─────────────────────┘
```

### Pending Queue Processing

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    PENDING QUEUE PROCESSOR                                │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  processPendingQueue()                                                    │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │ Guard: if (!isOnline || pendingOperations.length === 0) return     │   │
│  └───────────────────────────────────┬────────────────────────────────┘   │
│                                      │                                    │
│                                      ▼                                    │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │ For each operation in queue:                                       │   │
│  │                                                                    │   │
│  │   ┌──────────────────────────────────────────────────────────────┐ │   │
│  │   │ Try: executeOperation(op)                                    │ │   │
│  │   │   Success ──▶ Remove from queue                              │ │   │
│  │   │   Failure ──▶ Increment retries                              │ │   │
│  │   │              If retries < 3 ──▶ Keep in queue                │ │   │
│  │   │              If retries >= 3 ──▶ Mark as permanent error     │ │   │
│  │   └──────────────────────────────────────────────────────────────┘ │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  Trigger: Called when 'online' event fires                                │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### File Status Banners

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     STATUS BANNER SYSTEM                                  │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ OFFLINE BANNER (amber)                                              │  │
│  │ ┌────────────────────────────────────────────────────────────────┐  │  │
│  │ │ [CloudOff Icon]  You're offline                                │  │  │
│  │ │                  Changes will sync when back online            │  │  │
│  │ │                                         [X pending] ──────────▶│  │  │
│  │ └────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ CONFLICT BANNER (red)                                               │  │
│  │ ┌────────────────────────────────────────────────────────────────┐  │  │
│  │ │ [AlertTriangle]  N conflict(s) detected                        │  │  │
│  │ │                  Same file was edited on multiple devices      │  │  │
│  │ │                                            [Resolve Button] ──▶│  │  │
│  │ └────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ SYNCING BANNER (blue)                                               │  │
│  │ ┌────────────────────────────────────────────────────────────────┐  │  │
│  │ │ [RefreshCw spinning]  Syncing N file(s)...                     │  │  │
│  │ └────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ ERROR BANNER (red)                                                  │  │
│  │ ┌────────────────────────────────────────────────────────────────┐  │  │
│  │ │ [XCircle]  N file(s) failed to sync                            │  │  │
│  │ │                                              [Retry Button] ──▶│  │  │
│  │ └────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Sync Status Icon Mapping

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      SYNC STATUS ICONS                                    │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Status      │  Icon            │  Color        │  Meaning                │
│  ────────────┼──────────────────┼───────────────┼─────────────────────────│
│  synced      │  CheckCircle     │  green-500    │  Fully synchronized     │
│  pending     │  Clock           │  amber-500    │  Waiting to sync        │
│  syncing     │  RefreshCw spin  │  blue-500     │  Currently uploading    │
│  conflict    │  AlertTriangle   │  red-500      │  Needs user resolution  │
│  error       │  XCircle         │  red-500      │  Failed after retries   │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Photo Gallery with Virtualization (10 minutes)

The photo gallery must handle thousands of images efficiently using row-based virtualization.

### Why Row-Based Virtualization

Unlike single-item virtualization, we virtualize rows containing multiple photos:
- Grid layout requires consistent column structure
- Virtualizing rows maintains grid alignment
- Simpler CSS layout (grid within each virtualized row)

### PhotoGrid Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    ROW-BASED VIRTUALIZATION                               │
└───────────────────────────────────────────────────────────────────────────┘

  Constants: COLUMNS = 4, ITEM_HEIGHT = 200px, GAP = 8px

  ┌───────────────────────────────────────────────────────────────────────┐
  │                     Scroll Container (parentRef)                       │
  │  ┌─────────────────────────────────────────────────────────────────┐  │
  │  │                   Virtual Height Container                       │  │
  │  │           (height = rowCount * (ITEM_HEIGHT + GAP))              │  │
  │  │                                                                  │  │
  │  │    ═══════════════ VIEWPORT TOP ═══════════════                  │  │
  │  │                                                                  │  │
  │  │  ┌─────────────────────────────────────────────────────────────┐ │  │
  │  │  │ Row 5 (rendered)  translateY(row.start)                     │ │  │
  │  │  │ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                 │ │  │
  │  │  │ │ Photo  │ │ Photo  │ │ Photo  │ │ Photo  │                 │ │  │
  │  │  │ │  17    │ │  18    │ │  19    │ │  20    │                 │ │  │
  │  │  │ └────────┘ └────────┘ └────────┘ └────────┘                 │ │  │
  │  │  └─────────────────────────────────────────────────────────────┘ │  │
  │  │  ┌─────────────────────────────────────────────────────────────┐ │  │
  │  │  │ Row 6 (rendered)                                            │ │  │
  │  │  │ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                 │ │  │
  │  │  │ │ Photo  │ │ Photo  │ │ Photo  │ │ Photo  │                 │ │  │
  │  │  │ │  21    │ │  22    │ │  23    │ │  24    │                 │ │  │
  │  │  │ └────────┘ └────────┘ └────────┘ └────────┘                 │ │  │
  │  │  └─────────────────────────────────────────────────────────────┘ │  │
  │  │  ┌─────────────────────────────────────────────────────────────┐ │  │
  │  │  │ Row 7 (rendered)                                            │ │  │
  │  │  │ ... (2 more rows with overscan: 2)                          │ │  │
  │  │  └─────────────────────────────────────────────────────────────┘ │  │
  │  │                                                                  │  │
  │  │    ═══════════════ VIEWPORT BOTTOM ═══════════════               │  │
  │  │                                                                  │  │
  │  │    (Rows 1-4 and 10+ are NOT in DOM)                             │  │
  │  │                                                                  │  │
  │  └─────────────────────────────────────────────────────────────────┘  │
  └───────────────────────────────────────────────────────────────────────┘
```

### Virtualizer Configuration

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    @tanstack/react-virtual SETUP                          │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  useVirtualizer({                                                         │
│    count: Math.ceil(photos.length / COLUMNS),  // Number of rows          │
│    getScrollElement: () => parentRef.current,   // Scroll container       │
│    estimateSize: () => ITEM_HEIGHT + GAP,       // Row height estimate    │
│    overscan: 2                                  // 2 extra rows = 8 photos│
│  })                                                                       │
│                                                                           │
│  For each virtualRow:                                                     │
│    startIndex = virtualRow.index * COLUMNS                                │
│    rowPhotos = photos.slice(startIndex, startIndex + COLUMNS)             │
│                                                                           │
│  Position: absolute, transform: translateY(virtualRow.start)              │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Infinite Scroll Detection

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    INFINITE SCROLL HANDLER                                │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  onScroll = () => {                                                       │
│    const { scrollTop, scrollHeight, clientHeight } = container           │
│                                                                           │
│    ┌─────────────────────────────────────────────────────────────────┐    │
│    │                                                                 │    │
│    │   scrollHeight (total virtual height)                           │    │
│    │   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │    │
│    │   ▲                                                             │    │
│    │   │ scrollTop (distance scrolled)                               │    │
│    │   │                                                             │    │
│    │   │  ┌─────────────────────────────┐                            │    │
│    │   │  │ clientHeight (visible area) │                            │    │
│    │   ▼  └─────────────────────────────┘                            │    │
│    │                                      ◀── Threshold: 300px        │    │
│    │   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │    │
│    │                                                                 │    │
│    └─────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│    if (scrollHeight - scrollTop - clientHeight < 300) {                   │
│      onLoadMore()  // Fetch next page of photos                           │
│    }                                                                      │
│  }                                                                        │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### PhotoItem with Lazy Loading

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      PHOTO ITEM COMPONENT                                 │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                         PhotoItem                                   │  │
│  │  ┌───────────────────────────────────────────────────────────────┐  │  │
│  │  │                                                               │  │  │
│  │  │  ┌──────┐                                                     │  │  │
│  │  │  │ ✓    │  Selection checkbox (top-left)                      │  │  │
│  │  │  └──────┘  - Click toggles selection                          │  │  │
│  │  │            - Blue when selected                               │  │  │
│  │  │                                                               │  │  │
│  │  │     ┌──────────────────────────────────────────────────┐      │  │  │
│  │  │     │                                                  │      │  │  │
│  │  │     │           <img> with lazy loading                │      │  │  │
│  │  │     │                                                  │      │  │  │
│  │  │     │   IntersectionObserver triggers src assignment   │      │  │  │
│  │  │     │   when 100px from viewport                       │      │  │  │
│  │  │     │                                                  │      │  │  │
│  │  │     │   While loading: spinner animation               │      │  │  │
│  │  │     │   After load: fade in (opacity transition)       │      │  │  │
│  │  │     │                                                  │      │  │  │
│  │  │     └──────────────────────────────────────────────────┘      │  │  │
│  │  │                                                               │  │  │
│  │  │                                                   ┌────────┐  │  │  │
│  │  │                           Sync status indicator ──│ [icon] │  │  │  │
│  │  │                           (bottom-right, if not   └────────┘  │  │  │
│  │  │                            synced)                            │  │  │
│  │  │                                                               │  │  │
│  │  └───────────────────────────────────────────────────────────────┘  │  │
│  │                                                                     │  │
│  │  Styles: aspect-square, rounded-lg, overflow-hidden                 │  │
│  │  If selected: ring-2 ring-blue-500 ring-offset-2                    │  │
│  │                                                                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Virtualization Performance Impact

| Metric | Without Virtualization | With Virtualization |
|--------|------------------------|---------------------|
| DOM nodes (1000 photos) | 4000+ | ~80 |
| Memory usage | 400MB+ | 80MB |
| Initial render | 2+ seconds | <200ms |
| Scroll FPS | Degrades with size | Constant 60fps |

## Deep Dive: Offline Support (8 minutes)

### IndexedDB Schema

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        INDEXEDDB STORES                                   │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Database: 'icloud-cache' (version 1)                                     │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ Store: 'files'                                                      │  │
│  │ keyPath: 'id'                                                       │  │
│  │ Indexes: 'by-path' ──▶ file.path                                    │  │
│  │ Content: FileItem objects                                           │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ Store: 'photos'                                                     │  │
│  │ keyPath: 'id'                                                       │  │
│  │ Indexes: 'by-date' ──▶ photo.takenAt                                │  │
│  │ Content: Photo metadata objects                                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ Store: 'pendingOps'                                                 │  │
│  │ keyPath: 'id'                                                       │  │
│  │ Content: PendingOperation objects for offline queue                 │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ Store: 'thumbnails'                                                 │  │
│  │ keyPath: (auto-generated)                                           │  │
│  │ Content: Blob data keyed by photoId                                 │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Offline Storage Operations

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    OFFLINE STORAGE API                                    │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  offlineStorage.getFiles(path)                                            │
│  ─────────────────────────────                                            │
│  Returns all files in directory from IndexedDB cache                      │
│                                                                           │
│  offlineStorage.saveFile(file)                                            │
│  ──────────────────────────────                                           │
│  Upserts FileItem to 'files' store                                        │
│                                                                           │
│  offlineStorage.saveThumbnail(photoId, blob)                              │
│  ────────────────────────────────────────────                             │
│  Stores thumbnail binary for offline photo display                        │
│                                                                           │
│  offlineStorage.getThumbnail(photoId)                                     │
│  ─────────────────────────────────────                                    │
│  Retrieves cached thumbnail blob                                          │
│                                                                           │
│  offlineStorage.queueOperation(op)                                        │
│  ─────────────────────────────────                                        │
│  Adds pending operation to queue                                          │
│                                                                           │
│  offlineStorage.getPendingOperations()                                    │
│  ──────────────────────────────────────                                   │
│  Returns all queued operations for processing                             │
│                                                                           │
│  offlineStorage.removeOperation(id)                                       │
│  ───────────────────────────────────                                      │
│  Removes successfully synced operation                                    │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Online/Offline Detection Hook

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     useOnlineStatus() HOOK                                │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ State: isOnline = navigator.onLine                                  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  useEffect:                                                               │
│    window.addEventListener('online', handleOnline)                        │
│    window.addEventListener('offline', handleOffline)                      │
│                                                                           │
│  handleOnline = () => {                                                   │
│    setIsOnline(true)                                                      │
│    processPendingQueue()  ──▶ Sync all queued changes                     │
│  }                                                                        │
│                                                                           │
│  handleOffline = () => {                                                  │
│    setIsOnline(false)                                                     │
│  }                                                                        │
│                                                                           │
│  return isOnline                                                          │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Service Worker for Thumbnail Caching

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    SERVICE WORKER STRATEGY                                │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Cache Name: 'thumbnails-v1'                                              │
│                                                                           │
│  fetch event handler:                                                     │
│                                                                           │
│    if (url.pathname.includes('/thumbnails/')) {                           │
│                                                                           │
│      ┌─────────────────────────────────────────────────────────────────┐  │
│      │                   Cache-First Strategy                          │  │
│      │                                                                 │  │
│      │   Request ──▶ Check Cache ──┬──▶ HIT ──▶ Return cached          │  │
│      │                             │                                   │  │
│      │                             └──▶ MISS ──▶ Fetch from network    │  │
│      │                                         │                       │  │
│      │                                         ▼                       │  │
│      │                                  Clone response                 │  │
│      │                                         │                       │  │
│      │                                         ▼                       │  │
│      │                                  Store in cache                 │  │
│      │                                         │                       │  │
│      │                                         ▼                       │  │
│      │                                  Return response                │  │
│      └─────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│    }                                                                      │
│                                                                           │
│  Benefit: Thumbnails persist across sessions, instant display offline    │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Conflict Resolution UI (5 minutes)

### Conflict Resolution Modal

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    CONFLICT RESOLUTION MODAL                              │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  [X]                                         Resolve Conflict        │  │
│  ├─────────────────────────────────────────────────────────────────────┤  │
│  │                                                                     │  │
│  │  ┌─────────────────────────────────────────────────────────────┐    │  │
│  │  │ (amber background)                                          │    │  │
│  │  │ "document.docx" was edited on multiple devices.             │    │  │
│  │  │ Choose which version to keep.                               │    │  │
│  │  └─────────────────────────────────────────────────────────────┘    │  │
│  │                                                                     │  │
│  │  ┌──────────────────────────┐  ┌──────────────────────────┐         │  │
│  │  │                          │  │                          │         │  │
│  │  │  [Laptop Icon]           │  │  [Cloud Icon]            │         │  │
│  │  │                          │  │                          │         │  │
│  │  │  This device             │  │  iCloud                  │         │  │
│  │  │  ─────────────           │  │  ──────                  │         │  │
│  │  │  MacBook Pro             │  │  iPhone 15               │         │  │
│  │  │  Modified 2 hours ago    │  │  Modified 30 minutes ago │         │  │
│  │  │  15.2 KB                 │  │  18.7 KB                 │         │  │
│  │  │                          │  │                          │         │  │
│  │  │  [Click to select]       │  │  [Click to select]       │         │  │
│  │  └──────────────────────────┘  └──────────────────────────┘         │  │
│  │                                                                     │  │
│  │  ┌──────────────────────────────────────────────────────────────┐   │  │
│  │  │  [Copy Icon]  Keep both versions                             │   │  │
│  │  │               (Creates "document (conflict).docx")           │   │  │
│  │  └──────────────────────────────────────────────────────────────┘   │  │
│  │                                                                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  Resolution options:                                                      │
│    'local'  ──▶ Overwrite server with local version                       │
│    'server' ──▶ Overwrite local with server version                       │
│    'both'   ──▶ Keep local as main, rename server copy                    │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

## Trade-offs and Alternatives (5 minutes)

### 1. Zustand vs. Redux

| Aspect | Zustand | Redux |
|--------|---------|-------|
| Boilerplate | Minimal | Significant |
| Bundle size | ~2KB | ~7KB + toolkit |
| DevTools | Supported | Native |
| Learning curve | Low | Moderate |

**Chose Zustand**: Simpler API, built-in persistence, perfect for this complexity level.

### 2. Row vs. Item Virtualization

| Aspect | Row-Based | Item-Based |
|--------|-----------|------------|
| Grid alignment | Natural | Complex |
| Implementation | Simpler | More flexible |
| Dynamic heights | Harder | Easier |

**Chose Row-Based**: Grid layout requires consistent columns. Row virtualization maintains alignment naturally.

### 3. IndexedDB vs. localStorage

| Aspect | IndexedDB | localStorage |
|--------|-----------|--------------|
| Size limit | GB+ | 5-10MB |
| Data types | Any | Strings only |
| Performance | Async, indexed | Sync, blocking |

**Chose IndexedDB**: Need to store file metadata, thumbnails, and pending operations - can easily exceed localStorage limits.

### Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| State management | Zustand | Redux | Simpler, built-in persist |
| Virtualization | Row-based | Item-based | Grid alignment |
| Offline storage | IndexedDB | localStorage | Size + performance |
| Thumbnail caching | Service Worker | In-memory | Persistence across sessions |

## Component Size Guidelines

Each component follows a ~150-200 line maximum:
- **Orchestrator components** (e.g., `PhotoGallery.tsx`): Handle state, effects, compose sub-components
- **Presentation components** (e.g., `PhotoItem.tsx`): Pure UI rendering with props

## Closing Summary (1 minute)

"The iCloud frontend is built around three core innovations:

1. **Offline-first architecture** with IndexedDB persistence - users can browse, organize, and queue changes offline, with seamless sync when reconnected
2. **Row-based virtualization** for the photo gallery - enabling smooth 60fps scrolling through thousands of photos without memory bloat
3. **Clear sync status UI** with conflict resolution - users always know what's synced, pending, or in conflict, with intuitive resolution flows

The key trade-off throughout is complexity vs. user experience. We chose Zustand with persistence for state management because sync state is inherently complex but the API remains simple. We chose row-based virtualization because maintaining grid alignment is critical for photo browsing.

For future improvements, I'd add drag-and-drop file organization, predictive prefetching for photos likely to be viewed, and progressive JPEG loading for faster perceived performance."
