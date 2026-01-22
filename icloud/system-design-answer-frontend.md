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
+---------------------------------------------------------------+
|                     Frontend Application                       |
+---------------------------------------------------------------+
|                                                               |
|  +-------------------+  +-------------------+  +-------------+|
|  |   File Browser    |  |   Photo Gallery   |  | Admin Panel ||
|  |   - Tree view     |  |   - Grid view     |  | - Storage   ||
|  |   - List view     |  |   - Lightbox      |  | - Devices   ||
|  |   - Upload/DL     |  |   - Albums        |  | - Sharing   ||
|  +-------------------+  +-------------------+  +-------------+|
|                                                               |
|  +-----------------------------------------------------------+|
|  |                    State Management                        ||
|  | +---------------+  +--------------+  +------------------+ ||
|  | | File Store    |  | Photo Store  |  | Sync State Store | ||
|  | | - Files tree  |  | - Library    |  | - Pending ops    | ||
|  | | - Selection   |  | - Albums     |  | - Conflicts      | ||
|  | | - Operations  |  | - Viewer     |  | - Device status  | ||
|  | +---------------+  +--------------+  +------------------+ ||
|  +-----------------------------------------------------------+|
|                                                               |
|  +-----------------------------------------------------------+|
|  |                  Service Layer                             ||
|  | +-------------+  +----------------+  +------------------+ ||
|  | | Sync Engine |  | Offline Queue  |  | WebSocket Client | ||
|  | +-------------+  +----------------+  +------------------+ ||
|  +-----------------------------------------------------------+|
|                                                               |
|  +-----------------------------------------------------------+|
|  |                  Persistence Layer                         ||
|  |     IndexedDB (files, photos, pending operations)          ||
|  +-----------------------------------------------------------+|
|                                                               |
+---------------------------------------------------------------+
                              |
                              v
+---------------------------------------------------------------+
|                       Backend API                              |
+---------------------------------------------------------------+
```

### Component Structure

```
frontend/src/components/
+-- admin/                     # Admin dashboard components
|   +-- OverviewTab.tsx        # System statistics
|   +-- OperationsTab.tsx      # Sync operations table
|   +-- ConflictsTab.tsx       # Conflict management
|   +-- UsersTab.tsx           # User administration
|
+-- common/                    # Shared UI primitives
|   +-- StatCard.tsx           # Metric display cards
|   +-- LoadingSpinner.tsx     # Loading indicators
|   +-- Modal.tsx              # Dialog wrapper
|   +-- ModalActions.tsx       # Cancel/confirm buttons
|
+-- files/                     # File browser components
|   +-- FileItemComponent.tsx  # Single file/folder row
|   +-- FileToolbar.tsx        # Breadcrumb and actions
|   +-- FileList.tsx           # File listing container
|   +-- FileStatusBanners.tsx  # Sync status banners
|   +-- NewFolderModal.tsx     # Folder creation
|   +-- SelectionBar.tsx       # Selection count
|   +-- DragOverlay.tsx        # Drop zone indicator
|
+-- photos/                    # Photo gallery components
|   +-- PhotoItem.tsx          # Single photo thumbnail
|   +-- PhotoViewer.tsx        # Full-screen lightbox
|   +-- PhotoToolbar.tsx       # Filter controls
|   +-- PhotoGrid.tsx          # Virtualized grid
|   +-- CreateAlbumModal.tsx   # Album creation
|
+-- FileBrowser.tsx            # Main file browser
+-- PhotoGallery.tsx           # Main photo gallery
+-- AdminDashboard.tsx         # Admin page
```

## Deep Dive: Sync State Management (10 minutes)

The sync state is the most complex part of the frontend. We need to track file status, pending operations, and conflicts.

### Zustand Store Architecture

```typescript
// stores/fileStore.ts
interface FileItem {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'folder';
  size: number;
  version: Record<string, number>;  // Version vector
  syncStatus: 'synced' | 'pending' | 'syncing' | 'conflict' | 'error';
  localModified?: Date;
  serverModified?: Date;
}

interface PendingOperation {
  id: string;
  type: 'upload' | 'download' | 'delete' | 'rename' | 'move';
  fileId: string;
  payload: unknown;
  createdAt: Date;
  retries: number;
}

interface FileStore {
  // State
  files: Map<string, FileItem>;
  currentPath: string;
  selectedIds: Set<string>;
  pendingOperations: PendingOperation[];
  conflicts: ConflictInfo[];
  isOnline: boolean;

  // Actions
  navigateTo: (path: string) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;

  // Sync actions
  uploadFile: (file: File, path: string) => Promise<void>;
  downloadFile: (fileId: string) => Promise<Blob>;
  deleteFile: (fileId: string) => Promise<void>;
  resolveConflict: (conflictId: string, resolution: 'local' | 'server' | 'both') => Promise<void>;

  // Offline support
  queueOperation: (op: Omit<PendingOperation, 'id' | 'createdAt' | 'retries'>) => void;
  processPendingQueue: () => Promise<void>;
}

export const useFileStore = create<FileStore>()(
  persist(
    (set, get) => ({
      files: new Map(),
      currentPath: '/',
      selectedIds: new Set(),
      pendingOperations: [],
      conflicts: [],
      isOnline: navigator.onLine,

      navigateTo: (path) => {
        set({ currentPath: path, selectedIds: new Set() });
        get().fetchFiles(path);
      },

      uploadFile: async (file, path) => {
        const tempId = `temp-${Date.now()}`;

        // Optimistic update
        set((state) => ({
          files: new Map(state.files).set(tempId, {
            id: tempId,
            name: file.name,
            path: `${path}/${file.name}`,
            type: 'file',
            size: file.size,
            version: {},
            syncStatus: 'pending',
            localModified: new Date()
          })
        }));

        if (!get().isOnline) {
          get().queueOperation({ type: 'upload', fileId: tempId, payload: file });
          return;
        }

        set((state) => ({
          files: new Map(state.files).set(tempId, {
            ...state.files.get(tempId)!,
            syncStatus: 'syncing'
          })
        }));

        try {
          const result = await api.uploadFile(file, path);

          set((state) => {
            const files = new Map(state.files);
            files.delete(tempId);
            files.set(result.id, {
              ...result,
              syncStatus: 'synced'
            });
            return { files };
          });
        } catch (error) {
          set((state) => ({
            files: new Map(state.files).set(tempId, {
              ...state.files.get(tempId)!,
              syncStatus: 'error'
            })
          }));
          get().queueOperation({ type: 'upload', fileId: tempId, payload: file });
        }
      },

      queueOperation: (op) => {
        set((state) => ({
          pendingOperations: [
            ...state.pendingOperations,
            {
              ...op,
              id: `op-${Date.now()}`,
              createdAt: new Date(),
              retries: 0
            }
          ]
        }));
      },

      processPendingQueue: async () => {
        const { pendingOperations, isOnline } = get();
        if (!isOnline || pendingOperations.length === 0) return;

        for (const op of pendingOperations) {
          try {
            await get().executeOperation(op);
            set((state) => ({
              pendingOperations: state.pendingOperations.filter(o => o.id !== op.id)
            }));
          } catch (error) {
            if (op.retries < 3) {
              set((state) => ({
                pendingOperations: state.pendingOperations.map(o =>
                  o.id === op.id ? { ...o, retries: o.retries + 1 } : o
                )
              }));
            }
          }
        }
      }
    }),
    {
      name: 'icloud-files',
      storage: createJSONStorage(() => localforage),
      partialize: (state) => ({
        files: Array.from(state.files.entries()),
        pendingOperations: state.pendingOperations
      })
    }
  )
);
```

### File Status Component

```typescript
// components/files/FileStatusBanners.tsx
interface FileStatusBannersProps {
  pendingCount: number;
  conflictCount: number;
  errorCount: number;
  isOnline: boolean;
  onResolveConflicts: () => void;
  onRetryErrors: () => void;
}

export const FileStatusBanners: React.FC<FileStatusBannersProps> = ({
  pendingCount,
  conflictCount,
  errorCount,
  isOnline,
  onResolveConflicts,
  onRetryErrors
}) => {
  return (
    <div className="space-y-2 mb-4">
      {!isOnline && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-center gap-3">
          <CloudOff className="w-5 h-5 text-amber-600" />
          <div className="flex-1">
            <p className="text-amber-800 font-medium">You're offline</p>
            <p className="text-amber-600 text-sm">
              Changes will sync when you're back online
            </p>
          </div>
          {pendingCount > 0 && (
            <span className="bg-amber-200 text-amber-800 px-2 py-1 rounded text-sm">
              {pendingCount} pending
            </span>
          )}
        </div>
      )}

      {conflictCount > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600" />
          <div className="flex-1">
            <p className="text-red-800 font-medium">
              {conflictCount} conflict{conflictCount > 1 ? 's' : ''} detected
            </p>
            <p className="text-red-600 text-sm">
              Same file was edited on multiple devices
            </p>
          </div>
          <button
            onClick={onResolveConflicts}
            className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700"
          >
            Resolve
          </button>
        </div>
      )}

      {isOnline && pendingCount > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center gap-3">
          <RefreshCw className="w-5 h-5 text-blue-600 animate-spin" />
          <p className="text-blue-800">
            Syncing {pendingCount} file{pendingCount > 1 ? 's' : ''}...
          </p>
        </div>
      )}

      {errorCount > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-3">
          <XCircle className="w-5 h-5 text-red-600" />
          <div className="flex-1">
            <p className="text-red-800 font-medium">
              {errorCount} file{errorCount > 1 ? 's' : ''} failed to sync
            </p>
          </div>
          <button
            onClick={onRetryErrors}
            className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
};
```

### Sync Status Indicator

```typescript
// components/files/SyncStatusIcon.tsx
interface SyncStatusIconProps {
  status: FileItem['syncStatus'];
  className?: string;
}

export const SyncStatusIcon: React.FC<SyncStatusIconProps> = ({ status, className }) => {
  const iconClasses = cn('w-4 h-4', className);

  switch (status) {
    case 'synced':
      return <CheckCircle className={cn(iconClasses, 'text-green-500')} />;
    case 'pending':
      return <Clock className={cn(iconClasses, 'text-amber-500')} />;
    case 'syncing':
      return <RefreshCw className={cn(iconClasses, 'text-blue-500 animate-spin')} />;
    case 'conflict':
      return <AlertTriangle className={cn(iconClasses, 'text-red-500')} />;
    case 'error':
      return <XCircle className={cn(iconClasses, 'text-red-500')} />;
    default:
      return null;
  }
};
```

## Deep Dive: Photo Gallery with Virtualization (10 minutes)

The photo gallery must handle thousands of images efficiently using row-based virtualization.

### Why Row-Based Virtualization

Unlike single-item virtualization, we virtualize rows containing multiple photos:
- Grid layout requires consistent column structure
- Virtualizing rows maintains grid alignment
- Simpler CSS layout (grid within each virtualized row)

### PhotoGrid Implementation

```typescript
// components/photos/PhotoGrid.tsx
import { useVirtualizer } from '@tanstack/react-virtual';

const COLUMNS = 4;
const ITEM_HEIGHT = 200;
const GAP = 8;

interface PhotoGridProps {
  photos: Photo[];
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onPhotoClick: (photo: Photo) => void;
  onLoadMore?: () => void;
}

export const PhotoGrid: React.FC<PhotoGridProps> = ({
  photos,
  selectedIds,
  onToggleSelection,
  onPhotoClick,
  onLoadMore
}) => {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowCount = Math.ceil(photos.length / COLUMNS);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ITEM_HEIGHT + GAP,
    overscan: 2, // 2 extra rows = 8 extra photos
  });

  // Infinite scroll detection
  const handleScroll = useCallback(() => {
    if (!parentRef.current || !onLoadMore) return;

    const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
    if (scrollHeight - scrollTop - clientHeight < 300) {
      onLoadMore();
    }
  }, [onLoadMore]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      style={{ contain: 'strict' }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualRows.map((virtualRow) => {
          const startIndex = virtualRow.index * COLUMNS;
          const rowPhotos = photos.slice(startIndex, startIndex + COLUMNS);

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: ITEM_HEIGHT,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className="grid grid-cols-4 gap-2 px-2"
            >
              {rowPhotos.map((photo) => (
                <PhotoItem
                  key={photo.id}
                  photo={photo}
                  isSelected={selectedIds.has(photo.id)}
                  onToggleSelection={() => onToggleSelection(photo.id)}
                  onClick={() => onPhotoClick(photo)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};
```

### PhotoItem with Lazy Loading

```typescript
// components/photos/PhotoItem.tsx
interface PhotoItemProps {
  photo: Photo;
  isSelected: boolean;
  onToggleSelection: () => void;
  onClick: () => void;
}

export const PhotoItem: React.FC<PhotoItemProps> = ({
  photo,
  isSelected,
  onToggleSelection,
  onClick
}) => {
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Intersection Observer for lazy loading
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            img.src = photo.thumbnailUrl;
            observer.unobserve(img);
          }
        });
      },
      { rootMargin: '100px' }
    );

    observer.observe(img);
    return () => observer.disconnect();
  }, [photo.thumbnailUrl]);

  return (
    <div
      className={cn(
        'relative aspect-square rounded-lg overflow-hidden cursor-pointer',
        'bg-gray-100 transition-all',
        isSelected && 'ring-2 ring-blue-500 ring-offset-2'
      )}
      onClick={onClick}
    >
      <img
        ref={imgRef}
        alt={photo.filename}
        className={cn(
          'w-full h-full object-cover transition-opacity',
          loaded ? 'opacity-100' : 'opacity-0'
        )}
        onLoad={() => setLoaded(true)}
      />

      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
        </div>
      )}

      {/* Selection checkbox */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelection();
        }}
        className={cn(
          'absolute top-2 left-2 w-6 h-6 rounded-full border-2',
          'flex items-center justify-center transition-all',
          isSelected
            ? 'bg-blue-500 border-blue-500 text-white'
            : 'bg-white/80 border-gray-300 hover:border-blue-500'
        )}
      >
        {isSelected && <Check className="w-4 h-4" />}
      </button>

      {/* Sync status indicator */}
      {photo.syncStatus !== 'synced' && (
        <div className="absolute bottom-2 right-2">
          <SyncStatusIcon status={photo.syncStatus} />
        </div>
      )}
    </div>
  );
};
```

### Virtualization Performance Impact

| Metric | Without Virtualization | With Virtualization |
|--------|------------------------|---------------------|
| DOM nodes (1000 photos) | 4000+ | ~80 |
| Memory usage | 400MB+ | 80MB |
| Initial render | 2+ seconds | <200ms |
| Scroll FPS | Degrades with size | Constant 60fps |

## Deep Dive: Offline Support (8 minutes)

### IndexedDB Persistence

```typescript
// services/offlineStorage.ts
import { openDB, DBSchema } from 'idb';

interface ICloudDB extends DBSchema {
  files: {
    key: string;
    value: FileItem;
    indexes: { 'by-path': string };
  };
  photos: {
    key: string;
    value: Photo;
    indexes: { 'by-date': Date };
  };
  pendingOps: {
    key: string;
    value: PendingOperation;
  };
  thumbnails: {
    key: string;
    value: Blob;
  };
}

const dbPromise = openDB<ICloudDB>('icloud-cache', 1, {
  upgrade(db) {
    const fileStore = db.createObjectStore('files', { keyPath: 'id' });
    fileStore.createIndex('by-path', 'path');

    const photoStore = db.createObjectStore('photos', { keyPath: 'id' });
    photoStore.createIndex('by-date', 'takenAt');

    db.createObjectStore('pendingOps', { keyPath: 'id' });
    db.createObjectStore('thumbnails');
  },
});

export const offlineStorage = {
  async getFiles(path: string): Promise<FileItem[]> {
    const db = await dbPromise;
    const all = await db.getAll('files');
    return all.filter(f => f.path.startsWith(path) && f.path !== path);
  },

  async saveFile(file: FileItem): Promise<void> {
    const db = await dbPromise;
    await db.put('files', file);
  },

  async saveThumbnail(photoId: string, blob: Blob): Promise<void> {
    const db = await dbPromise;
    await db.put('thumbnails', blob, photoId);
  },

  async getThumbnail(photoId: string): Promise<Blob | undefined> {
    const db = await dbPromise;
    return db.get('thumbnails', photoId);
  },

  async queueOperation(op: PendingOperation): Promise<void> {
    const db = await dbPromise;
    await db.put('pendingOps', op);
  },

  async getPendingOperations(): Promise<PendingOperation[]> {
    const db = await dbPromise;
    return db.getAll('pendingOps');
  },

  async removeOperation(id: string): Promise<void> {
    const db = await dbPromise;
    await db.delete('pendingOps', id);
  }
};
```

### Online/Offline Detection

```typescript
// hooks/useOnlineStatus.ts
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const { processPendingQueue } = useFileStore();

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // Process pending operations when back online
      processPendingQueue();
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [processPendingQueue]);

  return isOnline;
}
```

### Service Worker for Thumbnail Caching

```typescript
// sw.ts
const THUMBNAIL_CACHE = 'thumbnails-v1';

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Cache thumbnail requests
  if (url.pathname.includes('/thumbnails/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;

        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(THUMBNAIL_CACHE).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        });
      })
    );
  }
});
```

## Deep Dive: Conflict Resolution UI (5 minutes)

### Conflict Resolution Modal

```typescript
// components/files/ConflictModal.tsx
interface ConflictInfo {
  id: string;
  fileId: string;
  fileName: string;
  localVersion: {
    modified: Date;
    device: string;
    size: number;
  };
  serverVersion: {
    modified: Date;
    device: string;
    size: number;
  };
}

interface ConflictModalProps {
  conflict: ConflictInfo;
  onResolve: (resolution: 'local' | 'server' | 'both') => void;
  onClose: () => void;
}

export const ConflictModal: React.FC<ConflictModalProps> = ({
  conflict,
  onResolve,
  onClose
}) => {
  return (
    <Modal title="Resolve Conflict" onClose={onClose}>
      <div className="space-y-6">
        <div className="bg-amber-50 p-4 rounded-lg">
          <p className="text-amber-800">
            <span className="font-semibold">{conflict.fileName}</span> was edited
            on multiple devices. Choose which version to keep.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Local version */}
          <button
            onClick={() => onResolve('local')}
            className="p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 transition-colors text-left"
          >
            <div className="flex items-center gap-2 mb-2">
              <Laptop className="w-5 h-5 text-gray-600" />
              <span className="font-medium">This device</span>
            </div>
            <p className="text-sm text-gray-600">
              {conflict.localVersion.device}
            </p>
            <p className="text-sm text-gray-500">
              Modified {formatDistanceToNow(conflict.localVersion.modified)} ago
            </p>
            <p className="text-sm text-gray-500">
              {formatBytes(conflict.localVersion.size)}
            </p>
          </button>

          {/* Server version */}
          <button
            onClick={() => onResolve('server')}
            className="p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 transition-colors text-left"
          >
            <div className="flex items-center gap-2 mb-2">
              <Cloud className="w-5 h-5 text-gray-600" />
              <span className="font-medium">iCloud</span>
            </div>
            <p className="text-sm text-gray-600">
              {conflict.serverVersion.device}
            </p>
            <p className="text-sm text-gray-500">
              Modified {formatDistanceToNow(conflict.serverVersion.modified)} ago
            </p>
            <p className="text-sm text-gray-500">
              {formatBytes(conflict.serverVersion.size)}
            </p>
          </button>
        </div>

        <button
          onClick={() => onResolve('both')}
          className="w-full p-3 border-2 border-gray-200 rounded-lg hover:border-blue-500 transition-colors text-center"
        >
          <Copy className="w-5 h-5 inline-block mr-2" />
          Keep both versions
        </button>
      </div>
    </Modal>
  );
};
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
