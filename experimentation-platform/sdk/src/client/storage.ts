/**
 * Where the SDK keeps its last known good snapshot, exposure dedup keys and
 * unsent events. Browsers use localStorage (client/browser); Node and tests
 * use memory. Every access is wrapped: storage can be full, disabled or
 * throw in private windows, and the SDK must keep working without it.
 * @module client/storage
 */

export interface StorageAdapter {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  /** False for the no-op adapter: callers can skip serializing what would be thrown away. */
  persistent?: boolean
}

/** Keeps nothing. The default when no storage is given (Node servers, simulators). */
export function noopStorage(): StorageAdapter {
  return { get: () => null, set: () => undefined, remove: () => undefined, persistent: false }
}

export function memoryStorage(initial: Record<string, string> = {}): StorageAdapter & { dump(): Record<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
    dump: () => Object.fromEntries(data),
  }
}

export function safeStorage(inner: StorageAdapter | null | undefined): StorageAdapter {
  return {
    persistent: inner ? inner.persistent !== false : false,
    get(k) {
      try {
        return inner?.get(k) ?? null
      } catch {
        return null
      }
    },
    set(k, v) {
      try {
        inner?.set(k, v)
      } catch {
        // quota or disabled storage: the SDK keeps working from memory
      }
    },
    remove(k) {
      try {
        inner?.remove(k)
      } catch {
        // ignore
      }
    },
  }
}
