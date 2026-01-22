# Dropbox - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the frontend architecture for a cloud file storage application that allows users to:
- Browse files and folders with responsive file explorer interface
- Upload large files with progress tracking and resume capability
- Download files with range request support
- Manage file sharing through intuitive UI
- Sync changes across browser tabs and devices

## Requirements Clarification

### Functional Requirements
1. **File Browser**: Navigate folder hierarchy, preview files, bulk operations
2. **Upload Experience**: Drag-and-drop, progress bars, pause/resume, multiple files
3. **Download Experience**: Direct download, batch download as zip
4. **Sharing UI**: Create share links, manage permissions, copy URLs
5. **Version History**: View and restore previous versions

### Non-Functional Requirements
1. **Responsive**: Desktop, tablet, and mobile layouts
2. **Performance**: Folder loading < 200ms, smooth scrolling with 1000s of files
3. **Accessibility**: Keyboard navigation, screen reader support
4. **Offline Resilience**: Show cached data, queue uploads for when online

### UI/UX Requirements
- Familiar file explorer paradigm
- Visual feedback for all operations
- Upload queue with individual file progress
- Conflict indication during sync
- Breadcrumb navigation

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          React Application                               │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                        TanStack Router                               ││
│  │    /                  ──▶ File Browser (root folder)                ││
│  │    /folder/:id        ──▶ File Browser (specific folder)            ││
│  │    /shared            ──▶ Shared with me                             ││
│  │    /trash             ──▶ Deleted files                              ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  ┌──────────────────────┐  ┌────────────────────────────────────────┐   │
│  │    Sidebar           │  │          Main Content Area              │   │
│  │  ┌────────────────┐  │  │  ┌──────────────────────────────────┐  │   │
│  │  │ Navigation     │  │  │  │        Toolbar                   │  │   │
│  │  │ - My Files     │  │  │  │  [Upload] [New Folder] [...]     │  │   │
│  │  │ - Shared       │  │  │  └──────────────────────────────────┘  │   │
│  │  │ - Trash        │  │  │  ┌──────────────────────────────────┐  │   │
│  │  └────────────────┘  │  │  │        Breadcrumb                │  │   │
│  │  ┌────────────────┐  │  │  │  Home > Projects > Design        │  │   │
│  │  │ Storage Quota  │  │  │  └──────────────────────────────────┘  │   │
│  │  │ [====     ]    │  │  │  ┌──────────────────────────────────┐  │   │
│  │  │ 5/10GB         │  │  │  │        File Grid / List          │  │   │
│  │  └────────────────┘  │  │  │    [folder1] [file.pdf]          │  │   │
│  └──────────────────────┘  │  └──────────────────────────────────┘  │   │
│                             └────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      Upload Queue Panel                           │   │
│  │    report.pdf   [=======   ] 70%   [Pause] [X]                   │   │
│  │    image.png    [==========] Complete                            │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                     Zustand Store                                    ││
│  │  currentFolder | files[] | selectedIds | uploadQueue | viewMode     ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: State Management with Zustand

### Store Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         FileStore (Zustand)                              │
├─────────────────────────────────────────────────────────────────────────┤
│  Navigation State                                                        │
│  ├── currentFolderId: string | null                                     │
│  └── breadcrumb: FolderInfo[]                                           │
├─────────────────────────────────────────────────────────────────────────┤
│  Files & Selection                                                       │
│  ├── items: FileItem[]                                                  │
│  ├── selectedIds: Set<string>                                           │
│  └── isLoading: boolean                                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  View Options                                                            │
│  ├── viewMode: 'grid' | 'list'                                          │
│  ├── sortBy: 'name' | 'date' | 'size'                                   │
│  └── sortOrder: 'asc' | 'desc'                                          │
├─────────────────────────────────────────────────────────────────────────┤
│  Upload Queue                                                            │
│  └── uploads: UploadTask[]                                              │
│      ├── id, file, folderId                                             │
│      ├── status: pending | uploading | paused | completed | error       │
│      ├── progress: number (0-100)                                       │
│      ├── uploadedChunks: number[]                                       │
│      └── totalChunks: number                                            │
├─────────────────────────────────────────────────────────────────────────┤
│  Actions                                                                 │
│  ├── navigateToFolder(folderId) ──▶ fetch & update items               │
│  ├── selectItem(id, multi?) ──▶ toggle selection                       │
│  ├── setViewMode / setSorting                                           │
│  ├── addUpload(file, folderId) ──▶ create task & start chunked upload  │
│  ├── pauseUpload / resumeUpload / cancelUpload                          │
│  └── updateUploadProgress(id, progress)                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

> "I chose Zustand over Redux for its minimal API and native async action support. For a file manager with upload queues and navigation state, Zustand's simplicity reduces boilerplate significantly while still providing selective subscriptions for performance."

### Why Zustand Over Redux?

| Factor | Zustand | Redux |
|--------|---------|-------|
| Boilerplate | Minimal | Significant |
| Bundle size | ~1KB | ~7KB + middleware |
| DevTools | Optional plugin | Built-in |
| Async actions | Native | Requires thunk/saga |
| Selective updates | Built-in | Manual with selectors |

---

## Deep Dive: Chunked File Upload

### Upload Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Chunked Upload Flow                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  User Drops File                                                         │
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────────┐                                                    │
│  │ Compute Chunk   │  Split file into 4MB chunks                        │
│  │ Hashes (SHA-256)│  Generate hash for each chunk                      │
│  └────────┬────────┘                                                    │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────┐     ┌─────────────────┐                            │
│  │ Initiate Upload │────▶│ Backend Returns │                            │
│  │ (send all hashes│     │ chunksNeeded[]  │  (deduplication)           │
│  └─────────────────┘     └────────┬────────┘                            │
│                                   │                                      │
│                                   ▼                                      │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    Upload Loop                                   │    │
│  │  for each chunkIndex in chunksNeeded:                           │    │
│  │    ├── Check if paused ──▶ break                                │    │
│  │    ├── Slice file[start:end]                                    │    │
│  │    ├── Upload chunk with hash                                   │    │
│  │    └── Update progress: (i+1)/total * 100                       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                   │                                      │
│                                   ▼                                      │
│  ┌─────────────────┐     ┌─────────────────┐                            │
│  │ Complete Upload │────▶│ Refresh Folder  │                            │
│  │ status: done    │     │ Show new file   │                            │
│  └─────────────────┘     └─────────────────┘                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

> "The key insight for resumable uploads is computing chunk hashes upfront and letting the server tell us which chunks are needed. This enables both deduplication (same content across users) and resume (skip already-uploaded chunks)."

### Upload Queue UI Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Upload Queue Panel (fixed bottom-right)                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  Header: "Uploading 3 file(s)"                            [Minimize]    │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [FileIcon] report.pdf                                            │  │
│  │  4.2 MB - 70%                                    [Clock/Spinner]  │  │
│  │  [================          ] Progress Bar                        │  │
│  │  [Pause] [Cancel]                                                 │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [FileIcon] image.png                                             │  │
│  │  1.1 MB - Complete                                   [Checkmark]  │  │
│  │  [==================================] Green                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [FileIcon] document.docx                                         │  │
│  │  Error: Network timeout                            [Alert Icon]   │  │
│  │  [==============                ] Red                             │  │
│  │  [Retry] [Cancel]                                                 │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Status Icons by State:**
- pending: Clock icon (gray)
- uploading: Spinner (blue, animated)
- paused: Pause icon (yellow)
- completed: Checkmark (green)
- error: Alert circle (red)

---

## Deep Dive: File Browser Views

### Grid View Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Grid View (responsive: 2/4/6/8 columns by breakpoint)                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ [Checkbox]   │  │ [Checkbox]   │  │ [Checkbox]   │  │ [...]      │  │
│  │   [...]Menu  │  │   [...]Menu  │  │   [...]Menu  │  │            │  │
│  │              │  │              │  │              │  │            │  │
│  │   [Folder    │  │   [Image     │  │   [PDF       │  │   [File    │  │
│  │    Icon]     │  │    Preview]  │  │    Icon]     │  │    Icon]   │  │
│  │              │  │              │  │              │  │            │  │
│  │  "Projects"  │  │  "photo.jpg" │  │  "doc.pdf"   │  │  "data.csv"│  │
│  │              │  │              │  │              │  │            │  │
│  │  [Selected]  │  │              │  │              │  │            │  │
│  │  blue ring   │  │              │  │              │  │            │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────────┘  │
│                                                                          │
│  Interactions:                                                           │
│  - Click: Select (clear others)                                         │
│  - Ctrl/Cmd+Click: Multi-select                                         │
│  - Double-click: Open folder / Preview file                             │
│  - Right-click: Context menu                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### List View with Virtualization

```
┌─────────────────────────────────────────────────────────────────────────┐
│  List View (virtualized for 1000+ items)                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  Name (col-span-6)    Modified (col-2)   Size (col-2)   Actions (col-2) │
├─────────────────────────────────────────────────────────────────────────┤
│  [x] [FolderIcon] Projects          Dec 10, 2024       --       [...]   │
│  [ ] [FileIcon] report.pdf          Dec 8, 2024        2.4 MB   [...]   │
│  [ ] [ImageIcon] screenshot.png     Dec 5, 2024        1.1 MB   [...]   │
│  [ ] [FileIcon] data.xlsx           Nov 28, 2024       845 KB   [...]   │
│  ...                                                                     │
│  (virtualized: only visible rows rendered)                               │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  @tanstack/react-virtual                                        │    │
│  │  - estimateSize: 48px per row                                   │    │
│  │  - overscan: 10 items above/below viewport                      │    │
│  │  - absolute positioning with transform                          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

> "Virtualization is essential for folders with thousands of files. Without it, rendering 5000 rows would create 5000 DOM nodes. With virtualization, we render only ~30 visible rows plus 10 overscan, keeping the DOM lean regardless of folder size."

---

## Deep Dive: Drag and Drop Upload

### DropZone Behavior

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        DropZone Component                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Normal State (children rendered)                                        │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                                                                  │    │
│  │     [Normal file browser content]                                │    │
│  │                                                                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Dragging State (overlay appears)                                        │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  ╔═══════════════════════════════════════════════════════════╗  │    │
│  │  ║                                                           ║  │    │
│  │  ║     bg-blue-500/10 border-dashed border-blue-500         ║  │    │
│  │  ║                                                           ║  │    │
│  │  ║              ┌─────────────────────────┐                  ║  │    │
│  │  ║              │     [Upload Icon]       │                  ║  │    │
│  │  ║              │  "Drop files to upload" │                  ║  │    │
│  │  ║              │  "Files will be added   │                  ║  │    │
│  │  ║              │   to current folder"    │                  ║  │    │
│  │  ║              └─────────────────────────┘                  ║  │    │
│  │  ║                                                           ║  │    │
│  │  ╚═══════════════════════════════════════════════════════════╝  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Event Handling:                                                         │
│  ├── dragenter: increment counter, show overlay if Files type           │
│  ├── dragleave: decrement counter, hide overlay when 0                  │
│  ├── dragover: preventDefault (required for drop)                       │
│  └── drop: reset counter, process files/folders                         │
│                                                                          │
│  Folder Upload (webkitGetAsEntry):                                       │
│  ├── Check if entry.isDirectory                                         │
│  ├── Recursively read directory entries                                 │
│  └── Preserve folder structure in upload paths                          │
└─────────────────────────────────────────────────────────────────────────┘
```

> "The drag counter pattern is crucial for nested elements. Without it, dragleave fires when hovering over child elements, causing the overlay to flicker. By counting enter/leave pairs, we only hide the overlay when truly leaving the drop zone."

---

## Deep Dive: Real-Time Sync with WebSocket

### Sync Service Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SyncService Class                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐                                                    │
│  │ WebSocket       │  ws = new WebSocket('/api/v1/sync/ws')             │
│  │ Connection      │                                                    │
│  └────────┬────────┘                                                    │
│           │                                                              │
│           ├── onopen ──▶ log "connected", reset reconnect attempts      │
│           │                                                              │
│           ├── onmessage ──▶ parse JSON ──▶ handleSyncMessage()          │
│           │                                                              │
│           ├── onclose ──▶ handleDisconnect() ──▶ exponential backoff    │
│           │                                                              │
│           └── onerror ──▶ log error                                     │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│  handleSyncMessage(event)                                                │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  switch (event.type):                                           │    │
│  │    'file_created' ──┐                                           │    │
│  │    'file_updated' ──┼──▶ if folderId === currentFolder:        │    │
│  │    'file_deleted' ──┘       refreshCurrentFolder()              │    │
│  │                             showSyncNotification(event)         │    │
│  │                                                                  │    │
│  │    'sync_conflict' ──▶ showConflictDialog(event)                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│  Reconnection Strategy                                                   │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  attempts < maxAttempts (5)?                                    │    │
│  │    ├── Yes: delay = 2^attempts * 1000ms (exponential backoff)   │    │
│  │    │        setTimeout(connect, delay)                          │    │
│  │    └── No:  stop trying, show "Offline" indicator               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Sync Notification Toast

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Sync Notification (appears bottom-right)                                │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [Cloud Icon]  "report.pdf modified"                              │  │
│  │                "Synced from another device"                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Action text by event type:                                              │
│  - file_created ──▶ "added"                                             │
│  - file_updated ──▶ "modified"                                          │
│  - file_deleted ──▶ "deleted"                                           │
│  - folder_created ──▶ "created folder"                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Share Dialog

### Share Modal Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Share Modal (centered, max-w-md)                                        │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Share "filename.pdf"                                      [X]    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Before Link Created:                                                    │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Password protection                                              │  │
│  │  [                    ] Optional password                         │  │
│  │                                                                   │  │
│  │  Link expiration                                                  │  │
│  │  [Never expires      v]                                          │  │
│  │    - Never expires                                                │  │
│  │    - 1 day                                                        │  │
│  │    - 7 days                                                       │  │
│  │    - 30 days                                                      │  │
│  │                                                                   │  │
│  │  [        Create share link        ]                              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  After Link Created:                                                     │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Share link                                                       │  │
│  │  ┌─────────────────────────────────────────┐ ┌──────────────┐    │  │
│  │  │ https://drop.box/s/abc123...            │ │    Copy      │    │  │
│  │  └─────────────────────────────────────────┘ └──────────────┘    │  │
│  │                                                                   │  │
│  │  "Link copied to clipboard" (toast on copy)                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Accessibility (a11y)

### Keyboard Navigation

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Keyboard Navigation Hook                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Key Bindings:                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  ArrowDown  ──▶ Select next item (Shift: extend selection)      │    │
│  │  ArrowUp    ──▶ Select previous item (Shift: extend selection)  │    │
│  │  Enter      ──▶ Open folder or preview file                     │    │
│  │  Delete     ──▶ Delete selected items                           │    │
│  │  Backspace  ──▶ Delete selected items                           │    │
│  │  Ctrl/Cmd+A ──▶ Select all items                                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│  Screen Reader Support                                                   │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  <main role="application" aria-label="File browser">            │    │
│  │    <nav aria-label="Breadcrumb navigation">                     │    │
│  │      <ol> ... aria-current="page" on last item </ol>            │    │
│  │    </nav>                                                        │    │
│  │    <div role="grid" aria-label="N items in folder">             │    │
│  │      <div role="row" aria-rowindex="1" aria-selected="true">    │    │
│  │        <div role="gridcell">filename</div>                      │    │
│  │      </div>                                                      │    │
│  │    </div>                                                        │    │
│  │  </main>                                                         │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

> "Accessibility is critical for a file manager. Users rely on keyboard shortcuts for efficiency, and screen reader users need proper ARIA roles to understand the file hierarchy. The grid role is more appropriate than listbox because we have multiple columns of information."

---

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Zustand over Redux | Minimal boilerplate, simple API | Less ecosystem, smaller community |
| Web Crypto API for hashing | Native, no dependencies | Browser support varies (older browsers) |
| Client-side chunk hashing | Enables deduplication | CPU-intensive for large files |
| WebSocket for sync | Real-time updates | Connection management complexity |
| Virtualized list | Handles 1000s of files | Added complexity, harder to style |
| Grid + List views | User preference flexibility | Two implementations to maintain |

---

## Future Frontend Enhancements

1. **Web Worker Hashing**: Move chunk hashing to worker thread to avoid blocking UI
2. **IndexedDB Caching**: Offline file browser with cached metadata and thumbnails
3. **File Previews**: In-browser preview for images, PDFs, videos, text files
4. **Bulk Operations**: Multi-select move, copy, delete with unified progress indicator
5. **Search**: Full-text search with filters (type, date, size) and faceted navigation
6. **Mobile App**: React Native with shared business logic and offline-first sync
