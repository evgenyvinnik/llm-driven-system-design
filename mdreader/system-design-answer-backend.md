# MD Reader - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design MD Reader, a Progressive Web App for editing and previewing Markdown. While primarily client-side, the "backend" challenge focuses on client-side data layer architecture: IndexedDB persistence, service worker caching, data integrity, and designing for future server sync capabilities.

## Requirements Clarification

### Functional Requirements
- **Document Storage**: Create, read, update, delete documents locally
- **Auto-Save**: Persist changes automatically as user types
- **Offline Support**: Full functionality without network
- **Document Management**: Multiple documents with metadata

### Non-Functional Requirements
- **Durability**: Zero document loss - survives browser restarts
- **Latency**: Save operations < 100ms
- **Storage Capacity**: Support 100+ documents (50MB+)
- **Offline**: 100% functionality without internet

### Storage Estimates
- **Active Documents**: 50-100 per user
- **Document Size**: Avg 10KB, Max 500KB
- **Total Storage**: Up to 50MB per user

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Browser (PWA Container)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   Application Layer                      │   │
│   │              (React + Monaco Editor)                     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   State Layer (Zustand)                  │   │
│   │  - Current document                                      │   │
│   │  - Document list                                         │   │
│   │  - UI preferences                                        │   │
│   └─────────────────────────────────────────────────────────┘   │
│                             │                                    │
│           ┌─────────────────┴─────────────────┐                 │
│           ▼                                   ▼                 │
│   ┌───────────────────┐           ┌───────────────────┐         │
│   │    IndexedDB      │           │   localStorage    │         │
│   │  (Primary Store)  │           │    (Fallback)     │         │
│   │  - Documents      │           │  - Preferences    │         │
│   │  - Metadata       │           │  - Last doc ID    │         │
│   └───────────────────┘           └───────────────────┘         │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│              Service Worker (Workbox - Asset Caching)            │
│  - App shell cache (HTML, CSS, JS)                               │
│  - Runtime cache (fonts, icons)                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dives

### 1. IndexedDB Schema Design

**Database Schema:**

```typescript
// lib/db.ts
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
  preferences: {
    key: string;
    value: Preference;
  };
  syncQueue: {
    key: number;
    value: SyncOperation;
    indexes: {
      'by-status': string;
    };
  };
}

interface Document {
  id: string;           // UUID v4
  title: string;        // First 5 words of content
  content: string;      // Raw markdown
  createdAt: number;    // Unix timestamp
  updatedAt: number;    // Unix timestamp
  wordCount: number;    // Computed field
  checksum: string;     // SHA-256 of content for integrity
}

interface Preference {
  key: string;
  value: string | number | boolean;
  updatedAt: number;
}

interface SyncOperation {
  id: number;           // Auto-increment
  operationId: string;  // UUID for idempotency
  documentId: string;
  operation: 'create' | 'update' | 'delete';
  timestamp: number;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  payload?: string;     // Compressed content
  retryCount: number;
}
```

**Database Initialization:**

```typescript
let dbInstance: IDBPDatabase<MDReaderDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<MDReaderDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<MDReaderDB>('mdreader', 2, {
    upgrade(db, oldVersion, newVersion, transaction) {
      // Version 1: Initial schema
      if (oldVersion < 1) {
        const docStore = db.createObjectStore('documents', {
          keyPath: 'id'
        });
        docStore.createIndex('by-updated', 'updatedAt');
        docStore.createIndex('by-title', 'title');

        db.createObjectStore('preferences', { keyPath: 'key' });
      }

      // Version 2: Add sync queue
      if (oldVersion < 2) {
        const syncStore = db.createObjectStore('syncQueue', {
          keyPath: 'id',
          autoIncrement: true
        });
        syncStore.createIndex('by-status', 'status');
      }
    },
    blocked() {
      console.warn('Database upgrade blocked by other tabs');
    },
    blocking() {
      dbInstance?.close();
      dbInstance = null;
    }
  });

  return dbInstance;
}
```

### 2. Document CRUD Operations

**Document Repository:**

```typescript
// repositories/documentRepository.ts
import { getDB } from '../lib/db';
import { generateId, computeChecksum, extractTitle } from '../lib/utils';

export class DocumentRepository {
  async create(content: string): Promise<Document> {
    const db = await getDB();
    const now = Date.now();

    const doc: Document = {
      id: generateId(),
      title: extractTitle(content),
      content,
      createdAt: now,
      updatedAt: now,
      wordCount: countWords(content),
      checksum: await computeChecksum(content)
    };

    await db.add('documents', doc);

    // Queue for future sync
    await this.queueSync(doc.id, 'create', content);

    return doc;
  }

  async update(id: string, content: string): Promise<Document> {
    const db = await getDB();
    const existing = await db.get('documents', id);

    if (!existing) {
      throw new Error(`Document not found: ${id}`);
    }

    const updated: Document = {
      ...existing,
      title: extractTitle(content),
      content,
      updatedAt: Date.now(),
      wordCount: countWords(content),
      checksum: await computeChecksum(content)
    };

    await db.put('documents', updated);
    await this.queueSync(id, 'update', content);

    return updated;
  }

  async delete(id: string): Promise<void> {
    const db = await getDB();
    await db.delete('documents', id);
    await this.queueSync(id, 'delete');
  }

  async findById(id: string): Promise<Document | undefined> {
    const db = await getDB();
    return db.get('documents', id);
  }

  async findAll(): Promise<Document[]> {
    const db = await getDB();
    return db.getAllFromIndex('documents', 'by-updated');
  }

  async findRecent(limit: number): Promise<Document[]> {
    const db = await getDB();
    const all = await db.getAllFromIndex('documents', 'by-updated');
    return all.slice(-limit).reverse();
  }

  private async queueSync(
    documentId: string,
    operation: 'create' | 'update' | 'delete',
    content?: string
  ): Promise<void> {
    const db = await getDB();
    await db.add('syncQueue', {
      operationId: generateId(),
      documentId,
      operation,
      timestamp: Date.now(),
      status: 'pending',
      payload: content ? await compress(content) : undefined,
      retryCount: 0
    });
  }
}
```

### 3. Auto-Save with Debouncing

**Debounced Save Implementation:**

```typescript
// hooks/useAutoSave.ts
import { useRef, useEffect, useCallback } from 'react';
import { useDocumentStore } from '../stores/documentStore';

interface AutoSaveOptions {
  debounceMs: number;
  onSave?: () => void;
  onError?: (error: Error) => void;
}

export function useAutoSave(
  content: string,
  documentId: string | null,
  options: AutoSaveOptions = { debounceMs: 2000 }
) {
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedRef = useRef<string>('');
  const { updateDocument } = useDocumentStore();

  const save = useCallback(async () => {
    if (!documentId || content === lastSavedRef.current) {
      return;  // No changes to save
    }

    try {
      await updateDocument(documentId, content);
      lastSavedRef.current = content;
      options.onSave?.();
    } catch (error) {
      options.onError?.(error as Error);
    }
  }, [documentId, content, updateDocument, options]);

  useEffect(() => {
    // Clear existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Skip if no document or no changes
    if (!documentId || content === lastSavedRef.current) {
      return;
    }

    // Set new timer
    timerRef.current = setTimeout(save, options.debounceMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [content, documentId, save, options.debounceMs]);

  // Force save on unmount
  useEffect(() => {
    return () => {
      if (content !== lastSavedRef.current && documentId) {
        save();
      }
    };
  }, []);

  return { forceSave: save };
}
```

**Coalescing Multiple Saves:**

```typescript
// lib/saveQueue.ts
class SaveQueue {
  private pending: Map<string, { content: string; resolve: () => void }> = new Map();
  private processing = false;

  async enqueue(documentId: string, content: string): Promise<void> {
    return new Promise((resolve) => {
      // Coalesce: replace any pending save for this document
      this.pending.set(documentId, { content, resolve });

      if (!this.processing) {
        this.process();
      }
    });
  }

  private async process(): Promise<void> {
    this.processing = true;

    while (this.pending.size > 0) {
      const batch = new Map(this.pending);
      this.pending.clear();

      // Process all pending saves in parallel
      await Promise.all(
        Array.from(batch.entries()).map(async ([docId, { content, resolve }]) => {
          try {
            await documentRepository.update(docId, content);
          } finally {
            resolve();
          }
        })
      );
    }

    this.processing = false;
  }
}

export const saveQueue = new SaveQueue();
```

### 4. Service Worker Caching Strategy

**Workbox Configuration:**

```javascript
// sw.js (generated by Workbox)
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

// Precache app shell
precacheAndRoute(self.__WB_MANIFEST);

// Cache-first for static assets
registerRoute(
  ({ request }) => request.destination === 'script' ||
                   request.destination === 'style',
  new CacheFirst({
    cacheName: 'static-assets',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 50,
        maxAgeSeconds: 30 * 24 * 60 * 60  // 30 days
      })
    ]
  })
);

// Stale-while-revalidate for fonts
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com' ||
               url.origin === 'https://fonts.gstatic.com',
  new StaleWhileRevalidate({
    cacheName: 'google-fonts',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 20,
        maxAgeSeconds: 365 * 24 * 60 * 60  // 1 year
      })
    ]
  })
);

// Network-first for API calls (future sync)
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({
    cacheName: 'api-cache',
    networkTimeoutSeconds: 3,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 24 * 60 * 60  // 1 day
      })
    ]
  })
);
```

**Cache Versioning and Updates:**

```javascript
// Service worker update handling
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Claim clients on activation
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Clean old caches
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== 'static-assets' && key !== 'google-fonts')
            .map((key) => caches.delete(key))
        )
      )
    ])
  );
});
```

### 5. Storage Quota Management

**Quota Monitoring:**

```typescript
// lib/storage.ts
interface StorageInfo {
  used: number;
  quota: number;
  percentUsed: number;
}

export async function getStorageInfo(): Promise<StorageInfo> {
  if (!navigator.storage?.estimate) {
    return { used: 0, quota: 0, percentUsed: 0 };
  }

  const { usage = 0, quota = 0 } = await navigator.storage.estimate();

  return {
    used: usage,
    quota,
    percentUsed: quota > 0 ? (usage / quota) * 100 : 0
  };
}

export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) {
    return false;
  }

  // Request persistent storage (won't be evicted)
  return navigator.storage.persist();
}
```

**Quota Exceeded Handling:**

```typescript
// repositories/documentRepository.ts
async update(id: string, content: string): Promise<Document> {
  try {
    // ... normal update logic
    await db.put('documents', updated);
    return updated;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      // Storage full - handle gracefully
      const storageInfo = await getStorageInfo();

      throw new StorageFullError(
        'Storage quota exceeded. Please delete old documents or export data.',
        {
          used: storageInfo.used,
          quota: storageInfo.quota,
          documentId: id
        }
      );
    }
    throw error;
  }
}
```

### 6. Data Integrity and Recovery

**Content Checksums:**

```typescript
// lib/integrity.ts
export async function computeChecksum(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyDocument(doc: Document): Promise<boolean> {
  const computed = await computeChecksum(doc.content);
  return computed === doc.checksum;
}

export async function repairCorruptedDocuments(): Promise<number> {
  const db = await getDB();
  const docs = await db.getAll('documents');
  let repaired = 0;

  for (const doc of docs) {
    const isValid = await verifyDocument(doc);
    if (!isValid) {
      // Try to recover from localStorage backup
      const backup = localStorage.getItem(`doc-backup:${doc.id}`);
      if (backup) {
        doc.content = backup;
        doc.checksum = await computeChecksum(backup);
        await db.put('documents', doc);
        repaired++;
      }
    }
  }

  return repaired;
}
```

**localStorage Backup for Critical Saves:**

```typescript
// lib/backup.ts
const MAX_BACKUP_SIZE = 100 * 1024;  // 100KB per document

export function backupToLocalStorage(doc: Document): void {
  if (doc.content.length > MAX_BACKUP_SIZE) {
    // Too large for localStorage - skip
    return;
  }

  try {
    localStorage.setItem(`doc-backup:${doc.id}`, doc.content);
    localStorage.setItem(`doc-backup:${doc.id}:timestamp`, String(Date.now()));
  } catch (e) {
    // localStorage full - clean old backups
    cleanOldBackups();
  }
}

function cleanOldBackups(): void {
  const backupKeys = Object.keys(localStorage)
    .filter((key) => key.startsWith('doc-backup:'))
    .filter((key) => key.endsWith(':timestamp'));

  // Sort by timestamp, remove oldest
  const sorted = backupKeys
    .map((key) => ({
      key: key.replace(':timestamp', ''),
      timestamp: parseInt(localStorage.getItem(key) || '0', 10)
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  // Remove oldest 50%
  const toRemove = sorted.slice(0, Math.floor(sorted.length / 2));
  for (const { key } of toRemove) {
    localStorage.removeItem(key);
    localStorage.removeItem(`${key}:timestamp`);
  }
}
```

### 7. Future Sync Architecture

**Sync Queue Processing:**

```typescript
// services/syncService.ts
export class SyncService {
  private isOnline = navigator.onLine;

  constructor() {
    window.addEventListener('online', () => this.onOnline());
    window.addEventListener('offline', () => this.isOnline = false);
  }

  private async onOnline(): Promise<void> {
    this.isOnline = true;
    await this.processSyncQueue();
  }

  async processSyncQueue(): Promise<void> {
    if (!this.isOnline) return;

    const db = await getDB();
    const pending = await db.getAllFromIndex('syncQueue', 'by-status', 'pending');

    for (const op of pending) {
      try {
        op.status = 'syncing';
        await db.put('syncQueue', op);

        await this.syncOperation(op);

        op.status = 'synced';
        await db.put('syncQueue', op);
      } catch (error) {
        op.status = 'failed';
        op.retryCount++;
        await db.put('syncQueue', op);

        if (op.retryCount >= 3) {
          console.error(`Sync failed for ${op.operationId} after 3 retries`);
        }
      }
    }
  }

  private async syncOperation(op: SyncOperation): Promise<void> {
    // Future: POST to /api/sync
    // For now, just mark as synced
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Primary Storage | IndexedDB | localStorage | 50MB+ vs 5MB, async, structured |
| DB Wrapper | idb library | Raw IndexedDB | Cleaner Promise API |
| Save Strategy | Debounced (2s) | Immediate | Reduce write operations |
| Backup | localStorage | None | Recovery for critical data |
| Caching | Workbox | Manual SW | Industry standard, reliable |
| Integrity | SHA-256 checksum | None | Detect corruption |

## Future Enhancements

1. **Cloud Sync**: Optional server-side backup with conflict resolution
2. **Incremental Sync**: Send diffs instead of full documents
3. **CRDT Support**: Conflict-free replicated data types for collaboration
4. **Import/Export**: Bulk document backup and restore
5. **Cross-Tab Sync**: BroadcastChannel for multi-tab coordination
