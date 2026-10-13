/**
 * Cron arithmetic and the misfire policy, kept free of I/O so they can be unit tested.
 *
 * The scheduler stores one `next_run_time` per job and treats it as the identity of
 * the next run (the "slot"). Firing a slot inserts an execution keyed by
 * (job_id, scheduled_at = slot, attempt = 1) and moves next_run_time forward. This
 * module decides which slot to fire and where next_run_time moves to.
 * @module scheduler/cron
 */

import cronParser from 'cron-parser';
import { MisfirePolicy } from '../types';

/**
 * All schedules are evaluated in UTC so the same expression means the same instants
 * on every process, regardless of the host's TZ setting.
 */
export const CRON_TIMEZONE = 'UTC';

/**
 * Returns the first instant matching `schedule` strictly after `after`.
 * @throws Error when the expression cannot be parsed
 */
export function nextCronTime(schedule: string, after: Date): Date {
  const interval = cronParser.parseExpression(schedule, {
    currentDate: after,
    tz: CRON_TIMEZONE,
  });
  return interval.next().toDate();
}

/**
 * Validates a cron expression: 5 fields (minute precision) or 6 (leading seconds field).
 * cron-parser alone accepts shorter expressions and silently fills in defaults.
 * @returns null when valid, otherwise a human-readable reason
 */
export function cronValidationError(schedule: string): string | null {
  const fields = schedule.trim().split(/\s+/).length;
  if (fields !== 5 && fields !== 6) {
    return `expected 5 or 6 fields, got ${fields}`;
  }
  try {
    nextCronTime(schedule, new Date());
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** The part of a job definition the planner needs. */
export interface PlannableJob {
  schedule: string | null;
  next_run_time: Date;
  misfire_policy: MisfirePolicy;
}

/** What one scheduler tick should do with one due job. */
export interface FiringPlan {
  /** Slot to fire (becomes the execution's scheduled_at), or null to fire nothing. */
  fireSlot: Date | null;
  /** New next_run_time; null for a one-time job that has now fired. */
  nextRunTime: Date | null;
  /** True when the slot was later than the grace window. */
  misfired: boolean;
}

/**
 * Decides what to fire for a due job.
 *
 * - One-time job: fire its slot exactly once, however late (late beats never).
 * - Recurring job within the grace window: fire the slot and advance from the slot
 *   itself, not from now. A tick that runs a few seconds late therefore never skips
 *   the following slot; if that slot is also due, the next tick fires it.
 * - Recurring job later than the grace window (scheduler outage, long leader
 *   failover): the whole gap counts as one misfire. `fire_once` runs the oldest missed
 *   slot once, `skip` runs nothing, and next_run_time jumps to the first slot after
 *   now. The job is never left with a next_run_time in the past.
 *
 * @param now - the database clock, so lateness is measured on the same clock that
 *   selected the job as due
 * @param graceMs - how late a slot may be and still count as on time; it should exceed
 *   the worst-case leader failover time, or every failover produces misfires
 */
export function planFiring(job: PlannableJob, now: Date, graceMs: number): FiringPlan {
  const slot = job.next_run_time;
  const misfired = now.getTime() - slot.getTime() > graceMs;

  if (!job.schedule) {
    return { fireSlot: slot, nextRunTime: null, misfired };
  }

  if (!misfired) {
    return { fireSlot: slot, nextRunTime: nextCronTime(job.schedule, slot), misfired };
  }

  return {
    fireSlot: job.misfire_policy === 'fire_once' ? slot : null,
    nextRunTime: nextCronTime(job.schedule, now),
    misfired,
  };
}
