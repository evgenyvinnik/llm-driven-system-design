/**
 * Database module exports.
 *
 * @description Main entry point for database functionality. Re-exports pool utilities,
 * repository functions, and migration tools for convenient single-import access.
 *
 * @module db
 *
 * @example
 * // Import database functions
 * import { query, createJob, migrate } from './db';
 *
 * // Run migrations
 * await migrate();
 *
 * // Create a job
 * const job = await createJob({ name: 'my-job', handler: 'test.echo' });
 *
 * // Execute custom query
 * const results = await query('SELECT * FROM jobs WHERE status = $1', ['SCHEDULED']);
 */

export * from './pool';
export * from './repository';
export { migrate, rollback } from './migrate';
