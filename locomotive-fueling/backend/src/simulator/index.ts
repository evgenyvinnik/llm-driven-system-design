/**
 * Simulator entry point. Sets the service name before any module reads it,
 * then loads the simulator (see run.ts).
 */
process.env.SERVICE_NAME ??= 'simulator'
await import('./run.js')
