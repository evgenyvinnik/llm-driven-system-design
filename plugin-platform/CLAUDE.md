# Pluggable Text Editor + Plugin Marketplace — Development with Claude

## Project Context

Two systems in one repo, joined at the plugin boundary: (1) a **text editor where everything is a plugin** — the host ships zero features, and even the textarea is contributed by a plugin into a named slot — and (2) a **marketplace backend** that stores, versions, and distributes those plugin bundles, with developer publishing and (anonymous or authenticated) installs. The hard problem is decoupling: plugins must compose without knowing about each other, and the marketplace must let a developer ship a new plugin bundle that the host can load at runtime.

**Learning goals:** slot/contribution systems, event-bus + shared-state inter-plugin communication, plugin lifecycle (load/activate), object-storage bundle distribution, and friction-free onboarding via anonymous sessions that migrate on registration.

## Architecture at a Glance (what actually runs)

Frontend is bundled plugins (no runtime download of untrusted code locally); backend is a three-store marketplace in `docker-compose.yml`:

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL** (`pg`) | users, plugins, plugin_versions, plugin_tags, user_plugins, anonymous_installs, plugin_reviews | Relational marketplace: versioning, install ownership, reviews, developer accounts |
| **Valkey/Redis** (`ioredis`) | Session store (`connect-redis`) + cache-aside for browse/detail/category queries | Revocable sessions incl. **anonymous** ones; short-TTL cache absorbs marketplace browse load |
| **MinIO** (`minio`) | Plugin bundles (ES modules), bucket `plugins` with public download | Object storage separates bundle delivery from the API and is CDN-ready; bundles are immutable per version |

Backend: Express **5** app (`api/app.ts`) with routes `auth`, `plugins` (browse, `optionalAuth`), `user/plugins` (install, `optionalAuth`), `developer` (publish, `requireAuth`), multer bundle uploads, pino logging. Frontend: React 19 + Zustand; core is `PluginHost` + `SlotRenderer` + `EventBus` + `StateManager`; 5 bundled plugins (paper-background, font-selector, text-editor, word-count, theme) plus `MarketplaceModal`/`AuthModal`. No router — the shell is modal-driven.

## Key Design Decisions

### 1. In-process plugins, not Web Workers
Plugins run in the main thread. They need direct DOM/React access to render UI into slots, and locally the plugins are bundled and trusted, so isolation buys little. Trade-off explicitly given up: a misbehaving plugin can affect the host (no sandbox). At production scale with third-party bundles this flips — you'd want Workers/iframes and a capability-restricted API — but that complexity isn't justified for trusted, bundled plugins.

### 2. Slot system + declarative contributions
Plugins register components into named slots (toolbar, canvas, sidebar, statusbar, modal) via their manifest; the host renders whatever is contributed. No plugin imports another. Trade-off: ordering and layout are the host's concern (driven by manifest), and cross-plugin features must go through the shared channels below rather than direct calls.

### 3. Event bus *and* shared state — two channels on purpose
`StateManager` holds persistent reactive values (font, theme, editor content) that late-subscribing plugins can read; `EventBus` carries transient notifications (content-changed) that only live subscribers care about. Example wiring: font-selector writes `format.font` to state → text-editor subscribes and restyles; text-editor writes `editor.content` → word-count recomputes. Using only events would lose state for plugins that mount later; using only state would abuse it for fire-and-forget signals. Each plugin picks the right tool.

### 4. Anonymous sessions with migration on register
`saveUninitialized: true` gives every visitor a session immediately (`anonymousId = sessionID`); they can browse and "install" plugins before signing up, tracked in `anonymous_installs`. On registration those installs migrate to `user_plugins`. This removes the sign-up wall. Trade-off: anonymous sessions consume Redis memory — bounded by the cookie's 7-day `maxAge` (not 24h). Sessions are Redis-backed via `connect-redis`, so logout/expiry revokes instantly.

### 5. MinIO for bundles, cache-aside for reads
Plugin bundles live in MinIO (public download), not Postgres or the filesystem — separating immutable binary delivery from the relational API and keeping it CDN-ready. Marketplace reads use Redis cache-aside (browse ~5min, detail ~10min, categories ~30min), invalidated on publish/update. Trade-off: cache staleness up to the TTL after a publish, accepted because marketplace listings tolerate seconds-to-minutes lag far better than the DB tolerates every browse hitting it.

## Current State

Implemented end to end. Frontend: plugin host with slot rendering, EventBus + StateManager, the 5 bundled plugins (text-editor auto-saves to localStorage; word-count is real-time; theme does light/dark with system detection; paper-background has 6 styles; font-selector has 7 families + sizes), plus the marketplace + auth modals. Backend: session auth (anonymous + authenticated, migration on register), plugin browse/search with cache-aside, user install/list, developer publish with versioning/changelogs and MinIO bundle upload, plugin reviews, and health checks across Postgres/Redis/MinIO.

Intentionally omitted / simulated: CDN in front of MinIO, Elasticsearch (marketplace search is PostgreSQL queries), Web-Worker/iframe plugin sandboxing, a publishing CLI, and runtime loading of *remote* untrusted bundles (the loaded plugins are bundled locally). A Postgres `sessions` table exists in `init.sql` but the live session store is Redis (`connect-redis`); the table is vestigial.

## Iteration & Repair Log

- **2026-07 (CLAUDE.md rewrite):** The previous file described *only* the frontend editor (slots, event bus, 5 plugins) and omitted the entire backend marketplace — developer publishing, user installs, MinIO bundle storage, reviews, anonymous-session migration — that `architecture.md`, the routes, and `init.sql` all implement. Rewrote to cover both halves and match the actual three-store backend.
- **2026-07 (architecture drift fix):** `architecture.md` twice cited a "24-hour session TTL"; `api/app.ts` sets a 7-day cookie `maxAge`. Corrected both mentions.
- **Frontend pivot (history):** the frontend was reworked from a VS Code-style *marketplace-browser* mock into a working "everything is a plugin" editor; the marketplace **backend** was kept and is what the modals talk to.
- **Repo-wide fixes that touched this project:** ESM hardening (`connect-redis` v8 named import, `pino-http` named import); DB/Redis/MinIO connection fallbacks to docker-compose creds (`plugin_user`/`plugin_pass`, `minioadmin`); schema-apply via `db/migrate.ts` + `npm run db:migrate`.
- **CI:** the repo-wide smoke-test workflow was removed (no Docker services in CI).

## Open Questions

1. **Seed credential deviates from the repo norm:** `db/seed.ts` hashes `dev123` for the `official` developer account, not the repo-wide `password123`. Left as-is (can't change source in this pass) — the README documents no login, so nothing contradicts, but this is the one account that exists.
2. When plugins become third-party (remote bundles), what's the isolation boundary — Web Workers, iframes, or a restricted capability API — and how much of the current in-process context API survives it?
3. Cache invalidation on publish deletes detail + all list keys; at thousands of plugins is a full list-key flush too coarse (thundering-herd on the next browse)?
4. Anonymous installs migrate on register — what happens to reviews or state a user created anonymously, and how do we dedupe if they already installed the same plugin while logged in on another device?

## Resources

- [VS Code Extension API](https://code.visualstudio.com/api) — contribution-system inspiration
- [connect-redis](https://github.com/tj/connect-redis) — the session store
- [MinIO](https://min.io/) — S3-compatible bundle storage
