/**
 * Validation of job definitions at the API boundary.
 *
 * Everything the scheduler and workers later rely on is checked here, once, with a
 * 400 and a field-level message: a cron expression that parses, a handler that exists,
 * numbers inside sane ranges. Before this, an invalid cron surfaced as a 500 from deep
 * in the repository, and an unknown handler was accepted and failed on every run.
 * @module api/validation
 */

import { CreateJobInput, UpdateJobInput, MisfirePolicy } from '../types/index';
import { cronValidationError } from '../scheduler/cron';
import { hasHandler, listHandlers } from '../worker/handlers';

/** Either the normalized input or the list of problems found. */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const NAME_MAX_LENGTH = 255;
const DESCRIPTION_MAX_LENGTH = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MISFIRE_POLICIES: MisfirePolicy[] = ['fire_once', 'skip'];

/** Defaults applied by createJob, used to check backoff bounds against each other. */
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 3600000;

type Body = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks an optional integer field; returns the number when present and valid. */
function checkInteger(
  body: Body,
  field: string,
  min: number,
  max: number,
  errors: string[]
): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${field} must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return value;
}

/** Validates the fields shared by create and update; `partial` skips required checks. */
function validateFields(body: Body, partial: boolean): { value: UpdateJobInput & { scheduled_at?: Date }; errors: string[] } {
  const errors: string[] = [];
  const value: UpdateJobInput & { scheduled_at?: Date } = {};

  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > NAME_MAX_LENGTH) {
      errors.push(`name is required (1-${NAME_MAX_LENGTH} characters)`);
    } else {
      value.name = name;
    }
  }

  if (body.handler !== undefined || !partial) {
    if (typeof body.handler !== 'string' || !body.handler) {
      errors.push('handler is required');
    } else if (!hasHandler(body.handler)) {
      errors.push(`handler "${body.handler}" is not registered (known: ${listHandlers().join(', ')})`);
    } else {
      value.handler = body.handler;
    }
  }

  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string' || body.description.length > DESCRIPTION_MAX_LENGTH) {
      errors.push(`description must be a string of at most ${DESCRIPTION_MAX_LENGTH} characters`);
    } else {
      value.description = body.description;
    }
  }

  if (body.payload !== undefined) {
    if (!isPlainObject(body.payload)) {
      errors.push('payload must be a JSON object');
    } else {
      value.payload = body.payload;
    }
  }

  // An empty string means "no schedule" (the dashboard form sends it that way).
  const schedule = typeof body.schedule === 'string' ? body.schedule.trim() : body.schedule;
  if (schedule !== undefined && schedule !== null && schedule !== '') {
    if (typeof schedule !== 'string') {
      errors.push('schedule must be a cron expression string');
    } else {
      const problem = cronValidationError(schedule);
      if (problem) {
        errors.push(`schedule is not a valid cron expression (${problem})`);
      } else {
        value.schedule = schedule;
      }
    }
  }

  if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
    const when = typeof body.scheduled_at === 'string' ? new Date(body.scheduled_at) : null;
    if (!when || Number.isNaN(when.getTime())) {
      errors.push('scheduled_at must be an ISO-8601 timestamp');
    } else if (value.schedule) {
      errors.push('give either schedule (recurring) or scheduled_at (one-time), not both');
    } else {
      value.scheduled_at = when;
    }
  }

  value.priority = checkInteger(body, 'priority', 0, 100, errors);
  value.max_retries = checkInteger(body, 'max_retries', 0, 10, errors);
  value.initial_backoff_ms = checkInteger(body, 'initial_backoff_ms', 100, DAY_MS, errors);
  value.max_backoff_ms = checkInteger(body, 'max_backoff_ms', 100, DAY_MS, errors);
  value.timeout_ms = checkInteger(body, 'timeout_ms', 1000, DAY_MS, errors);

  if (value.initial_backoff_ms !== undefined || value.max_backoff_ms !== undefined) {
    const initial = value.initial_backoff_ms ?? DEFAULT_INITIAL_BACKOFF_MS;
    const max = value.max_backoff_ms ?? DEFAULT_MAX_BACKOFF_MS;
    if (initial > max) {
      errors.push('initial_backoff_ms must not exceed max_backoff_ms');
    }
  }

  if (body.misfire_policy !== undefined && body.misfire_policy !== null) {
    if (!MISFIRE_POLICIES.includes(body.misfire_policy as MisfirePolicy)) {
      errors.push(`misfire_policy must be one of: ${MISFIRE_POLICIES.join(', ')}`);
    } else {
      value.misfire_policy = body.misfire_policy as MisfirePolicy;
    }
  }

  // Drop keys whose validation produced nothing, so updates only touch given fields.
  for (const key of Object.keys(value) as (keyof typeof value)[]) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }

  return { value, errors };
}

/** Validates a POST /api/v1/jobs body. */
export function validateCreateJob(body: unknown): ValidationResult<CreateJobInput> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['request body must be a JSON object'] };
  }
  const { value, errors } = validateFields(body, false);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as CreateJobInput };
}

/** Validates a PUT /api/v1/jobs/:id body (every field optional). */
export function validateUpdateJob(body: unknown): ValidationResult<UpdateJobInput> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['request body must be a JSON object'] };
  }
  const { value, errors } = validateFields(body, true);
  if (value.scheduled_at) {
    errors.push('scheduled_at cannot be changed; create a new one-time job instead');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
