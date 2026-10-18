// track(event, props): fire-and-forget analytics.
//
//   track('api_key_created_from_banner', { surface: 'dashboard', key_count: 3 });
//
// Events go to POST /api/events, where the server stamps the user, org, session and time and
// writes them to data/events.ndjson (and the Dev toolbar's live stream). Use snake_case names
// and properties. Failures are swallowed: analytics must never break the product.
//
// Prefer emitting conversions server-side (see server/lib/analytics.js) when the server knows
// the outcome, e.g. a purchase. Client events are lost to ad blockers and closed tabs.
import { api } from '../api.js';

export function track(event, props = {}) {
  api.sendEvent({ event, props, path: window.location.pathname }).catch(() => {});
}
