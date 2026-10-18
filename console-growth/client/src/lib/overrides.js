// Variant overrides set from the Dev toolbar. Stored in localStorage and sent with every API
// request (X-Experiment-Overrides), so the server's getAssignment() honors them too.
const STORAGE_KEY = 'console.experimentOverrides';
const CHANGE_EVENT = 'console:overrides-changed';

export function getOverrides() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function save(overrides) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Storage blocked: overrides just won't persist.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setOverride(key, variant) {
  const next = { ...getOverrides() };
  if (variant) next[key] = variant;
  else delete next[key];
  save(next);
}

export function clearOverrides() {
  save({});
}

export function onOverridesChange(listener) {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}
