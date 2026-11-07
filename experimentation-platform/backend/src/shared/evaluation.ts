/**
 * The server's view of the shared evaluation core. There is exactly one
 * implementation of hashing, allocation, targeting and evaluation: the SDK's
 * `core` folder. The server re-exports it rather than keeping a copy, so the
 * evaluate endpoint, the snapshot compiler, the editor preview and every SDK
 * agree by construction (and src/domain/parity.test.ts checks it).
 * @module shared/evaluation
 */
export * from '../../../sdk/src/core/index.js'
