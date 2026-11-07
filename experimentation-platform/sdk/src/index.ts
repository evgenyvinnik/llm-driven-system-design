/**
 * experimentation-sdk: local evaluation, cached rulesets, push updates,
 * render-time exposure logging and batched events.
 *   - core: the shared evaluation module (also used by the server)
 *   - client: the environment-neutral client
 *   - client/browser: localStorage, beacon and anonymous-id wiring
 *   - react: provider, useVariant, Exposure, Experiment
 */
export * from './core/index.js'
export * from './client/index.js'
export { createBrowserClient, getAnonymousId, rotateAnonymousId, localStorageAdapter } from './client/browser.js'
