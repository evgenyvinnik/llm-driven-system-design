# FaceTime — WebRTC calling demo

A local learning project for tracing a one-to-one audio/video call through a React interface, WebSocket signaling, WebRTC negotiation, and PostgreSQL/Redis call state. It includes a contact picker, incoming-call screen, local/remote video elements, mute/video controls, and a Coturn configuration. It is inspired by a calling product; it does not document Apple's implementation.

**Current implementation boundary:** selecting a username is not authentication, and socket handlers do not enforce call membership. The default browser setup also misses TURN credentials, while a circuit-breaker closure bug can reuse the first user's or call's database parameters. These and the signaling/media lifecycle issues below prevent treating the current app as a verified, reliable calling service.

The [architecture](./architecture.md) separates a proposed production system from the actual source and schema. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) interview answers present smaller designs suitable for discussion at a whiteboard.

## What is implemented

| Area | Actual behavior |
|------|-----------------|
| Identity and contacts | Pick one of four seeded users; fetch all users; no passwords, session cookie, or registration UI |
| Call interface | Outgoing/incoming screens, local preview, one remote stream, mute, video toggle, end call |
| Signaling | Device registration, process-local ring fan-out, answer/decline/end, SDP and ICE relay |
| Persistence | Separate SQL call/participant writes and a Redis call JSON value; no coordinated transaction |
| History | Public HTTP history/detail reads from calls and participants; no history UI |
| Infrastructure | PostgreSQL, Valkey, and optional Coturn relay service |
| Operations | Pino logs, Prometheus metrics, dependency probes, socket heartbeat checks |

There is no working group-call topology, SFU, screen sharing, camera switching, effects, device handoff, push ringing, or SharePlay. A group-shaped request exists on the server, but the first answer makes later answers fail the ringing check, and the UI has only one peer connection and remote stream.

WebRTC media uses its normal encrypted transport; the local implementation is not “unencrypted WebRTC.” Account/peer identity verification and an additional group-media encryption layer are absent. See the [WebRTC security architecture](https://www.rfc-editor.org/rfc/rfc8827.html#section-6.5).

## Stack and ports

Use Node.js 20+ and npm. The frontend specifies React 19, Vite 6, TypeScript, Zustand 5, and Tailwind CSS 3. It switches screens from application state and does not use a router. The backend uses Express 4, `ws`, `pg`, node-redis 4, Opossum, Pino, and prom-client. Session packages are installed but unused.

| Service | Local address | Defaults |
|---------|---------------|----------|
| Frontend | http://localhost:5173 | Proxies only `/api` and `/ws` to 3001 |
| API/signaling | http://localhost:3001 | `npm run dev`; config fallback is 3000 |
| PostgreSQL 16 | localhost:5432 | User/database `facetime`; password `facetime_dev_password` |
| Valkey 7 | localhost:6379 | No development password; append-only persistence |
| Coturn | localhost:3478 UDP/TCP | Realm `facetime.local`; user `facetime`, password `facetime123` |
| TURN relay allocation range | UDP 49152–49200 | Must be reachable for relayed media |

Compose publishes 5349, but explicitly disables TLS and DTLS on Coturn. Publishing that port does not enable a TLS TURN listener. The browser's WebRTC media encryption is a separate matter from the client-to-TURN transport setting.

## Infrastructure

Choose Docker or native services, then initialize the database and run the applications. Only one project should occupy the shared database/cache ports at a time.

### Option A: Docker Compose (recommended)

From `facetime`:

```bash
docker compose up -d
docker compose ps
docker compose exec postgres pg_isready -U facetime -d facetime
docker compose exec redis redis-cli ping
docker compose logs --tail=30 coturn
```

Compose starts infrastructure, not the backend or frontend. PostgreSQL executes the mounted initialization SQL on the first creation of its data volume. That SQL creates tables but does not seed users.

```bash
# Stop services while preserving data.
docker compose down
# Delete this project's database/cache volumes for a fresh demo.
docker compose down -v
```

The legacy `docker-compose` executable is also usable; the repository screenshot runner uses that spelling.

### Option B: Native installation (macOS, no Docker)

```bash
brew install postgresql@16 valkey coturn
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"

# Create this role/database once.
psql postgres -c "CREATE ROLE facetime LOGIN PASSWORD 'facetime_dev_password';"
createdb -O facetime facetime

PGPASSWORD=facetime_dev_password psql -h localhost -U facetime -d facetime -c 'SELECT 1;'
valkey-cli ping
```

In a separate terminal, run a local Coturn process with the demo credentials:

```bash
turnserver -n --listening-ip=127.0.0.1 --relay-ip=127.0.0.1 \
  --listening-port=3478 --min-port=49152 --max-port=49200 \
  --no-cli --no-tls --no-dtls --realm=facetime.local \
  --user=facetime:facetime123 --lt-cred-mech --fingerprint \
  --log-file=stdout
```

This loopback configuration is for local service inspection, not a relay reachable by another computer. In another terminal, `turnutils_stunclient -p 3478 127.0.0.1` checks STUN responsiveness; it does not prove authenticated TURN allocation or successful relayed media. Coturn logs provide additional startup information. See [Homebrew's Coturn package](https://formulae.brew.sh/formula/coturn) and the [Coturn command reference](https://github.com/coturn/coturn/wiki/turnserver).

Stop the foreground relay with Ctrl+C. `brew services stop postgresql@16` and `brew services stop valkey` preserve native data.

## Database initialization and seed data

There is no `db:migrate` or `db:seed` npm script, and the backend does not initialize tables at startup. From `facetime/backend`, use a local `psql` client for either infrastructure option:

```bash
PGPASSWORD=facetime_dev_password psql -v ON_ERROR_STOP=1 \
  -h localhost -U facetime -d facetime -f src/db/init.sql
PGPASSWORD=facetime_dev_password psql -v ON_ERROR_STOP=1 \
  -h localhost -U facetime -d facetime -f db-seed/seed.sql
```

For Docker without a local PostgreSQL client, use this equivalent pair from `facetime`:

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U facetime -d facetime < backend/src/db/init.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U facetime -d facetime < backend/db-seed/seed.sql
```

Choose one pair. Initialization uses `IF NOT EXISTS`; it does not migrate an existing table definition. The seed inserts four fixed-ID users and four sample device rows. Existing usernames are skipped, but device IDs are freshly generated, so rerunning adds more sample devices. There is no enclosing seed transaction or sample call history. If an existing username has a different ID, the fixed-ID device inserts do not remap it.

| Username | Display name | Stored role |
|----------|--------------|-------------|
| `alice` | Alice Smith | user |
| `bob` | Bob Johnson | user |
| `charlie` | Charlie Brown | user |
| `admin` | Admin User | admin |

There are no passwords. The `admin` value does not enable an admin UI or authorize a protected endpoint; no such role enforcement exists. Seeded device rows also do not create online sockets.

## Run the applications

From `facetime/backend`:

```bash
npm install
npm run dev
```

In another terminal, from `facetime/frontend`:

```bash
npm install
npm run dev
```

Open [the user picker](http://localhost:5173). Selecting a user sends an HTTP lookup and opens a socket that claims that user's ID. For studying the calling flow, use separate browser profiles for Alice and Bob. The browser stores one `deviceId` in localStorage, so ordinary same-origin tabs share it, including across selected accounts.

The intended interaction is to choose Audio or Video next to a contact, grant browser media permission, and accept in the other profile. The current defects below can prevent completion; successful contact rendering is not evidence of working media. Camera/microphone access on other hosts requires an appropriate secure browser context, and `localhost` in a TURN URL means the machine running that browser.

### Environment variables

No `.env` loader or example is supplied. Export variables in the shell before launching the backend; merely creating a `.env` file has no effect.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Development scripts explicitly select 3001/3002/3003 |
| `DB_HOST` / `DB_PORT` | `localhost` / `5432` | PostgreSQL location |
| `DB_USER` / `DB_PASSWORD` | `facetime` / `facetime_dev_password` | PostgreSQL credentials |
| `DB_NAME` | `facetime` | Database name |
| `REDIS_URL` | `redis://localhost:6379` | Redis-compatible client URL |
| `CORS_ORIGIN` | `http://localhost:5173` | HTTP allowed origin; does not authorize socket upgrades |
| `TURN_URL` | `turn:localhost:3478` | URL returned by the credential endpoint |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | `facetime` / `facetime123` | Static credentials; must match the relay configuration |
| `LOG_LEVEL` / `APP_VERSION` | `info` / `dev` | Pino level and service metadata |
| `NODE_ENV` | Unset by npm scripts | Logged environment falls back to development |

`dev:server1`, `dev:server2`, and `dev:server3` directly launch ports 3001, 3002, and 3003. Those scripts work as port choices, but each process has separate connection/ring maps. A caller on one process cannot ring a callee on another. Redis alone does not provide cross-process routing or atomic call transitions. Vite continues to target 3001.

## Verification and troubleshooting

| Location | Command / endpoint | What it checks |
|----------|--------------------|----------------|
| Backend | `npm run build` | TypeScript output in `dist`; `npm start` runs `dist/index.js` |
| Frontend | `npm run build` / `npm run type-check` | TypeScript and optional Vite bundle |
| Either app | `npm run lint` | Existing lint configuration; not a media test |
| Project root | `npm install` then `npm run test:e2e` | One login-screen smoke test |
| Repository root | `npm run test:smoke facetime` | Existing smoke runner; infrastructure/backend must be available |
| Repository root | `node scripts/screenshots.mjs --start facetime` | Seed/start/capture login and contact screens |
| Backend 3001 | `/health`, `/health/ready`, `/health/live` | PG/Redis checks or process liveness |
| Backend 3001 | `/metrics`, `/stats` | Prometheus text and process-local connection summary |

There is no backend test script. Playwright can start Vite, but does not start the backend or infrastructure. Its single assertion on the user-picker container can pass even when no users were loaded. The screenshots do not establish a call, inspect audio/video, or test TURN.

A key setup limitation is that the frontend requests `/turn-credentials` on Vite's origin, while Vite proxies only `/api` and `/ws`. Credential parsing therefore fails in the default setup and the hook falls back to two public STUN servers. Fetching [the backend credential endpoint](http://localhost:3001/turn-credentials) directly verifies its response, but does not repair that browser route or prove relay usage. There is no selected-candidate-pair telemetry in the app.

## Important implementation limits

- **Request values reused:** the named Opossum registry retains the first action closure. Later cold user lookups can return the first profile; device writes can target the first device; a later call creation can retry the first call ID and hit a duplicate key. The user cache can retain an incorrectly associated profile for an hour.
- **Access:** all user/history/detail/credential endpoints are public. Socket registration checks that a claimed user exists, not who is calling. Answer/end/SDP/ICE handlers lack participant authorization. An unrelated registered client can affect a known call.
- **Call transitions:** answer checks Redis and then performs separate unconditional writes. Two devices can both succeed; answer, timeout, decline, and end can race. Partial SQL/Redis failures leave inconsistent state. The server marks a call connected on acceptance, before media connectivity is known.
- **Retries:** optional call-initiation keys are global, best-effort Redis lookups/writes without atomic reservation or body binding. A key is stored before SQL creation and can refer to a nonexistent call. The frontend supplies no key or replay queue. ICE deduplication is also best effort and does not include a negotiation generation.
- **Media lifecycle:** the caller's ICE callback can retain the initially empty call ID. Incoming messages are not scoped to the current call, candidate queues survive calls, and late media permission results can recreate streams after ending. Error/reset paths do not consistently close the peer connection. Server error messages have no UI handler.
- **Presence/recovery:** heartbeat pings update only process-local time; two registration helpers write competing 60-second/one-hour expirations to the same presence hash. Redis presence does not drive ring routing. Disconnect does not end or recover a call; ring timers are process-local, and accepted call state expires after two hours without refresh.
- **Logout/UI:** disconnect schedules reconnection with the old identity. The connection indicator reads a nonreactive socket value. Outgoing setup clears the selected callee list, so its name can appear as Unknown. Mute/video controls toggle tracks but do not notify peers; playback failures, quality changes, and device changes have no dedicated recovery UI.

This review inspected source and ran isolated mocked checks, including the real circuit-breaker wrapper. It did not run a full stack, browser media call, build, or network benchmark. See [Implementation Notes](./architecture.md#implementation-notes) for the exact source mapping and the proposed remedies.
