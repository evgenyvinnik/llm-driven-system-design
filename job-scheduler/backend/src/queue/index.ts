/**
 * Coordination module exports: the shared Redis client and scheduler leader election.
 * The execution queue itself lives in PostgreSQL (see db/execution-queue.ts).
 * @module queue
 */

export { redis, healthCheck, disconnect } from './redis';
export { LeaderElection } from './leader-election';
