/**
 * Random UUID v4. crypto.randomUUID only exists in secure contexts (https or
 * localhost); opening the dev server by LAN IP over http would otherwise
 * break message sends, so fall back to getRandomValues.
 */
export function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const INSTALL_ID_KEY = 'imessage.installId';

/**
 * Identifies this browser installation across logins. The server maps
 * (user, installId) to one device row, so this tab keeps its device - and its
 * inbox and receipts - after logout/login, while a second browser becomes a
 * second device. It is deliberately not cleared on logout.
 */
export function getInstallId(): string {
  try {
    const existing = localStorage.getItem(INSTALL_ID_KEY);
    if (existing) return existing;
    const created = newClientId();
    localStorage.setItem(INSTALL_ID_KEY, created);
    return created;
  } catch {
    // Storage blocked (private mode): this session becomes its own device
    return newClientId();
  }
}
