/**
 * What the level tests in ./tests run against: the worked answer. The practice
 * tool writes its own subject.ts, which returns the practice attempt's KvStore,
 * so the same test files check both.
 * @module kv/subject
 */
import { KvStore } from './kv-store.js'

export function createStore() {
  return new KvStore()
}
