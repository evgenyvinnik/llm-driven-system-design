// Deterministic experiment assignment.
//
// bucket = first 32 bits of sha256(`${key}:${unitId}`) mod 10,000. Each variant owns a contiguous
// range of buckets sized by its weight, so the same unit always lands in the same variant, and
// different experiments (different keys) are assigned independently of each other.
//
// Overrides: the Dev toolbar sends `X-Experiment-Overrides: {"key":"variant"}` on every API
// request. An override wins over the hash but is flagged, so overridden exposures can be
// excluded from analysis.
import crypto from 'node:crypto';
import { EXPERIMENTS } from '../experiments.config.js';
import { track } from './analytics.js';
import { trackingContext } from './context.js';

export const OVERRIDE_HEADER = 'x-experiment-overrides';
const BUCKETS = 10_000;

export function getExperiment(key) {
  return EXPERIMENTS.find((experiment) => experiment.key === key) ?? null;
}

export function bucketFor(key, unitId) {
  const digest = crypto.createHash('sha256').update(`${key}:${unitId}`).digest();
  return digest.readUInt32BE(0) % BUCKETS;
}

export function variantForBucket(experiment, bucket) {
  const total = experiment.weights.reduce((sum, weight) => sum + weight, 0);
  let upperBound = 0;
  for (let i = 0; i < experiment.variants.length; i += 1) {
    upperBound += (experiment.weights[i] / total) * BUCKETS;
    if (bucket < upperBound) return experiment.variants[i];
  }
  return experiment.variants[experiment.variants.length - 1];
}

export function parseOverrides(headerValue) {
  if (!headerValue) return {};
  try {
    const parsed = JSON.parse(headerValue);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function unitIdFor(experiment, req) {
  return experiment.unit === 'org' ? req.org.id : req.user.id;
}

/**
 * Resolve the variant for the current request.
 * @returns {{ key, variant, assigned, unit, unitId, overridden, enabled }}
 *   variant  what this request should render
 *   assigned what the hash alone says (differs from variant only when overridden)
 */
export function getAssignment(req, key) {
  const experiment = getExperiment(key);
  if (!experiment) throw new Error(`Unknown experiment "${key}". Register it in server/experiments.config.js.`);

  const unitId = unitIdFor(experiment, req);
  const control = experiment.variants[0];
  const assigned = experiment.enabled ? variantForBucket(experiment, bucketFor(key, unitId)) : control;
  const override = parseOverrides(req.get(OVERRIDE_HEADER))[key];
  const overridden = experiment.enabled && experiment.variants.includes(override) && override !== assigned;

  return {
    key,
    variant: overridden ? override : assigned,
    assigned,
    unit: experiment.unit,
    unitId,
    overridden,
    enabled: experiment.enabled,
  };
}

export function getAllAssignments(req) {
  return EXPERIMENTS.map((experiment) => ({
    key: experiment.key,
    description: experiment.description,
    variants: experiment.variants,
    weights: experiment.weights,
    ...getAssignment(req, experiment.key),
  }));
}

/**
 * Log that the current user actually encountered the experiment's difference (or, for the
 * control, the moment they would have). Returns null when the experiment is switched off.
 * `source` is 'client' when the browser reported the exposure through POST /api/experiments/:key/exposure.
 */
export function logExposure(req, key, props = {}, { source = 'server' } = {}) {
  const assignment = getAssignment(req, key);
  if (!assignment.enabled) return null;
  return track(
    '$exposure',
    {
      ...props,
      experiment: key,
      variant: assignment.variant,
      unit: assignment.unit,
      unit_id: assignment.unitId,
      overridden: assignment.overridden,
    },
    { ...trackingContext(req), source },
  );
}
