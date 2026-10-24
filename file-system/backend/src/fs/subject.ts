/**
 * What the level tests in ./tests run against.
 *
 * By default that's the in-memory worked answer. With FS_STORE=postgres it's the
 * PostgreSQL backend's spec adapter, so both implementations must pass the same
 * conformance suite (`npm run test:pg`). The practice tool writes its own
 * subject.ts, which always returns the practice attempt's FileStore.
 * @module fs/subject
 */
import { FileStore } from './file-store.js'

export async function createStore() {
  if (process.env.FS_STORE === 'postgres') {
    const { createTestPgStore } = await import('../store/pg-test-store.js')
    return createTestPgStore()
  }
  return new FileStore()
}
