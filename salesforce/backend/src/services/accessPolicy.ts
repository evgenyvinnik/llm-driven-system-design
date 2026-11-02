import type { Request, Response } from 'express';
import { pool } from './db.js';
import { logger } from './logger.js';

/**
 * Record-level authorization. Every route asks this module what the caller may
 * see or change instead of deciding on its own.
 *
 * Salesforce calls the baseline an organization-wide default; this project uses
 * "Private" for every object:
 *
 * | Caller          | Own records          | Records owned by another user |
 * |-----------------|----------------------|-------------------------------|
 * | user (rep)      | read, edit, delete   | invisible (404)               |
 * | admin           | read, edit, delete   | read, edit, delete            |
 *
 * Activities are read "controlled by parent": anyone who can see an account,
 * contact, opportunity or lead sees its whole timeline, including entries other
 * users logged on it. Editing or deleting an activity stays with its author or
 * an admin.
 *
 * Records the caller cannot see return 404 rather than 403, so record IDs
 * cannot be probed for existence. A malformed ID is also a 404 (not a 500 from
 * Postgres rejecting the UUID cast).
 */
export interface Caller {
  userId: string;
  role?: string;
}

export type EntityType = 'account' | 'contact' | 'opportunity' | 'lead';

/**
 * The only tables a polymorphic reference can resolve to. Table names are never
 * taken from the request; they come from this allowlist.
 */
const ENTITY_TABLES: Record<EntityType, string> = {
  account: 'accounts',
  contact: 'contacts',
  opportunity: 'opportunities',
  lead: 'leads',
};

const ENTITY_LABELS: Record<EntityType, string> = {
  account: 'Account',
  contact: 'Contact',
  opportunity: 'Opportunity',
  lead: 'Lead',
};

export const ENTITY_TYPES = Object.keys(ENTITY_TABLES) as EntityType[];

/** A refusal with its HTTP status; routes turn it into a response. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Sends an HttpError as its own status, and anything else as a logged 500 with
 * a generic message (database errors are never echoed to clients).
 */
export function respondError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error({ err }, fallback);
  res.status(500).json({ error: 'Internal server error' });
}

/** The authenticated caller. Only valid behind `requireAuth`. */
export function callerFrom(req: Request): Caller {
  return { userId: req.session.userId as string, role: req.session.role };
}

export function isAdmin(caller: Caller): boolean {
  return caller.role === 'admin';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === 'string' && value in ENTITY_TABLES;
}

/** Whether the caller may see (and therefore change) a record with this owner. */
export function canAccess(record: { owner_id: string | null }, caller: Caller): boolean {
  return isAdmin(caller) || record.owner_id === caller.userId;
}

/**
 * SQL condition limiting `alias.owner_id` to what the caller may see, with its
 * parameter appended to `params`. Returns null for admins (no restriction).
 * Use it in list queries, aggregates, and in the WHERE of UPDATE/DELETE so the
 * check and the write are one statement.
 */
export function ownerScope(caller: Caller, alias: string, params: unknown[]): string | null {
  if (isAdmin(caller)) return null;
  params.push(caller.userId);
  return `${alias}.owner_id = $${params.length}`;
}

/** Builds `WHERE a AND b` from the non-null conditions, or '' when there are none. */
export function whereClause(conditions: (string | null)[]): string {
  const present = conditions.filter((c): c is string => Boolean(c));
  return present.length > 0 ? `WHERE ${present.join(' AND ')}` : '';
}

/**
 * Loads `id, owner_id` of a record the caller can see, or throws 404 (missing,
 * malformed ID, or owned by someone else - indistinguishable on purpose).
 */
export async function requireRecord(
  type: EntityType,
  id: unknown,
  caller: Caller,
): Promise<{ id: string; owner_id: string | null }> {
  const notFound = new HttpError(404, `${ENTITY_LABELS[type]} not found`);
  if (!isUuid(id)) throw notFound;
  const result = await pool.query(`SELECT id, owner_id FROM ${ENTITY_TABLES[type]} WHERE id = $1`, [
    id,
  ]);
  const row = result.rows[0];
  if (!row || !canAccess(row, caller)) throw notFound;
  return row;
}

/**
 * Like requireRecord, for a record the request refers to (a contact's account,
 * an activity's parent). A bad reference is a 400 on the request, not a 404 on
 * the route, but still says nothing about whether the record exists.
 */
export async function requireReference(
  type: EntityType,
  id: unknown,
  caller: Caller,
): Promise<void> {
  try {
    await requireRecord(type, id, caller);
  } catch (err) {
    if (err instanceof HttpError) throw new HttpError(400, err.message);
    throw err;
  }
}

/** True if the caller can see the record (used for the activity read rule). */
export async function canSeeRecord(
  type: string | null,
  id: string | null,
  caller: Caller,
): Promise<boolean> {
  if (!isEntityType(type) || !id) return false;
  try {
    await requireRecord(type, id, caller);
    return true;
  } catch (err) {
    if (err instanceof HttpError) return false;
    throw err;
  }
}
