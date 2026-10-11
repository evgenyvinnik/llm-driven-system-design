/**
 * Dispatch leases and the dispatch sweeper.
 *
 * @module services/order/dispatch
 * @description The matching loop for an order runs inside one API process. If
 * that process dies (deploy, crash, a `tsx watch` restart) the loop dies with
 * it, and before this module existed the order then sat unassigned forever.
 *
 * Each unassigned order now carries a lease: `dispatch_owner` names the
 * instance running its loop and `dispatch_lease_until` says until when. The
 * owner renews the lease before every offer. Every instance runs a sweeper that
 * claims orders whose lease is missing or expired with
 * `FOR UPDATE SKIP LOCKED`, so concurrent sweepers never claim the same order
 * and never block each other.
 *
 * The lease is for liveness only. Correctness (one courier per order) comes
 * from the compare-and-set UPDATEs and the partial unique indexes on
 * driver_offers, which hold even if two instances briefly both think they own
 * an order.
 */
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { query, queryOne, execute } from '../../utils/db.js';
import { matchingLogger } from '../../shared/logger.js';
import { DISPATCHABLE_STATUSES } from './stateMachine.js';

/** Identifies this process as a lease owner. The random suffix survives PID reuse in containers. */
export const DISPATCH_OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Lease length; must exceed one offer window (30 s) plus polling slack. */
export const DISPATCH_LEASE_SECONDS = 45;

/** Back-off when no courier is nearby; the sweeper retries after this. */
export const DISPATCH_RETRY_DELAY_SECONDS = 10;

/** Back-off when matching itself is failing (circuit breaker open or error). */
export const DISPATCH_FAILURE_BACKOFF_SECONDS = 30;

/** Give up and cancel an order that has waited this long for a courier. */
export const DISPATCH_DEADLINE_SECONDS = 300;

/** How often each instance looks for orders nobody is dispatching. */
export const DISPATCH_SWEEP_INTERVAL_MS = 5000;

/** Orders claimed per sweep per instance. */
export const DISPATCH_SWEEP_BATCH = 10;

/**
 * Extends this instance's lease before the next offer.
 *
 * @returns `{ pastDeadline }` while the lease is held, or null when it is not:
 *   the order was assigned or cancelled, or another instance took it over.
 */
export async function renewDispatchLease(
  orderId: string,
  owner: string = DISPATCH_OWNER
): Promise<{ pastDeadline: boolean } | null> {
  const row = await queryOne<{ past_deadline: boolean }>(
    `UPDATE orders
     SET dispatch_lease_until = NOW() + make_interval(secs => $3)
     WHERE id = $1 AND dispatch_owner = $2
       AND driver_id IS NULL AND status = ANY($4::text[])
     RETURNING (NOW() - created_at) > make_interval(secs => $5) AS past_deadline`,
    [orderId, owner, DISPATCH_LEASE_SECONDS, DISPATCHABLE_STATUSES, DISPATCH_DEADLINE_SECONDS]
  );
  return row ? { pastDeadline: row.past_deadline } : null;
}

/**
 * Gives the order back to the sweepers, not before `retryAfterSeconds`.
 * Only the current owner can release, so a stale loop cannot clobber a newer owner.
 */
export async function releaseDispatchLease(
  orderId: string,
  owner: string,
  retryAfterSeconds: number
): Promise<void> {
  await execute(
    `UPDATE orders
     SET dispatch_owner = NULL, dispatch_lease_until = NOW() + make_interval(secs => $3)
     WHERE id = $1 AND dispatch_owner = $2`,
    [orderId, owner, retryAfterSeconds]
  );
}

/**
 * Claims up to `limit` unassigned orders whose lease is missing or expired.
 * SKIP LOCKED makes concurrent sweepers on other instances pass over rows this
 * one is claiming instead of waiting on them or claiming them twice.
 *
 * @returns The claimed order ids, oldest first
 */
export async function claimDueOrders(
  owner: string = DISPATCH_OWNER,
  limit: number = DISPATCH_SWEEP_BATCH
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `UPDATE orders o
     SET dispatch_owner = $1, dispatch_lease_until = NOW() + make_interval(secs => $2)
     FROM (
       SELECT id FROM orders
       WHERE driver_id IS NULL
         AND status = ANY($3::text[])
         AND (dispatch_lease_until IS NULL OR dispatch_lease_until < NOW())
       ORDER BY created_at
       LIMIT $4
       FOR UPDATE SKIP LOCKED
     ) due
     WHERE o.id = due.id
     RETURNING o.id`,
    [owner, DISPATCH_LEASE_SECONDS, DISPATCHABLE_STATUSES, limit]
  );
  return rows.map((row) => row.id);
}

/**
 * Releases every lease this instance holds, so other instances pick the orders
 * up on their next sweep instead of waiting for the leases to expire.
 * Called during graceful shutdown.
 */
export async function releaseAllDispatchLeases(owner: string = DISPATCH_OWNER): Promise<number> {
  return execute(
    `UPDATE orders SET dispatch_owner = NULL, dispatch_lease_until = NULL
     WHERE dispatch_owner = $1 AND driver_id IS NULL`,
    [owner]
  );
}

/**
 * Dependencies of the sweeper, injectable for tests.
 */
export interface DispatchSweeperOptions {
  /** Runs the matching loop for one claimed order. */
  dispatch: (orderId: string) => Promise<unknown>;
  /** Claims due orders; defaults to claimDueOrders for this instance. */
  claim?: () => Promise<string[]>;
  /** Housekeeping run before each claim (e.g. expiring lapsed offers). */
  beforeSweep?: () => Promise<unknown>;
  intervalMs?: number;
}

/**
 * Handle returned by startDispatchSweeper.
 */
export interface DispatchSweeper {
  /** Runs one sweep now; resolves when claimed orders have been handed to dispatch. */
  sweepOnce: () => Promise<number>;
  stop: () => void;
}

/**
 * Starts the periodic sweep. Orders already being matched in this process are
 * never handed to `dispatch` twice, even if a sweep reclaims them.
 */
export function startDispatchSweeper(options: DispatchSweeperOptions): DispatchSweeper {
  const claim = options.claim ?? (() => claimDueOrders());
  const inFlight = new Set<string>();
  let sweeping = false;

  const sweepOnce = async (): Promise<number> => {
    if (sweeping) return 0;
    sweeping = true;
    try {
      if (options.beforeSweep) {
        await options.beforeSweep();
      }
      const orderIds = await claim();
      let started = 0;
      for (const orderId of orderIds) {
        if (inFlight.has(orderId)) continue;
        inFlight.add(orderId);
        started++;
        options
          .dispatch(orderId)
          .catch((error) => {
            matchingLogger.error({ orderId, error: (error as Error).message }, 'Dispatch failed');
          })
          .finally(() => inFlight.delete(orderId));
      }
      if (started > 0) {
        matchingLogger.info({ started }, 'Dispatch sweeper resumed unassigned orders');
      }
      return started;
    } catch (error) {
      matchingLogger.error({ error: (error as Error).message }, 'Dispatch sweep failed');
      return 0;
    } finally {
      sweeping = false;
    }
  };

  const timer = setInterval(() => {
    void sweepOnce();
  }, options.intervalMs ?? DISPATCH_SWEEP_INTERVAL_MS);
  timer.unref();

  return {
    sweepOnce,
    stop: () => clearInterval(timer),
  };
}
