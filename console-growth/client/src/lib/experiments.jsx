/**
 * Experiments on the client.
 *
 *   const { variant, isTreatment, ready, logExposure } = useExperiment('my_experiment');
 *
 * Assignment comes from the server (GET /api/experiments), which hashes the experiment key with
 * the user or org id and applies Dev toolbar overrides, so client and server always agree.
 * Until assignments load, `ready` is false and `variant` is the control. If they fail to load,
 * `ready` turns true and the variant stays the control: a broken experiment shows today's UI.
 *
 * Exposure ($exposure) is logged once per session per variant:
 *  - Automatically, when a component calling the hook mounts with a resolved assignment. So call
 *    the hook in the component that renders the difference, and render that component only
 *    when the user would actually see it. Calling it in a page or layout logs everyone who
 *    loads the page, which dilutes the result with people who never saw the change.
 *  - Manually, for differences that appear after mount (behind a click, in a modal, below the
 *    fold): pass { autoExposure: false } and call logExposure(props) at that moment.
 * Log exposure in the control arm at the same moment too ("would have seen it"), or the two
 * arms aren't comparable.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { onOverridesChange } from './overrides.js';

const ExperimentsContext = createContext(null);
const exposedThisSession = new Set();

function exposureStorageKey(key, variant) {
  return `console.exposed:${key}:${variant}`;
}

function wasExposed(key, variant) {
  if (exposedThisSession.has(exposureStorageKey(key, variant))) return true;
  try {
    return sessionStorage.getItem(exposureStorageKey(key, variant)) === '1';
  } catch {
    return false;
  }
}

function markExposed(key, variant) {
  exposedThisSession.add(exposureStorageKey(key, variant));
  try {
    sessionStorage.setItem(exposureStorageKey(key, variant), '1');
  } catch {
    // The in-memory set still dedupes within this page load.
  }
}

// Test helper: forget which exposures were logged.
export function resetExposureCache() {
  exposedThisSession.clear();
}

export function ExperimentsProvider({ children }) {
  const [experiments, setExperiments] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api
      .experiments()
      .then((data) => {
        setExperiments(data.experiments);
        setError(null);
      })
      .catch(setError);
  }, []);

  useEffect(() => {
    load();
    return onOverridesChange(load);
  }, [load]);

  const value = useMemo(() => ({ experiments, error, reload: load }), [experiments, error, load]);
  return <ExperimentsContext.Provider value={value}>{children}</ExperimentsContext.Provider>;
}

export function useExperiments() {
  return useContext(ExperimentsContext);
}

/**
 * @param {string} key  Experiment key from server/experiments.config.js.
 * @param {{ autoExposure?: boolean, exposureProps?: object }} options
 *   exposureProps are attached to the automatic exposure (e.g. which surface, what state).
 */
export function useExperiment(key, { autoExposure = true, exposureProps } = {}) {
  const context = useContext(ExperimentsContext);
  if (!context) throw new Error('useExperiment must be used inside <ExperimentsProvider>.');

  const assignment = context.experiments?.find((experiment) => experiment.key === key) ?? null;
  const ready = context.experiments !== null || context.error !== null;
  const control = assignment?.variants[0] ?? 'control';
  const variant = assignment?.variant ?? control;

  if (import.meta.env.DEV && context.experiments && !assignment) {
    console.warn(`useExperiment: unknown experiment "${key}". Register it in server/experiments.config.js.`);
  }

  const logExposure = useCallback(
    (props = {}) => {
      if (!assignment?.enabled || wasExposed(key, assignment.variant)) return;
      markExposed(key, assignment.variant);
      api.logExposure(key, props).catch(() => {});
    },
    [key, assignment],
  );

  // Props are read through a ref so a new object on every render doesn't re-run the effect.
  const exposurePropsRef = useRef(exposureProps);
  exposurePropsRef.current = exposureProps;
  useEffect(() => {
    if (autoExposure && assignment) logExposure(exposurePropsRef.current);
  }, [autoExposure, assignment, logExposure]);

  return { variant, isTreatment: variant !== control, ready, logExposure };
}
