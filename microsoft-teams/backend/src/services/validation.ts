import { AccessError } from './accessService.js';

/**
 * Validates a display name for an org, team or channel. The columns are
 * VARCHAR(100); an over-long or missing name used to reach Postgres and come
 * back as a 500.
 */
export function validateName(value: unknown, label = 'Name'): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new AccessError(400, `${label} is required`);
  if (name.length > 100) throw new AccessError(400, `${label} must be at most 100 characters`);
  return name;
}
