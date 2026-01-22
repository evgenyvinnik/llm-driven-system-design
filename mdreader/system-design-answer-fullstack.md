# MD Reader - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Problem Statement

Design MD Reader, a Progressive Web App for editing and previewing Markdown. The full-stack challenge focuses on client-side architecture integration, data flow from editor to persistence, PWA service worker coordination, and future cloud sync preparation.

## Requirements Clarification

### Functional Requirements
- **Unified Editor Experience**: Monaco Editor with live preview
- **Seamless Persistence**: Auto-save with offline support
- **Document Lifecycle**: Create, read, update, delete across sessions
- **Cross-Platform PWA**: Install and work offline on any device

### Non-Functional Requirements
- **Latency**: Preview updates within 150ms, saves within 500ms
- **Durability**: Zero data loss across crashes and updates
- **Consistency**: Read-your-writes guarantee within session
- **Installability**: Lighthouse PWA score of 100

### Scale Estimates
- **Documents**: 100 documents per user, average 10KB each
- **Session Length**: 30-120 minutes active editing
- **Writes**: Up to 30 auto-saves per minute during active editing

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Browser (PWA)                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                         React Application                             │  │
│   ├───────────────────┬──────────────────────┬───────────────────────────┤  │
│   │    Editor Layer   │    State Layer       │    Persistence Layer      │  │
│   │  ┌─────────────┐  │  ┌────────────────┐  │  ┌─────────────────────┐  │  │
│   │  │   Monaco    │──┼─▶│    Zustand     │──┼─▶│   IndexedDB        │  │  │
│   │  │   Editor    │  │  │   Document     │  │  │   Repository        │  │  │
│   │  └─────────────┘  │  │    Store       │  │  └──────────┬──────────┘  │  │
│   │                   │  └────────┬───────┘  │             │             │  │
│   │  ┌─────────────┐  │           │          │  ┌──────────▼──────────┐  │  │
│   │  │   Preview   │◀─┼───────────┘          │  │    localStorage     │  │  │
│   │  │   Renderer  │  │                      │  │     (Fallback)      │  │  │
│   │  └─────────────┘  │                      │  └─────────────────────┘  │  │
│   └───────────────────┴──────────────────────┴───────────────────────────┘  │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                           Service Worker (Workbox)                           │
│   ┌────────────────┐  ┌───────────────────┐  ┌───────────────────────────┐  │
│   │  App Shell     │  │  Runtime Cache    │  │  Background Sync Queue   │  │
│   │  (Precached)   │  │  (Fonts, CDN)     │  │  (Future Cloud Sync)     │  │
│   └────────────────┘  └───────────────────┘  └───────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Deep Dives

### 1. Unified Type System

**Shared Types Across Layers:**

```typescript
// types/document.ts - Used by all layers

export interface Document {
  id: string;                 // UUID v4
  title: string;              // Auto-generated from first line
  content: string;            // Raw markdown
  createdAt: number;          // Unix timestamp ms
  updatedAt: number;          // Unix timestamp ms
  checksum?: string;          // SHA-256 for integrity
  syncStatus?: SyncStatus;    // For future cloud sync
}

export interface DocumentMeta {
  id: string;
  title: string;
  updatedAt: number;
  preview?: string;           // First 100 chars for search
}

export type SyncStatus = 'synced' | 'pending' | 'conflict' | 'error';

// View layer types
export type ViewMode = 'editor' | 'preview' | 'split';

export interface EditorState {
  content: string;
  cursorPosition: { line: number; column: number };
  scrollTop: number;
  selection?: { start: number; end: number };
}

// Persistence layer types
export interface SaveOperation {
  documentId: string;
  content: string;
  timestamp: number;
  operationType: 'create' | 'update' | 'delete';
}

export interface StorageQuota {
  used: number;
  available: number;
  documents: number;
}
```

### 2. End-to-End Data Flow

**Document Lifecycle Management:**

```typescript
// hooks/useDocument.ts - Coordinates all layers

export function useDocument(documentId: string | null) {
  const store = useDocumentStore();
  const db = useIndexedDB();

  // Load document on mount or ID change
  useEffect(() => {
    if (!documentId) {
      store.setCurrentDocument(null);
      return;
    }

    const loadDocument = async () => {
      store.setLoading(true);

      try {
        // Try IndexedDB first
        let doc = await db.documents.get(documentId);

        // Fallback to localStorage
        if (!doc) {
          const backup = localStorage.getItem(`doc-backup-${documentId}`);
          if (backup) {
            doc = JSON.parse(backup);
            // Restore to IndexedDB
            await db.documents.put(doc);
          }
        }

        if (doc) {
          store.setCurrentDocument(doc);
        } else {
          store.setError(new Error('Document not found'));
        }
      } catch (error) {
        store.setError(error as Error);
      } finally {
        store.setLoading(false);
      }
    };

    loadDocument();
  }, [documentId]);

  // Auto-save with debouncing and dual-write
  const saveDocument = useCallback(
    debounce(async (content: string) => {
      if (!store.currentDocument) return;

      const updated: Document = {
        ...store.currentDocument,
        content,
        title: extractTitle(content),
        updatedAt: Date.now(),
        checksum: await computeChecksum(content),
      };

      try {
        // Primary: IndexedDB
        await db.documents.put(updated);

        // Backup: localStorage (for crash recovery)
        localStorage.setItem(
          `doc-backup-${updated.id}`,
          JSON.stringify(updated)
        );

        store.setCurrentDocument(updated);
        store.setSaveStatus('saved');
      } catch (error) {
        if ((error as Error).name === 'QuotaExceededError') {
          store.setSaveStatus('quota-exceeded');
        } else {
          store.setSaveStatus('error');
        }
      }
    }, 500),
    [store.currentDocument]
  );

  return {
    document: store.currentDocument,
    isLoading: store.isLoading,
    error: store.error,
    saveStatus: store.saveStatus,
    updateContent: (content: string) => {
      store.updateContent(content);
      saveDocument(content);
    },
    createDocument: () => createNewDocument(db, store),
    deleteDocument: (id: string) => deleteDocument(db, store, id),
  };
}
```

**Content Update Flow:**

```
┌────────────┐     ┌──────────────┐     ┌────────────────┐     ┌────────────┐
│   Monaco   │────▶│  Zustand     │────▶│   Debounce     │────▶│ IndexedDB  │
│   Editor   │     │  Store       │     │   (500ms)      │     │   Write    │
└────────────┘     └──────┬───────┘     └────────────────┘     └──────┬─────┘
                          │                                           │
                          ▼                                           ▼
                   ┌──────────────┐                           ┌──────────────┐
                   │  Preview     │                           │ localStorage │
                   │  (150ms)     │                           │   Backup     │
                   └──────────────┘                           └──────────────┘
```

### 3. State Management Architecture

**Zustand Store with Persistence:**

```typescript
// store/documentStore.ts

interface DocumentStore {
  // State
  documents: DocumentMeta[];
  currentDocument: Document | null;
  isLoading: boolean;
  error: Error | null;
  saveStatus: SaveStatus;

  // Actions
  setDocuments: (docs: DocumentMeta[]) => void;
  setCurrentDocument: (doc: Document | null) => void;
  updateContent: (content: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: Error | null) => void;
  setSaveStatus: (status: SaveStatus) => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'quota-exceeded';

export const useDocumentStore = create<DocumentStore>()(
  subscribeWithSelector((set, get) => ({
    documents: [],
    currentDocument: null,
    isLoading: false,
    error: null,
    saveStatus: 'idle',

    setDocuments: (documents) => set({ documents }),

    setCurrentDocument: (currentDocument) =>
      set({ currentDocument, error: null }),

    updateContent: (content) => {
      const current = get().currentDocument;
      if (current) {
        set({
          currentDocument: { ...current, content },
          saveStatus: 'saving',
        });
      }
    },

    setLoading: (isLoading) => set({ isLoading }),
    setError: (error) => set({ error, isLoading: false }),
    setSaveStatus: (saveStatus) => set({ saveStatus }),
  }))
);

// Selector for derived state
export const useDocumentList = () =>
  useDocumentStore((state) =>
    [...state.documents].sort((a, b) => b.updatedAt - a.updatedAt)
  );

export const useCurrentContent = () =>
  useDocumentStore((state) => state.currentDocument?.content ?? '');
```

**Preferences Store:**

```typescript
// store/preferencesStore.ts

interface PreferencesState {
  theme: 'light' | 'dark' | 'system';
  viewMode: ViewMode;
  editorWidth: number;
  scrollSync: boolean;
  fontSize: number;
  wordWrap: boolean;
}

interface PreferencesStore extends PreferencesState {
  setTheme: (theme: PreferencesState['theme']) => void;
  setViewMode: (mode: ViewMode) => void;
  setEditorWidth: (width: number) => void;
  toggleScrollSync: () => void;
  setFontSize: (size: number) => void;
  toggleWordWrap: () => void;
}

export const usePreferencesStore = create<PreferencesStore>()(
  persist(
    (set) => ({
      theme: 'system',
      viewMode: 'split',
      editorWidth: 50,
      scrollSync: true,
      fontSize: 14,
      wordWrap: true,

      setTheme: (theme) => set({ theme }),
      setViewMode: (viewMode) => set({ viewMode }),
      setEditorWidth: (editorWidth) => set({ editorWidth }),
      toggleScrollSync: () => set((s) => ({ scrollSync: !s.scrollSync })),
      setFontSize: (fontSize) => set({ fontSize }),
      toggleWordWrap: () => set((s) => ({ wordWrap: !s.wordWrap })),
    }),
    {
      name: 'mdreader-preferences',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
```

### 4. IndexedDB Repository Layer

**Database Schema and Access:**

```typescript
// db/database.ts

import { openDB, DBSchema, IDBPDatabase } from 'idb';

interface MDReaderDB extends DBSchema {
  documents: {
    key: string;
    value: Document;
    indexes: {
      'by-updated': number;
      'by-title': string;
    };
  };
  syncQueue: {
    key: string;
    value: SyncOperation;
    indexes: { 'by-timestamp': number };
  };
}

let dbInstance: IDBPDatabase<MDReaderDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<MDReaderDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<MDReaderDB>('mdreader', 1, {
    upgrade(db) {
      // Documents store
      const docStore = db.createObjectStore('documents', { keyPath: 'id' });
      docStore.createIndex('by-updated', 'updatedAt');
      docStore.createIndex('by-title', 'title');

      // Sync queue for future cloud sync
      const syncStore = db.createObjectStore('syncQueue', { keyPath: 'id' });
      syncStore.createIndex('by-timestamp', 'timestamp');
    },
  });

  return dbInstance;
}

// Repository pattern for documents
export const documentRepository = {
  async getAll(): Promise<DocumentMeta[]> {
    const db = await getDB();
    const docs = await db.getAllFromIndex('documents', 'by-updated');
    return docs.reverse().map((d) => ({
      id: d.id,
      title: d.title,
      updatedAt: d.updatedAt,
      preview: d.content.slice(0, 100),
    }));
  },

  async getById(id: string): Promise<Document | undefined> {
    const db = await getDB();
    return db.get('documents', id);
  },

  async save(doc: Document): Promise<void> {
    const db = await getDB();
    await db.put('documents', doc);
  },

  async delete(id: string): Promise<void> {
    const db = await getDB();
    await db.delete('documents', id);
  },

  async search(query: string): Promise<DocumentMeta[]> {
    const db = await getDB();
    const all = await db.getAll('documents');
    const lower = query.toLowerCase();
    return all
      .filter(
        (d) =>
          d.title.toLowerCase().includes(lower) ||
          d.content.toLowerCase().includes(lower)
      )
      .map((d) => ({
        id: d.id,
        title: d.title,
        updatedAt: d.updatedAt,
        preview: d.content.slice(0, 100),
      }));
  },

  async getStorageStats(): Promise<StorageQuota> {
    const db = await getDB();
    const docs = await db.getAll('documents');
    const used = docs.reduce(
      (sum, d) => sum + new Blob([JSON.stringify(d)]).size,
      0
    );

    // Estimate available (50MB default quota)
    const estimate = await navigator.storage?.estimate?.();
    const available = estimate?.quota ?? 50 * 1024 * 1024;

    return { used, available, documents: docs.length };
  },
};
```

### 5. Service Worker Integration

**Workbox Configuration:**

```typescript
// service-worker.ts

import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import {
  CacheFirst,
  StaleWhileRevalidate,
  NetworkFirst,
} from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare const self: ServiceWorkerGlobalScope;

// Precache app shell
precacheAndRoute(self.__WB_MANIFEST);

// Google Fonts - Cache first with long expiration
registerRoute(
  /^https:\/\/fonts\.googleapis\.com/,
  new StaleWhileRevalidate({
    cacheName: 'google-fonts-stylesheets',
  })
);

registerRoute(
  /^https:\/\/fonts\.gstatic\.com/,
  new CacheFirst({
    cacheName: 'google-fonts-webfonts',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 30,
        maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
      }),
    ],
  })
);

// CDN resources (highlight.js, etc.)
registerRoute(
  /^https:\/\/cdnjs\.cloudflare\.com/,
  new CacheFirst({
    cacheName: 'cdn-resources',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 50,
        maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
      }),
    ],
  })
);

// Listen for skip waiting message
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Notify clients of update
self.addEventListener('install', () => {
  console.log('Service worker installed');
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Clean old caches
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => !key.startsWith('workbox-'))
            .map((key) => caches.delete(key))
        )
      ),
    ])
  );
});
```

**Update Detection and Notification:**

```tsx
// hooks/useServiceWorker.ts

export function useServiceWorker() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        setRegistration(reg);

        // Check for updates periodically
        const checkInterval = setInterval(() => {
          reg.update();
        }, 60 * 60 * 1000); // Every hour

        return () => clearInterval(checkInterval);
      });

      // Listen for new service worker
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      });
    }
  }, []);

  useEffect(() => {
    if (!registration) return;

    const handleUpdate = () => {
      if (registration.waiting) {
        setUpdateAvailable(true);
      }
    };

    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      newWorker?.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          setUpdateAvailable(true);
        }
      });
    });

    // Check if update is already waiting
    handleUpdate();
  }, [registration]);

  const applyUpdate = useCallback(() => {
    if (registration?.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  }, [registration]);

  return { updateAvailable, applyUpdate };
}

// Update banner component
const UpdateBanner: React.FC = () => {
  const { updateAvailable, applyUpdate } = useServiceWorker();

  if (!updateAvailable) return null;

  return (
    <div className={styles.updateBanner}>
      <p>A new version is available!</p>
      <button onClick={applyUpdate}>Update Now</button>
    </div>
  );
};
```

### 6. Error Handling and Recovery

**Global Error Boundary:**

```tsx
// components/ErrorBoundary.tsx

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Application error:', error, errorInfo);

    // Attempt recovery for storage errors
    if (error.name === 'QuotaExceededError') {
      this.handleStorageError();
    }
  }

  handleStorageError = async () => {
    // Prompt user to delete old documents
    const confirmed = window.confirm(
      'Storage is full. Would you like to delete old documents to make space?'
    );

    if (confirmed) {
      // Delete oldest documents
      const docs = await documentRepository.getAll();
      const oldest = docs.slice(-10); // Delete 10 oldest
      await Promise.all(oldest.map((d) => documentRepository.delete(d.id)));
      window.location.reload();
    }
  };

  handleRecovery = () => {
    // Try to recover from localStorage backup
    const currentDocId = localStorage.getItem('mdreader-current-doc');
    if (currentDocId) {
      const backup = localStorage.getItem(`doc-backup-${currentDocId}`);
      if (backup) {
        // Restore and reload
        documentRepository.save(JSON.parse(backup));
      }
    }
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className={styles.errorFallback}>
            <h1>Something went wrong</h1>
            <p>{this.state.error?.message}</p>
            <button onClick={this.handleRecovery}>Try to Recover</button>
            <button onClick={() => window.location.reload()}>Reload</button>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
```

**Storage Error Handling:**

```typescript
// utils/storageErrorHandler.ts

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: 'quota' | 'unavailable' | 'corruption'
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export async function withStorageRecovery<T>(
  operation: () => Promise<T>,
  fallback: () => T
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DOMException) {
      switch (error.name) {
        case 'QuotaExceededError':
          throw new StorageError('Storage quota exceeded', 'quota');

        case 'InvalidStateError':
        case 'UnknownError':
          // IndexedDB unavailable
          console.warn('IndexedDB unavailable, using fallback');
          return fallback();

        default:
          throw error;
      }
    }
    throw error;
  }
}

// Usage in document save
export async function saveWithFallback(doc: Document): Promise<void> {
  await withStorageRecovery(
    async () => {
      await documentRepository.save(doc);
    },
    () => {
      // Fallback to localStorage
      localStorage.setItem(`doc-${doc.id}`, JSON.stringify(doc));
    }
  );
}
```

### 7. Import/Export Integration

**File Import:**

```typescript
// utils/fileImport.ts

export async function importMarkdownFile(file: File): Promise<Document> {
  if (!file.name.endsWith('.md') && !file.name.endsWith('.markdown')) {
    throw new Error('Only .md or .markdown files are supported');
  }

  const content = await file.text();
  const checksum = await computeChecksum(content);

  // Check for duplicate
  const existing = await findDocumentByChecksum(checksum);
  if (existing) {
    const overwrite = window.confirm(
      'A document with the same content already exists. Overwrite?'
    );
    if (overwrite) {
      return {
        ...existing,
        content,
        updatedAt: Date.now(),
      };
    }
    throw new Error('Import cancelled - duplicate document');
  }

  return {
    id: crypto.randomUUID(),
    title: extractTitle(content) || file.name.replace(/\.md$/, ''),
    content,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    checksum,
  };
}

// Drag and drop handler
export function useFileDrop(onImport: (doc: Document) => void) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const mdFile = files.find(
      (f) => f.name.endsWith('.md') || f.name.endsWith('.markdown')
    );

    if (mdFile) {
      const doc = await importMarkdownFile(mdFile);
      await documentRepository.save(doc);
      onImport(doc);
    }
  };

  return { isDragging, handleDragEnter, handleDragLeave, handleDrop };
}
```

**File Export:**

```typescript
// utils/fileExport.ts

export function exportDocument(doc: Document, format: 'md' | 'html'): void {
  let content: string;
  let mimeType: string;
  let extension: string;

  if (format === 'md') {
    content = doc.content;
    mimeType = 'text/markdown';
    extension = 'md';
  } else {
    content = renderMarkdownToHtml(doc.content);
    mimeType = 'text/html';
    extension = 'html';
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const filename = `${sanitizeFilename(doc.title)}.${extension}`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
}

function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 100);
}

function renderMarkdownToHtml(content: string): string {
  const md = markdownIt({ html: false, linkify: true });
  const body = DOMPurify.sanitize(md.render(content));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Exported Document</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
    pre { background: #f4f4f4; padding: 16px; overflow-x: auto; }
    code { background: #f4f4f4; padding: 2px 4px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}
```

### 8. Future Cloud Sync Architecture

**Sync Queue for Offline-First:**

```typescript
// sync/syncQueue.ts

interface SyncOperation {
  id: string;
  documentId: string;
  operation: 'create' | 'update' | 'delete';
  timestamp: number;
  payload?: string;  // Compressed diff or full content
  retries: number;
}

export const syncQueue = {
  async enqueue(op: Omit<SyncOperation, 'id' | 'retries'>): Promise<void> {
    const db = await getDB();
    await db.put('syncQueue', {
      ...op,
      id: crypto.randomUUID(),
      retries: 0,
    });
  },

  async getAll(): Promise<SyncOperation[]> {
    const db = await getDB();
    return db.getAllFromIndex('syncQueue', 'by-timestamp');
  },

  async dequeue(id: string): Promise<void> {
    const db = await getDB();
    await db.delete('syncQueue', id);
  },

  async incrementRetry(id: string): Promise<void> {
    const db = await getDB();
    const op = await db.get('syncQueue', id);
    if (op) {
      op.retries += 1;
      await db.put('syncQueue', op);
    }
  },
};

// Background sync when online
export function useSyncManager() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<Error | null>(null);

  useEffect(() => {
    const handleOnline = async () => {
      setIsSyncing(true);
      try {
        const queue = await syncQueue.getAll();
        for (const op of queue) {
          if (op.retries >= 3) {
            // Move to dead letter queue
            continue;
          }

          try {
            await syncToCloud(op);
            await syncQueue.dequeue(op.id);
          } catch (error) {
            await syncQueue.incrementRetry(op.id);
          }
        }
      } catch (error) {
        setSyncError(error as Error);
      } finally {
        setIsSyncing(false);
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  return { isSyncing, syncError };
}
```

**Conflict Resolution UI:**

```tsx
// components/ConflictResolver.tsx

interface ConflictResolverProps {
  localDoc: Document;
  remoteDoc: Document;
  onResolve: (resolution: 'local' | 'remote' | 'merge') => void;
}

const ConflictResolver: React.FC<ConflictResolverProps> = ({
  localDoc,
  remoteDoc,
  onResolve,
}) => {
  const [mergedContent, setMergedContent] = useState('');

  // Compute diff for visualization
  const diff = useMemo(() => {
    return computeLineDiff(localDoc.content, remoteDoc.content);
  }, [localDoc, remoteDoc]);

  return (
    <div className={styles.conflictResolver}>
      <h2>Document Conflict Detected</h2>
      <p>This document was modified in multiple places.</p>

      <div className={styles.comparison}>
        <div className={styles.version}>
          <h3>Your Version</h3>
          <p className={styles.timestamp}>
            Modified: {formatDate(localDoc.updatedAt)}
          </p>
          <pre>{localDoc.content}</pre>
          <button onClick={() => onResolve('local')}>Keep Mine</button>
        </div>

        <div className={styles.version}>
          <h3>Cloud Version</h3>
          <p className={styles.timestamp}>
            Modified: {formatDate(remoteDoc.updatedAt)}
          </p>
          <pre>{remoteDoc.content}</pre>
          <button onClick={() => onResolve('remote')}>Keep Cloud</button>
        </div>
      </div>

      <div className={styles.merge}>
        <h3>Manual Merge</h3>
        <textarea
          value={mergedContent}
          onChange={(e) => setMergedContent(e.target.value)}
          placeholder="Paste or write your merged version..."
        />
        <button onClick={() => onResolve('merge')}>Use Merged</button>
      </div>
    </div>
  );
};
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux | Simpler API, built-in persistence middleware |
| Storage | IndexedDB + localStorage | localStorage only | Larger quota, async API, structured queries |
| Sync Strategy | Queue-based (future) | Real-time WebSocket | Works offline, handles conflicts gracefully |
| Service Worker | Workbox | Manual SW | Proven patterns, easier cache management |
| Type Sharing | Shared interfaces | GraphQL codegen | No backend yet, simpler setup |
| Error Recovery | Dual-write backup | Single storage | Zero data loss guarantee |

## Future Enhancements

1. **Cloud Sync**: Optional Google Drive or Dropbox integration with OAuth
2. **Collaborative Editing**: WebRTC with Yjs CRDT for real-time multi-user editing
3. **Version History**: Store document versions for undo/revert functionality
4. **Encryption**: Client-side encryption before cloud sync for privacy
5. **Cross-Tab Sync**: BroadcastChannel API for syncing state across browser tabs
6. **Background Sync**: Service Worker Background Sync API for guaranteed delivery
7. **Offline Analytics**: Queue analytics events and sync when online
8. **Progressive Enhancement**: Graceful degradation for browsers without IndexedDB
