// A per-tab analytics session id, sent with every API request as X-Session-Id.
const SESSION_KEY = 'console.sessionId';

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

let fallbackId = null;

export function getSessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = newId();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    fallbackId ??= newId();
    return fallbackId;
  }
}
