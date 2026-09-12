# GitHub — code hosting and review

A GitHub-inspired learning project that combines real bare Git repositories with PostgreSQL collaboration metadata, Redis sessions/cache, and an Elasticsearch code-search adapter. The useful design problem is keeping a moving branch, the code somebody reviewed, and the recorded pull request outcome consistent. This is not documentation of GitHub's internal architecture.

The local application is a partially connected prototype. Its repository overview and authentication have concrete implementations, while several deeper screens and production guarantees are incomplete. Read [architecture.md](./architecture.md) for the proposed system and the verified implementation boundaries.

## What the project contains

| Area | Current behavior |
|------|------------------|
| Accounts | Register, sign in, and sign out with bcrypt passwords and seven-day Redis sessions |
| Repositories | Create a personal repository, optionally initialize a README, list metadata, and star/unstar from the repository overview |
| Git reads | REST handlers for immediate directory entries, file text, branches, tags, and commit history using system Git through simple-git |
| Collaboration APIs | Issues, labels, comments, discussions, basic reviews, and pull request creation/update/merge handlers |
| Search | PostgreSQL search for public repositories/issues and users; Elasticsearch code/symbol search helpers with no automatic indexing caller |
| Operations | Pino request logs, selected audit writes, Prometheus metrics, health probes, and admin breaker/audit APIs |

**UI limitation:** The generated router nests tree, blob, issues, pulls, and discussions under the repository route, but `RepoPage` contains no `Outlet`. The issues list also lacks the outlet needed by issue detail. Those child components exist in source but cannot be described as reachable working screens in the current composition. Other unfinished controls include the branch selector, Fork/Watch/Code buttons, repository Settings, and links to profile, Explore, compare/new PR, new issue, and discussion detail/create pages.

**Data and workflow limitations:** Private-repository checks do not cover all Git/content/collaboration/search routes. Merge is a Git operation followed by a separate SQL update, without required-review enforcement or a durable merge receipt. Use disposable learning data. There is no SSH/Smart HTTP Git server, branch-editing API, web editor, fork implementation, webhook sender, CI runner, or live notification channel.

## Stack and prerequisites

Use Node.js 22, npm, and system Git. The repository requires Node 20 or later; the installed router requires at least 20.19 and Opossum 9 supports the 20/22/24 release lines.

- Frontend: React 19, Vite 5, TanStack Router, Zustand 4, Tailwind 3, highlight.js, and lucide-react.
- Backend: TypeScript ES modules, tsx, Express 4, pg, node-redis 4, simple-git, and Elasticsearch 8 client.
- Infrastructure: PostgreSQL 16, Valkey 7, Elasticsearch 8.12.0, plus a writable local Git repository directory.

The declared react-markdown, isomorphic-git, and express-session dependencies are not wired into their corresponding rendering, Git, or session flows.

## Run locally

Commands below use the repository root unless a working directory is stated. Install application dependencies:

```bash
npm install --prefix github/backend
npm install --prefix github/frontend
```

### Option A: Docker Compose (recommended)

```bash
cd github
docker compose up -d
docker compose ps
docker compose exec -T postgres pg_isready -U github -d github
docker compose exec -T redis redis-cli ping
curl --fail http://localhost:9200/_cluster/health
```

Compose starts PostgreSQL (`github` / `github_dev_password`, database `github`) on 5432, Valkey on 6379, and Elasticsearch on 9200 with a 512 MB JVM heap. Elasticsearch security is disabled for the local demo. Its transport port 9300 is also exposed. These ports overlap other projects.

PostgreSQL applies [init.sql](./backend/src/db/init.sql) only when creating a fresh data volume. There is no migration script. To apply missing schema objects to an existing development database, run this from `github`; `IF NOT EXISTS` does not upgrade existing table definitions:

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U github -d github < backend/src/db/init.sql
```

`docker compose down` stops the infrastructure. `docker compose down -v` also deletes its database/cache/search volumes. The host Git repositories survive that command; database and Git storage must be handled together when resetting a demo.

### Option B: Native installation on macOS (no Docker)

Install PostgreSQL and Valkey, then create the local database once:

```bash
brew install postgresql@16 valkey
brew services start postgresql@16
brew services start valkey
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
psql postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE github LOGIN PASSWORD 'github_dev_password';"
createdb -O github github
PGPASSWORD=github_dev_password psql -h localhost -U github -d github -v ON_ERROR_STOP=1 -f github/backend/src/db/init.sql
pg_isready -h localhost -U github -d github
valkey-cli ping
```

For Elasticsearch, download the matching macOS Intel or Apple Silicon archive and its checksum from the [official 8.12.0 release](https://www.elastic.co/downloads/past-releases/elasticsearch-8-12-0). Verify with `shasum -a 512 -c` and extract the archive as described in the [archive installation guide](https://www.elastic.co/guide/en/elasticsearch/reference/8.12/targz.html). From the extracted `elasticsearch-8.12.0` directory, start a foreground instance matching the demo's local connection model:

```bash
ES_JAVA_OPTS="-Xms512m -Xmx512m" ./bin/elasticsearch -Ediscovery.type=single-node -Enetwork.host=127.0.0.1 -Expack.security.enabled=false
```

In another terminal, verify it with `curl --fail http://localhost:9200/_cluster/health`. Stop it with Ctrl-C. The backend creates the `code` index if absent, but does not populate it.

### Seed the demo and start the backend

In a backend terminal:

```bash
cd github/backend
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=init.defaultBranch
export GIT_CONFIG_VALUE_0=main
npm run db:seed
npm run dev
```

The Git configuration applies to subprocesses in this terminal without changing global Git settings. It matters because `initWithReadme` initializes a working repository without naming its branch, then explicitly pushes `main`. A Git installation defaulting to `master` can otherwise produce an empty repository while the API still reports creation success.

`db:seed` first creates `johndoe`, `janedoe`, and `admin`, each with `password123`, then seeds five public repositories: `johndoe/awesome-api`, `johndoe/react-charts`, `janedoe/go-cache`, `janedoe/ml-toolkit`, and `admin/infra-scripts`. Existing users/repository rows are skipped, so this does not reset passwords or repair missing Git data. Each new repository gets a short generated README; the longer sample README strings in the seeder are unused. Stars/forks/watchers are illustrative counters, not populated relationships. No issues, pull requests, feature branches, labels, or search documents are seeded by this command.

When a named seed repository has no database row, the seeder deletes its corresponding directory before recreating it. Do not run it over valuable host Git data after wiping only PostgreSQL.

The separate [SQL fixture](./backend/db-seed/seed.sql) is a different dataset: Alice/Bob/Carol/David/Admin, ten repository metadata rows, collaboration records, and placeholder commit IDs, without real Git directories. It uses explicit IDs without resetting sequences and can conflict with the TypeScript seed. Do not combine the fixtures. Screenshot automation prefers this SQL fixture, while its login and repository URLs expect the TypeScript fixture, so a fresh automated setup is inconsistent.

### Start the frontend

In another terminal:

```bash
cd github/frontend
npm run dev
```

Open [the application](http://localhost:5173). Vite proxies `/api` to port 3000. Try signing in, opening a seeded repository overview, and creating a disposable repository. The child-route limitation described above affects file and collaboration navigation.

## Configuration

No dotenv loader is installed or called. Export overrides in the backend process's shell; placing them in `.env` alone has no effect.

| Variable | Default / use |
|----------|---------------|
| `PORT` | `3000` |
| `FRONTEND_URL` | `http://localhost:5173`, allowed CORS origin |
| `DB_HOST`, `DB_PORT` | `localhost`, `5432` |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `github`, `github`, `github_dev_password` |
| `REDIS_URL` | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | `http://localhost:9200` |
| `REPOS_PATH` | `repositories` under the backend process working directory |
| `NODE_ENV` | Set to development by `dev`, production by `start` |
| `LOG_LEVEL`, `APP_VERSION` | Environment-dependent logging level, `dev` version label |

`DATABASE_URL` is not read. Run backend commands from `github/backend` or set an absolute `REPOS_PATH`; otherwise Git data may be created somewhere unexpected. No object store is needed.

`npm run dev:server1`, `dev:server2`, and `dev:server3` select ports 3001–3003. They do not supply a load balancer, change Vite's port-3000 proxy, or serialize concurrent merges across processes. Shared Redis and PostgreSQL do not make local Git writes a distributed storage system.

## API and verification guide

The local API uses `/api`, without `/v1`. Repository settings update at `PATCH /api/repos/:owner/:repo`, not a `/settings` endpoint. `POST /api/repos/:owner/:repo/push` is a cache-invalidation notification; it neither receives Git objects nor runs indexing. The [architecture API table](./architecture.md#api-design) lists the implemented route families and their limitations.

| Command / endpoint | Purpose |
|--------------------|---------|
| Frontend `npm run build` | TypeScript check followed by Vite build |
| Frontend `npm run type-check` | Check frontend source without emitting files |
| Backend `npx tsc --noEmit` | Check backend source; no backend build/type-check npm script exists |
| Backend `npm run lint` | Existing ESLint configuration |
| `GET :3000/health`, `/health/ready` | PostgreSQL and Redis probes; no Elasticsearch or Git-storage check |
| `GET :3000/health/live`, `/metrics` | Process liveness and Prometheus metrics |
| `GET /api/admin/circuit-breakers`, `/api/admin/audit-logs` | Admin-only APIs; no admin UI |

The frontend lint script uses `--ext` with a flat configuration; use `npx eslint . --max-warnings 0` from `github/frontend` if the installed ESLint rejects that flag. This does not imply the existing source is lint-clean.

The single [Playwright smoke test](./tests/smoke.spec.ts) checks that the homepage has a `main` element and no generic error text. It does not verify repository child routing, Git writes, authorization, search indexing, or merge recovery. Run it only with the application and required data already prepared. This documentation review used source inspection and isolated mocked checks; it did not run the application stack or claim passing builds/browser tests.

## Design reading

- [Architecture and implementation notes](./architecture.md)
- [Frontend interview answer](./system-design-answer-frontend.md)
- [Backend interview answer](./system-design-answer-backend.md)
- [Fullstack interview answer](./system-design-answer-fullstack.md)
- [Development history](./CLAUDE.md)
