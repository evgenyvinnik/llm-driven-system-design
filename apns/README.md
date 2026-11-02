# APNs: a local push notification simulator

This project explores device registration, online routing, offline storage, collapse identifiers, and delivery status. A React administration console sends notifications through a Node.js service; simulated devices receive them over WebSockets. PostgreSQL stores registrations and notification history, while Valkey provides token caches, sessions, and cross-process pub/sub.

It does not connect to Apple or deliver notifications to native Apple devices. The `/3/device/:token` route resembles the APNs request path but runs over ordinary HTTP and implements a different contract. See [architecture.md](./architecture.md) for the proposed production design, source-backed implementation notes, and comparison with Apple's protocol.

## What you can explore

| Flow | Current behavior |
|------|------------------|
| Dashboard | Database counts, top 50 subscription topics, ten recent notifications; refreshes every 30 seconds |
| Device list | Read-only pages of 20 registrations, validity, token hashes, and registration timestamps |
| Notification list | Pages of 20 history records with a status filter |
| Send form | Send by internal device UUID, subscription topic, or broadcast; alert, badge, sound, and priority fields |
| Device APIs | Register a simulated token, look it up, invalidate it, and manage subscriptions |
| Simulated device | Connect to `/ws`, authenticate with its raw device token, receive messages, and acknowledge its own IDs |
| Provider keys | Admins issue ES256 signing keys scoped to app bundles; providers send with a short-lived JWT |
| Multiple servers | Route a send through Valkey to the process holding the target socket |

The console has no registration form, payload inspector, feedback page, charts, live event stream, or integrated device simulator. API clients cover registration and feedback operations. `last_seen` is updated by registration, not by heartbeat or every delivery.

## Stack and prerequisites

- Node.js 20 or later and npm.
- React 19, TypeScript, Vite 5, TanStack Router, Zustand, Tailwind CSS 3.
- Express 4, `ws`, `pg`, `ioredis`, Pino, and `prom-client`.
- PostgreSQL 16 and Valkey 7 in Compose. Opossum is installed, but its circuit-breaker helpers are not connected to delivery.

Choose one infrastructure option below. Application processes run on the host in both cases. Default ports are frontend **5173**, API/WebSocket **3000**, PostgreSQL **5432**, and Valkey **6379**. Stop conflicting development services first.

## Option A: Docker Compose (recommended)

From the repository root:

```bash
cd apns
docker compose up -d
docker compose ps
docker compose exec -T postgres pg_isready -U apns -d apns
docker compose exec -T redis redis-cli ping
```

Compose mounts [init.sql](./backend/src/db/init.sql), which creates the schema on the first start of an empty PostgreSQL volume. It does **not** load sample accounts. After PostgreSQL is ready, run the seed once:

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U apns -d apns < backend/db-seed/seed.sql
```

For an existing database that lacks the tables (including volumes created before the `provider_keys` table was added), apply the schema before seeding. From `apns/backend` after `npm install`:

```bash
npm run db:migrate
```

`db:migrate` reapplies `init.sql`, whose statements are all `IF NOT EXISTS`. It adds missing tables but does not migrate an incompatible existing table definition.

Useful lifecycle commands, from `apns/`:

```bash
docker compose down
# Remove this project's database and Valkey volumes as well:
docker compose down -v
```

The second command deletes local data. The current Valkey volume is named `redis_state`; an older `redis_data` volume is not used by this configuration.

## Option B: Native installation (no Docker)

On macOS, install and start the services:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
```

Create the role and database once, connecting as the Homebrew PostgreSQL administrator:

```bash
psql postgres -c "CREATE ROLE apns WITH LOGIN PASSWORD 'apns_password';"
createdb -O apns apns
```

From the repository root, load the schema and seed:

```bash
cd apns
PGPASSWORD=apns_password psql -h localhost -U apns -d apns -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
PGPASSWORD=apns_password psql -h localhost -U apns -d apns -v ON_ERROR_STOP=1 -f backend/db-seed/seed.sql
PGPASSWORD=apns_password psql -h localhost -U apns -d apns -c 'SELECT COUNT(*) FROM admin_users;'
valkey-cli ping
```

The last two commands should report three seeded users and `PONG` on a fresh setup. Reuse existing roles/databases rather than recreating them.

## Start the application

In one terminal, from `apns/`:

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

The entry point loads `.env` through `dotenv/config`. Defaults are:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgres://apns:apns_password@localhost:5432/apns` | PostgreSQL pool |
| `REDIS_URL` | `redis://localhost:6379` | Valkey connection |
| `PORT` | `3000` | HTTP/WebSocket listener and server ID |
| `NODE_ENV` | `development` in the example | Development logging |
| `LOG_LEVEL` | `debug` in development, otherwise `info` | Pino level |

In another terminal, from `apns/`:

```bash
cd frontend
npm install
npm run dev
```

Open [the console](http://localhost:5173), then log in with **admin / password123**. `operator` and `developer` also use `password123`; all three seeded accounts have the same `admin` role. The login screen's `admin123` hint is stale. Passwords use unsalted SHA-256, despite an obsolete bcrypt comment in the seed.

The seed contains eight devices, thirteen subscriptions, seven history records, six delivery-log entries, two pending messages, and two feedback entries. These are illustrative fixtures: pending IDs do not have matching history records, and stored token hashes do not supply usable raw tokens. Use an internal seeded device UUID in the send form, or register a new raw token for token-based requests.

Seeding is not fully repeatable: a pending row with a null collapse ID can hit its primary-key conflict on rerun, and feedback inserts append when reached. With `ON_ERROR_STOP=1`, a failed seed stops at that statement; earlier statements may already have committed.

## Try a simulated delivery

Register a demonstration token. Registration is the device's own call; the raw token is its secret:

```bash
curl -sS http://localhost:3000/api/v1/devices/register \
  -H 'Content-Type: application/json' \
  -d '{"token":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","app_bundle_id":"com.example.test","device_info":{"platform":"iOS"}}'
```

In the browser developer console on the local dashboard, connect as that device. The socket authenticates with the raw token; a device UUID alone is refused:

```javascript
const deviceSocket = new WebSocket('ws://localhost:3000/ws');
deviceSocket.onopen = () => deviceSocket.send(JSON.stringify({
  type: 'connect',
  device_token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
}));
deviceSocket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log(message);
  if (message.type === 'notification') {
    deviceSocket.send(JSON.stringify({ type: 'ack', notification_id: message.id }));
  }
};
```

To send as a provider, an admin first issues a signing key for the app. From `apns/backend`, log in, save the key (its private key is returned only once), and mint a JWT that is valid for an hour:

```bash
SESSION=$(curl -sS http://localhost:3000/api/v1/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"password123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -sS http://localhost:3000/api/v1/admin/provider-keys \
  -H "Authorization: Bearer $SESSION" -H 'Content-Type: application/json' \
  -d '{"team_id":"TEAM000001","app_bundle_ids":["com.example.test"]}' > provider-key.json
PROVIDER_JWT=$(npm run -s provider:token -- provider-key.json)
```

Then send to the device's token:

```bash
curl -sS http://localhost:3000/api/v1/notifications/device/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  -H "Authorization: Bearer $PROVIDER_JWT" -H 'Content-Type: application/json' \
  -d '{"payload":{"aps":{"alert":{"title":"Local test","body":"Hello from the simulator"}}},"priority":10}'
```

Or paste the `device_id` from registration into the console's send form, which uses your admin session. `provider-key.json` holds a private key; delete it when you are done.

Close the socket, send again, and reconnect to explore offline storage. The response's `delivered` label means the service published to Valkey; the history record changes to `delivered` only after acknowledgement. Refresh the notification list after receipt. Reconnection removes pending rows before acknowledgement, so this experiment does not establish reliable store-and-forward delivery.

## API reference

| Method and path | Purpose |
|-----------------|---------|
| `POST /api/v1/admin/login`, `POST /api/v1/admin/logout`, `GET /api/v1/admin/me` | Session creation, deletion, lookup |
| `GET /api/v1/admin/stats`, `/devices`, `/notifications`, `/feedback` | Console data; lists accept `limit` and `offset` |
| `POST /api/v1/admin/broadcast`, `/cleanup`, `/users` | Broadcast, expire messages, create account |
| `POST /api/v1/admin/provider-keys`, `GET /provider-keys`, `DELETE /provider-keys/:keyId` | Issue (private key returned once), list, revoke provider signing keys |
| `POST /api/v1/devices/register` | Register raw token and bundle ID |
| `GET /api/v1/devices/token/:token`, `GET /api/v1/devices/:deviceId` | Token or UUID lookup |
| `DELETE /api/v1/devices/token/:token` | Invalidate and record feedback |
| `POST /api/v1/devices/topics/subscribe`, `/unsubscribe` | Body contains `device_token` and `topic` |
| `GET /api/v1/devices/:deviceId/topics` | List subscriptions |
| `POST /api/v1/notifications/device/:token`, `/device-id/:deviceId`, `/topic/:topic` | Send `payload` with optional `priority`, `expiration`, `collapse_id` |
| `GET /api/v1/notifications`, `/:notificationId`, `/:notificationId/status` | List, inspect, check history |
| `GET /api/v1/feedback/:appBundleId`, `DELETE /api/v1/feedback/:appBundleId` | Read after `since`, clear through `before` |
| `POST /3/device/:token` | HTTP simulator route with selected `apns-*` headers and bare payload |
| `GET /health`, `GET /metrics` | Dependency health and Prometheus output |

### Authentication

| Caller | Credential | Routes |
|--------|------------|--------|
| Console admin | 24-hour random session from `/admin/login`, sent as `Authorization: Bearer ...` (stored in localStorage) | Every `/api/v1/admin/*` route except login and logout; also accepted on provider routes for console test sends |
| Provider | ES256 JWT, `Authorization: bearer ...`, header `kid` = key ID, claims `iss` = team ID and `iat`; rejected after one hour | `/api/v1/notifications/*`, `/3/device/:token`, `/api/v1/feedback/*`, and the device-UUID lookups. Limited to the key's app bundles |
| Device | Raw 64-hex token, matched against its stored hash | `/ws` (`connect` with `device_token`), and the token-keyed `/api/v1/devices` routes |

A provider key covering `com.example.test` cannot send to, read history of, or clear feedback for another app's devices; topic sends reach only its own apps' subscribers. A socket must authenticate within 10 seconds and can only acknowledge its own notifications. Roles are labels only: every admin session has full console access. Treat this as a local learning service: there is no TLS, CSRF protection, or login rate limit.

## Distributed experiment and verification

From `apns/backend`, run `npm run dev:server1`, `npm run dev:server2`, and optionally `npm run dev:server3` in separate terminals. They use ports 3001–3003 and IDs derived from those ports. Connect a device to one port and send to another. Share the same PostgreSQL and Valkey instances. There is no load balancer; Vite still proxies to port 3000 unless its configuration is changed.

Backend scripts include `build`, `type-check`, `lint`, `start` after a build, `test` (Vitest unit tests for provider-token verification and the auth middleware), `db:migrate`, `provider:token`, and `verify:auth`. With the stack up and seeded, `npm run verify:auth` drives simulated devices and providers end to end: register → send → deliver → ack, plus refused device hijack, foreign acks, unauthenticated admin/provider calls, and cross-app sends. Set `API_URL`/`DEVICE_API_URL` to point it at other ports (for example a device on 3002 and sends through 3001). Frontend scripts include `build`, `type-check`, `lint`, and `preview`. From the repository root, `npm run test:smoke apns` runs five page smoke checks. They do not test acknowledgement loss, collapse races, or retry safety.

Other limitations appear in [Implementation Notes](./architecture.md#implementation-notes): no certificate-based provider auth, sandbox/production scoping, TLS, or HTTP/2, no active priority worker, no heartbeat leases, incomplete idempotency, and inconsistent expiration/collapse behavior. This documentation review checked source and configuration; it did not run the stack or certify delivery behavior.

## Design and interview material

- [Architecture and implementation evidence](./architecture.md)
- [Frontend interview answer](./system-design-answer-frontend.md)
- [Backend interview answer](./system-design-answer-backend.md)
- [Fullstack interview answer](./system-design-answer-fullstack.md)
- [Project development history](./CLAUDE.md)
