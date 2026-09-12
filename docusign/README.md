# DocuSign: electronic signature workflow

A system design learning project for preparing PDFs, assigning fields to recipients, and coordinating a signing workflow. React provides sender, signer, and administrator screens; one Express API stores metadata in PostgreSQL, sessions in Valkey/Redis, and original PDFs and signature images in MinIO. RabbitMQ integration is present but currently incompatible with the included worker.

**Current status:** draft preparation and seeded document viewing are implemented. The normal signing sequence has a confirmed cache-contract defect: opening a signing session stores recipient identifiers under names that the write endpoints do not read, so signing an assigned field returns 403. Completion, notification delivery, audit verification, and document export also have limitations described below. This is a teaching implementation, with no demonstrated legal compliance or certification.

Read [architecture.md](./architecture.md) for the production proposal, exact local schema, and source-backed limitations. The [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) interview answers describe proposed designs you can explain at a whiteboard. [CLAUDE.md](./CLAUDE.md) records earlier development history; some historical completion claims exceed current behavior.

## What you can explore

| Persona | Implemented interface | Practical limits |
|---------|-----------------------|------------------|
| Sender | Register/login, dashboard, envelope list, create draft, upload PDF, add recipients, click to place fields, send/void, audit tab | No templates UI, document versioning, drag/resize editor, or live status updates |
| Signer | Token link, one-page PDF viewer, field checklist, draw/type signature modal, date/text/checkbox actions, finish/decline screens | Cached signer mismatch blocks normal writes; no enforced routing gate, expiration, or additional authentication |
| Administrator | Statistics, users and role changes, envelopes, simulated email records | Lists show the first page; a View link opens the sender route and cannot inspect another sender's envelope there |
| Developer | Health endpoints, Prometheus metrics, Pino logs, queue and storage helpers | These do not establish delivery, tamper resistance, or recovery guarantees |

Both PDF viewers render at a fixed 700 CSS-pixel width. Fields use pixels relative to the surrounding viewer, not normalized page coordinates. The signing overlay shows completion checkmarks rather than the stored signature image or entered value. PDF downloads return the original bytes; a completed envelope does not produce a flattened, digitally signed PDF.

## Stack and prerequisites

- Node.js 20 or newer and npm; use an actively supported Node release for your environment.
- React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS, React-PDF/PDF.js, and Signature Pad.
- Express 4, PostgreSQL 16, Valkey 7 in Compose, MinIO, and RabbitMQ 3 in Compose.
- `pdf-lib` parses uploads and generates seed PDFs. There is no separate PDF processing worker.

[React-PDF](https://github.com/wojtekmaj/react-pdf) is the PDF **viewer** dependency. The worker is loaded from unpkg by both viewer routes, so viewing also depends on that external resource. No React Query or Zod integration is present.

Commands below start from this project's directory (`docusign`). Only one project should use the default ports at a time.

## Infrastructure

### Option A: Docker Compose (recommended for matching project services)

```bash
docker compose up -d
docker compose ps
docker compose logs minio-init
```

Compose starts infrastructure only. Run the API and frontend separately below. PostgreSQL runs [init.sql](./backend/src/db/init.sql) only when its data directory is first initialized; API startup only checks connectivity. There is no `db:migrate` script. If using an existing, empty database that has not been initialized, apply the schema once:

```bash
docker compose exec -T postgres psql -U docusign -d docusign -v ON_ERROR_STOP=1 < backend/src/db/init.sql
```

Do not rerun that command against an already initialized schema: the table creation statements are not idempotent. A successful `minio-init` exit is insufficient proof of bucket creation because its script ends with unconditional success. Inspect the buckets in the console or with `mc`.

The supplied initializer grants anonymous download access to both buckets. This is a local demo configuration, and authenticated API routes do not make those objects private. Native instructions below create private buckets instead. Compose uses moving MinIO image tags and provides no object versioning, retention lock, or encryption configuration.

```bash
docker compose down
# Optional destructive reset: removes the project's database/object/queue volumes.
docker compose down -v
```

### Option B: native installation on macOS (no Docker)

Homebrew's [PostgreSQL 16 formula](https://formulae.brew.sh/formula/postgresql@16) and [RabbitMQ formula](https://formulae.brew.sh/formula/rabbitmq) provide service commands. MinIO publishes its own [Homebrew tap](https://github.com/minio/homebrew-stable). Native formula versions may differ from Compose.

```bash
brew install postgresql@16 valkey rabbitmq
brew install minio/stable/minio minio/stable/mc
brew services start postgresql@16
brew services start valkey
brew services start rabbitmq
export PATH="$(brew --prefix postgresql@16)/bin:$(brew --prefix rabbitmq)/sbin:$PATH"
```

Create the database and role once, from your local PostgreSQL administrator account. These are development credentials:

```bash
psql postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE docusign WITH LOGIN PASSWORD 'docusign_dev';"
createdb -O docusign docusign
PGPASSWORD=docusign_dev psql -h localhost -U docusign -d docusign -v ON_ERROR_STOP=1 -f backend/src/db/init.sql
pg_isready -h localhost -U docusign -d docusign
valkey-cli ping
```

Start MinIO in a separate terminal and keep it running:

```bash
mkdir -p "$HOME/.local/share/docusign-minio"
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin123 minio server "$HOME/.local/share/docusign-minio" --console-address ':9001'
```

In another terminal, create and inspect the buckets, then provision RabbitMQ:

```bash
mc alias set docusign-local http://localhost:9000 minioadmin minioadmin123
mc mb --ignore-existing docusign-local/docusign-documents
mc mb --ignore-existing docusign-local/docusign-signatures
mc ls docusign-local
curl -f http://localhost:9000/minio/health/live
rabbitmqctl add_user docusign docusign123
rabbitmqctl set_permissions -p / docusign '.*' '.*' '.*'
rabbitmqctl set_user_tags docusign management
rabbitmq-plugins enable rabbitmq_management
rabbitmq-diagnostics -q ping
```

If the role, database, or RabbitMQ user already exists, inspect and reuse it instead of recreating it. Do not start native services on ports already occupied by Compose.

## Run the application

First ensure PostgreSQL, Valkey, and MinIO are reachable. The backend retries their initialization, but does not run migrations. Starting it before MinIO is ready can leave Redis already connected during the next initialization attempt; restart the API once dependencies are ready if this occurs.

From `docusign`, install dependencies and seed the already initialized database:

```bash
cd backend
npm install
npm run db:seed
npm run dev
```

In another terminal, from `docusign`:

```bash
cd frontend
npm install
npm run dev
```

Open [the frontend](http://localhost:5173), [API readiness](http://localhost:3001/health/ready), [MinIO console](http://localhost:9001), and [RabbitMQ management](http://localhost:15672). The API dev script fixes port 3001; bare `npm start` uses port 3000 unless `PORT=3001` is exported. Vite proxies `/api` to port 3001. The frontend build does not supply a production reverse proxy.

### Configuration

The application reads exported environment variables; it does not automatically load `.env`. Repeat exports in each API, worker, or seed terminal that needs overrides. Compose container variables are not exports into your host shell.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | Dev/server1 scripts override to 3001; server2/3 use 3002/3003 |
| `POSTGRES_HOST`, `POSTGRES_PORT` | `localhost`, `5432` | Individual variables, not `DATABASE_URL` |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | `docusign`, `docusign`, `docusign_dev` | PostgreSQL pool has maximum 20 connections per process |
| `REDIS_URL` | `redis://localhost:6379` | User sessions 24 hours; signer cache 1 hour |
| `MINIO_ENDPOINT`, `MINIO_PORT` | `localhost`, `9000` | Endpoint is a hostname without scheme/port |
| `MINIO_USE_SSL` | false | Enabled only by the string `true` |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | `minioadmin`, `minioadmin123` | Buckets are fixed in source |
| `RABBITMQ_URL` | API: `amqp://docusign:docusign123@localhost:5672` | Worker defaults to `guest:guest`, so export the API URL there |
| `FRONTEND_URL` | `http://localhost:5173` | Used to construct simulated email links |
| `NODE_ENV`, `LOG_LEVEL` | unset, `info` | Production mode changes cookie security and logger transport |

The queue worker is an **incomplete integration**, not a required step for a successful signing demo. For investigating it after API queue initialization:

```bash
cd backend
export RABBITMQ_URL='amqp://docusign:docusign123@localhost:5672'
npm run dev:worker
```

Matching credentials does not repair its payload or schema mismatches. With a reachable broker, messages can be accepted without producing simulated emails. With the broker unavailable at API initialization, notification code uses the synchronous email simulator. Neither path sends real email.

### Seed data

The actual seed is [seed-envelopes.ts](./backend/src/db/seed-envelopes.ts), invoked by `npm run db:seed`. The schema's comment referring to `db-seed/seed.sql` is stale; that file does not exist.

| Account | Role | Password on fresh seed |
|---------|------|------------------------|
| `admin@docusign.local` | Administrator and owner of all four seeded envelopes | `password123` |
| `alice@example.com` | User / NDA recipient | `password123` |
| `bob@example.com` | User / consulting recipient | `password123` |
| `carol@example.com` | User / completed offer recipient | `password123` |

The login screen says any password works for test accounts; the backend actually verifies bcrypt hashes. Seed reruns preserve existing users and skip envelopes with existing IDs. A failed partial seed is not repaired by that skip logic.

The seed creates four one-page PDFs, four recipients, and eight fields across sent, delivered, completed, and draft envelopes. The completed sample marks fields complete without creating captured signature records. These are fixtures, not evidence of a successful signing run.

To inspect the NDA ceremony, open [Alice's local signing fixture](http://localhost:5173/sign/sign-nda-alice-0000000000000001). It can show the page and signature modal; submitting encounters the cache mismatch described above. Signer recipients are separate records from user accounts, so logging in as Alice does not make the admin-owned envelopes appear in Alice's sender list.

## Known behavior and gaps

| Area | Source-backed limitation |
|------|--------------------------|
| Signing authentication | Session GET caches `recipientId`/`envelopeId`; middleware expects `id`/`envelope_id`. The flags for SMS/knowledge/ID checks have no implemented challenge or enforcement |
| Workflow | Only sending takes an envelope row lock. Draft edits, signing, completion, decline, and void are separate checks/writes; routing order controls notification choice, not permission to sign |
| Completion | Sender notification uses a user ID as `email_notifications.recipient_id`, normally failing its recipient foreign key after the envelope is already completed |
| Idempotency | Check, mutation, and receipt storage are separate. Concurrent requests can both execute; Redis errors skip the SQL fallback. The UI sends no operation key |
| Audit | Two writers use incompatible hash payloads; the shared writer's own verifier rejects its stored representation. No independently anchored digest or append-only database enforcement |
| Queue | Worker expects bare messages instead of the publisher's wrapper and references missing tables. Dead-letter routing also does not match the supplied DLQ binding |
| Documents | Multipart PDF limit is 25 MiB, parsed in memory. No flattening, signed export, malware scanning, content digest, versioned document binding, or storage cleanup when metadata is deleted |
| Frontend | No drag/resize, zoom, upload progress, offline draft persistence, automatic polling, or request cancellation. PDF text/annotation layers are hidden; signing overlays are clickable divs without keyboard semantics |
| Recovery | Status may commit before audit/notification errors return 500. Reload and inspect state; retrying does not guarantee one effect |

See [Implementation Notes](./architecture.md#implementation-notes) for exact paths and the distinction between registered helpers and active behavior. The certificate endpoint returns JSON audit data, not a certificate PDF, and its verification boolean is not a compliance verdict. Completion-page and simulated email copy currently overstate delivery/export functionality.

## Development checks

From the relevant package directory:

```bash
# backend
npm run type-check
npm run lint
# frontend
npm run type-check
npm run build
npm run lint
```

There is no backend `test` or `build` script. Root [screenshot configuration](../scripts/screenshot-configs/docusign.json) includes viewing the ceremony and opening its modal; it does not submit a signature. Existing smoke tests mainly check page rendering, not workflow correctness. Run them only after explicitly setting up the backing services and seed.

This documentation review used source inspection and isolated executions of the actual TypeScript modules with mocked SQL, Redis, and storage dependencies. Those checks confirmed the cached-signer 403, audit-format mismatch, idempotency race/fallback behavior, and completion notification ordering. No full Docker stack, browser ceremony, load test, or legal certification was performed.
