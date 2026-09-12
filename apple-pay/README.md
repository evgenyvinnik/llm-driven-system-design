# Apple Pay: wallet and payment simulation

This learning project models a wallet with device registration, provisioned cards, payment history, and a merchant view. A React application talks to one Express API backed by PostgreSQL and Valkey. It is useful for studying token lifecycle, authentication, and the difference between retry protection and payment correctness.

All credentials and authorization decisions are simulated. There is no Apple Pay JS, PassKit, NFC radio, Secure Element, issuer connection, or movement of money. Use the supplied test cards only: the provisioning form sends the entered PAN and CVV to the local server as JSON.

## What the implementation supports

| Area | Current behavior |
|------|------------------|
| Account | Register, sign in, restore a Redis session, and sign out |
| Devices | Register and list devices; removal and lost-device reporting also have API endpoints |
| Wallet | Display cards, device names, status, and default markers; forms/buttons exist for provisioning and lifecycle operations |
| Payments | An HTTP simulation with card selection, merchant, amount, and a simulated biometric modal |
| History | Date-grouped records; Load More refetches a larger prefix of history |
| Merchant | Select a merchant and view recent transactions; a button requests a sample checkout session |
| Backend instrumentation | Request logging, metrics, dependency health, and selected audit events |

**The browser currently omits the required `Idempotency-Key` header.** Consequently, adding/managing cards, starting biometric authentication, and creating merchant sessions return HTTP 400. A payment submitted with a verified biometric session also requires this header. The UI is useful for browsing seeded data, but the advertised purchase sequence does not currently run end to end through the checked-in client.

The API's Redis middleware demonstrates response caching and concurrent-request exclusion; it does not guarantee durable duplicate prevention. The [architecture](./architecture.md#consistency-and-idempotency) traces the failure windows and distinguishes implemented code from unused helpers.

## Stack and ports

| Component | Implementation | Default |
|-----------|----------------|---------|
| Frontend | React 19, TypeScript, Vite 5, TanStack Router, Zustand 4, Tailwind 3 | 5173 |
| API | Express 4, TypeScript, `tsx`, Node built-in crypto | 3000 |
| Database | PostgreSQL 16 | 5432; database/user `applepay` |
| Redis protocol | Valkey 7 with append-only persistence in Compose | 6379 |

Use Node.js **20 or newer**. The Vite proxy targets port **3000** in both checked-in Vite configurations. There is no queue, object store, external payment service, or admin dashboard. `express-session` and `crypto-js` are declared dependencies but are not used for sessions or cryptograms.

## Option A: Docker Compose (recommended)

Run these commands from `apple-pay/`. Start Docker Desktop first, and avoid competing projects on the same ports.

```bash
docker compose up -d
docker compose ps
```

PostgreSQL runs [init.sql](./backend/src/db/init.sql) automatically only when its data volume is new. Wait for the database to become healthy, then explicitly load the fixtures:

```bash
docker compose exec -T postgres psql -U applepay -d applepay \
  -v ON_ERROR_STOP=1 --single-transaction < backend/db-seed/seed.sql
```

The schema contains some unconditional index creation, so rerunning the complete initialization file against an initialized database is not a migration procedure. Neither `db:migrate` nor `db:seed` exists in the backend package scripts.

Inspect or stop the infrastructure with:

```bash
docker compose logs postgres redis
docker compose down
```

`docker compose down -v` additionally deletes the project's database and Redis volumes. Use it only when intentionally discarding local data; then initialize and seed again.

## Option B: native installation (macOS, no Docker)

From `apple-pay/`, install and start the two services:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
```

Create the application role with `createuser -P`; enter `applepay_secret` when prompted. These commands assume a fresh role/database and a working local PostgreSQL administrator connection:

```bash
createuser -P applepay
createdb -O applepay applepay
PGPASSWORD=applepay_secret psql -h localhost -U applepay -d applepay \
  -v ON_ERROR_STOP=1 --single-transaction -f backend/src/db/init.sql
PGPASSWORD=applepay_secret psql -h localhost -U applepay -d applepay \
  -v ON_ERROR_STOP=1 --single-transaction -f backend/db-seed/seed.sql
```

Verify the services:

```bash
PGPASSWORD=applepay_secret psql -h localhost -U applepay -d applepay \
  -c 'SELECT count(*) FROM merchants;'
valkey-cli ping
```

A fresh seed has seven merchants. Stop native services with `brew services stop postgresql@16` and `brew services stop valkey` when finished.

## Run the application

In one terminal, starting from `apple-pay/`:

```bash
cd backend
npm install
npm run dev
```

In another terminal, starting from `apple-pay/`:

```bash
cd frontend
npm install
npm run dev
```

Open [the wallet](http://localhost:5173). Check the API directly at [readiness](http://localhost:3000/health/ready) or [metrics](http://localhost:3000/metrics); Vite proxies `/api`, not these diagnostic routes.

The backend connects to both dependencies before listening. Connectivity checks do not verify that the schema and fixtures exist.

### Configuration

The code reads process environment variables. It does **not** load a `.env` file automatically. Export overrides in the backend terminal before starting it.

| Variable | Default |
|----------|---------|
| `PORT` | `3000` |
| `POSTGRES_HOST` | `localhost` |
| `POSTGRES_PORT` | `5432` |
| `POSTGRES_USER` | `applepay` |
| `POSTGRES_PASSWORD` | `applepay_secret` |
| `POSTGRES_DB` | `applepay` |
| `REDIS_HOST` | `localhost` |
| `REDIS_PORT` | `6379` |
| `FRONTEND_URL` | `http://localhost:5173` |
| `LOG_LEVEL` | `info` |
| `NODE_ENV` | Unset; enables pretty development logging |

The application does not read `DATABASE_URL`, `REDIS_URL`, or a session-cookie secret. Authentication uses an explicit `X-Session-Id` header with a one-hour sliding Redis expiry.

## Fixtures and walkthrough

The [SQL seed](./backend/db-seed/seed.sql) provides four users, seven devices, seven merchants, seven cards, ten transactions, six ATC rows, and six example audit events. It does not provision Redis token or Secure Element records, and the SQL ATC table is unused by payment processing.

| Email | Password | Role |
|-------|----------|------|
| `alice@example.com` | `password123` | User |
| `bob@example.com` | `password123` | User |
| `charlie@example.com` | `password123` | User |
| `admin@applepay.local` | `password123` | Admin value in the account record; no admin UI |

The shared seed hash was checked against `password123`. The login form's prefilled `demo@example.com` / `demo123` credentials are stale: replace them with a seeded account.

1. Sign in as Alice and inspect her devices and cards.
2. Open History to see approved and pending fixtures.
3. Open Merchant and switch merchants to inspect their records.
4. Register a new simulated device from Wallet if desired.
5. Inspect the card/payment forms with the known header integration gap in mind.

Some fixtures have expired card dates. As of September 2026, Alice's June 2026 Mastercard and Bob's September 2025 Visa are expired. Alice's December 2027 Visa is a better starting card. Alice also has two default markers because the seed assigns defaults on two devices, while the service treats default selection as user-wide.

The seed skips conflicts on selected natural keys; it is not a general reset. Repeating it appends audit rows and rewrites sample suspension/ATC values. Existing users with matching emails but different IDs can cause later foreign-key inserts to fail.

### Simulated decisions

These rules apply to the authenticated `/api/payments/pay` service after its middleware requirements are met:

| Amount | Result |
|--------|--------|
| `666.66` | Insufficient funds |
| `999.99` | Card declined |
| Greater than `10000` | Limit exceeded |
| Other positive values | Expiry check, then a 1% simulated network-error decline; otherwise approval |

Expiry is incorrectly tested at the **start** of the expiry month. Amounts use JavaScript numbers and are stored in a two-decimal SQL column; the API does not enforce currency-specific precision.

The separate merchant `/process` endpoint uses different rules: any amount **below** `10000` is approved, without looking up a card, checking a cryptogram, or recording a transaction. A merchant session is just a returned object with an expiry field; there is no persisted checkout or session consumption.

## API map

All paths below are implemented. Merchant endpoints currently have no merchant authentication or ownership checks.

| Group | Routes | Access / notable behavior |
|-------|--------|---------------------------|
| Account | `POST /api/auth/register`, `/login`; `GET /api/auth/me`; `POST /api/auth/logout` | Login returns a session ID; protected routes require `X-Session-Id` |
| Devices | `GET/POST /api/auth/devices`; `DELETE /api/auth/devices/:deviceId`; `POST /api/auth/devices/:deviceId/lost` | User session; no idempotency requirement |
| Cards | `GET/POST /api/cards`; `GET/DELETE /api/cards/:cardId`; `POST .../:cardId/suspend`, `/reactivate`, `/default` | User session; every mutation requires `Idempotency-Key` |
| Biometrics | `POST /api/payments/biometric/initiate`, `/verify`, `/simulate`; `GET /api/payments/biometric/:sessionId` | Session; initiate/verify require an idempotency key |
| Payment | `POST /api/payments/pay` | Session, verified `X-Biometric-Session`, then idempotency key |
| User history | `GET /api/payments/transactions`, `/transactions/:transactionId` | User session; list supports limit, offset, card_id, status |
| Merchant reads | `GET /api/merchants`, `/:merchantId`, `/:merchantId/transactions` | Public, including merchant transaction history |
| Merchant mutations | `POST /api/merchants/:merchantId/sessions`, `/process`, `/refund` | Public; idempotency key required |

The exact header is **`Idempotency-Key`**, not `X-Idempotency-Key`; accepted length is 16–128 characters. A client must retain an operation's key across retries. Adding this header alone would not resolve the durability, authorization, and refund gaps described in the architecture.

## Checks and known limitations

Build/type-check commands exist in each frontend/backend directory:

```bash
npm run type-check
npm run build
```

The project root also has `npm run test:e2e`; those Playwright tests need the running stack and suitable fixture credentials. See the repository's [runtime tooling](../AGENTS.md#screenshot--smoke-test-automation). This documentation review traced source/configuration and checked the seed password; it did not start the application or claim an end-to-end test pass.

Other material limitations include reusable simulated biometric authorization, no replay validation, non-atomic payment/refund writes, public merchant operations, and no rate limiting. Removing a default card commits its deletion before a PostgreSQL-incompatible fallback-default query fails. Network breakers are instantiated and reported in health, but the actual payment path never invokes them.

## Reading guide

- [Architecture](./architecture.md): proposed production design and source-backed local implementation.
- [Frontend interview](./system-design-answer-frontend.md): payment UI state, privacy, and recoverable interactions.
- [Backend interview](./system-design-answer-backend.md): provisioning, durable operation identity, and network uncertainty.
- [Full-stack interview](./system-design-answer-fullstack.md): one checkout across client, merchant, wallet, and processor.
- [Development history](./CLAUDE.md): earlier reasoning; some historical implementation claims are superseded by the source audit in the architecture.
