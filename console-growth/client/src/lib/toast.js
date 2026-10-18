// Minimal toast notifications: toast('Saved') from anywhere, rendered by <Toaster />.
const listeners = new Set();
let nextId = 1;

export function toast(message) {
  const item = { id: nextId++, message };
  listeners.forEach((listener) => listener(item));
}

export function onToast(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
