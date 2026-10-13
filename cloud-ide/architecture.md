# Cloud IDE - Architecture Design

## System Overview

A multi-tenant cloud development environment: a developer opens a browser tab, picks a repository and a template, and within seconds has a Monaco editor, an xterm.js terminal, language intelligence, and forwarded preview ports, all backed by a long-lived Linux workspace running somewhere in a fleet of bare-metal hosts. Workspaces are created from templates or prebuilt snapshots, suspend when idle, resume on any host with their disk intact, and are deleted on request or by retention policy. The same platform serves "devbox" use: on-demand remote machines reached from a local editor over SSH.

The problem is hard because a workspace is the opposite of a stateless request. It holds a user's uncommitted work on disk, runs arbitrary untrusted code as root, keeps interactive sessions (terminals, language servers) open for hours, and costs real money every minute it runs whether anyone is typing or not. The design has to make compute disposable while keeping disk state durable, keep one tenant's code from touching another's, and route a keystroke from a browser to the one host that runs the shell, all while turning workspaces off aggressively enough that the bill stays sane.

**Learning goals:**

- Model a long-lived resource lifecycle as level-triggered reconciliation (desired state versus observed state) with generation fencing
- Compare containers, gVisor, and Firecracker microVMs as isolation boundaries for code that runs as root
- Keep persistent volumes durable on ephemeral compute with incremental block snapshots and lazy restore
- Route WebSocket traffic (terminal, LSP, file events) and HTTP previews to a workspace whose host changes over time
- Size warm pools with Little's law and reason about cold-start budgets
- Quantify cost control: idle timeouts, retention tiers, and overcommit

## Requirements

### Functional Requirements

1. **Create** a workspace from a template (base image plus config) or from a prebuild snapshot of a repository at a commit
2. **Start, stop, resume, delete** a workspace; resume restores the disk exactly as it was at stop
3. **Idle suspend**: stop a workspace after a configurable period without user activity (default 30 minutes)
4. **Edit**: open, edit, and save files with an in-browser editor; file tree reflects changes made by terminal commands
5. **Terminal**: multiple PTY sessions per workspace that survive browser refreshes and brief disconnects
6. **Language intelligence**: completions, diagnostics, go-to-definition through language servers running in the workspace
7. **Run and build**: run any command in the workspace, including `docker compose up`, with configurable machine sizes
8. **Port forwarding**: detect listening ports and expose them as authenticated preview URLs; optionally share with the org or publicly
9. **Org policy**: admins set idle timeouts, allowed machine classes, egress allowlists, concurrent-workspace limits, and budgets
10. **Admin**: view hosts, drain a host, inspect the warm pool, see lifecycle events per workspace

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Resume time-to-interactive | p95 < 5 s | Users resume several times a day; anything slower feels like booting a laptop |
| Create from prebuild | p95 < 15 s | Fresh workspaces should not wait on `npm install` |
| Keystroke echo | p95 < 100 ms within a region's footprint | Above ~100 ms, typing in a terminal feels laggy |
| Control plane availability | 99.95% | A control-plane outage blocks starts but must not kill running workspaces |
| Data plane availability | 99.99% for running workspaces | Gateway deploys and node loss must look like a reconnect, not an outage |
| Durability on host loss | RPO <= 60 s of disk writes | A host fails every few days at fleet scale; losing an hour of work is unacceptable |
| Durability of stopped workspaces | 11 nines (object storage) | Stopped disks live only in object storage |
| Isolation | No cross-tenant read, write, or network path | Users run untrusted code as root |

### Out of Scope

- Real-time multi-user co-editing (see [Collaborative Editor](../collaborative-editor/)); one owner per workspace
- GPU workspaces
- The CI system that triggers prebuilds (see [GitHub Actions](../FUTURE_PROJECTS.md#github-actions))
- Billing and invoicing beyond usage records

## Capacity Estimation

### Assumptions

| Input | Value |
|-------|-------|
| Registered developers | 10M |
| Daily active developers (DAU) | 1M |
| Sessions per DAU per day | 3 (morning, after lunch, after meetings) |
| Active hours per DAU per day | 4 h |
| Idle timeout | 30 min, so each session ends with a 30-min idle tail: 3 x 0.5 h = 1.5 h |
| Running hours per DAU per day | 4 + 1.5 = 5.5 h |
| Default machine class | 4 vCPU, 8 GB RAM, 32 GB disk |
| Host | Bare metal, 96 vCPU, 768 GB RAM, 7.68 TB NVMe, 25 Gbps NIC |
| Host price | $3 per host-hour with committed-use pricing |

### Fleet Sizing

- Average running workspaces: 1M x 5.5 h / 24 h = **~229K**. Peak (users span time zones, peak:average ~1.3): **300K**
- Slots per host: (768 GB - 64 GB reserved for host OS, VMMs, page cache) / 8 GB = 88. Target 85% fill to leave room for evacuations: 88 x 0.85 = **75 workspaces per host**
- Hosts at peak: 300K / 75 = **4,000 hosts**
- Host failures at 3% per year: 4,000 x 0.03 = **120 per year**, one every ~3 days, each interrupting ~75 workspaces (~9,000 per year) that lose at most 60 s of disk writes and their running processes
- CPU overcommit: 75 x 4 vCPU = 300 nominal vCPU on 96 = **3.1x**. Average utilization is ~10% of nominal (0.4 vCPU per workspace), so 30 busy vCPUs per host, ~31% host CPU. Memory is not overcommitted: an OOM kill takes out someone's editor session

### Start Rate and Warm Pool

- Starts and resumes: 1M x 3 = 3M per day = **~35/s average, ~175/s peak** (5x morning ramp)
- Warm pool by Little's law: claim rate x replenish window = 175/s x 60 s = **10,500 pre-booted VMs** at peak (60 s covers 6 s boot, health check, controller lag, and burst margin)
- Warm pool footprint: 10,500 / 75 = **140 hosts** (3.5% of the fleet), ~$10K/day
- Peak fleet including warm pool: **~4,140 hosts**

### Start Latency Budget

| Step | Cold (image not on host) | Image cached, no warm VM | Warm VM |
|------|--------------------------|--------------------------|---------|
| Placement and claim | 0.2 s | 0.2 s | 0.1 s |
| Image pull and unpack (4 GB at 200 MB/s effective) | 20 s | 0 | 0 |
| VM boot and guest init (systemd, dockerd, agent) | 6 s | 6 s | 0 |
| Volume attach with lazy restore (500 MB hot set at 1 GB/s) | 0.5 s | 0.5 s | 0.5 s |
| Inject identity and secrets, start IDE services | 1.5 s | 1.5 s | 1.5 s |
| Client connect (TLS, WebSocket, token) | 0.3 s | 0.3 s | 0.3 s |
| **Total** | **28.5 s** | **8.5 s** | **2.4 s** |

### Storage

- Retained stopped workspaces: **4M** (deleted after 30 days without use; moved to an archive tier after 7 days)
- Average disk delta over the template base, compressed and deduplicated: **5 GB**
- Object storage: 4M x 5 GB = **20 PB**, ~$400K/month at $0.02 per GB-month
- Snapshot cadence: every 60 s while running. Average dirty rate after chunk coalescing: 50 KB/s per workspace, so ~3 MB per snapshot
- Snapshot upload per host: 75 x 50 KB/s = 3.75 MB/s (30 Mbps, trivial on 25 Gbps). Fleet at peak: 300K x 50 KB/s = **15 GB/s (120 Gbps)**
- Snapshot commits: 300K / 60 s = **5,000 per second** fleet-wide, ~1,000/s per cell across 5 cells

### Data Plane Traffic

- One multiplexed WebSocket per IDE tab; ~1.3 tabs per running workspace: 300K x 1.3 = **~400K concurrent WebSockets** at peak
- At 50K connections per gateway node: 8 nodes minimum; run **24** across 3 zones for headroom and deploys
- Average 2 messages/s per connection: **800K messages/s**, ~33K/s per gateway node
- Average 2 KB/s per connection: 800 MB/s (**6.4 Gbps**) through the gateway tier
- Keystroke echo: user-to-region RTT <= 60 ms, gateway-to-host < 1 ms, agent and shell echo ~5 ms
- Terminal flow-control window: 256 KB. At 60 ms RTT the maximum terminal throughput is 256 KB / 0.06 s = **4.3 MB/s**, far faster than anyone reads

### Control Plane Load

- Activity heartbeats: 300K workspaces / 60 s = 5,000/s into Valkey. Flushed to PostgreSQL every 5 min: 300K / 300 s = **1,000 writes/s**
- Host heartbeats: 4,140 hosts / 5 s = ~830/s
- Workspace rows: ~15M including soft-deleted history, ~1 KB each = 15 GB

### Cost

- Per workspace-hour: $3 / 75 = **$0.04**
- Compute: 1M DAU x 5.5 h x $0.04 = **$220K/day** (~$6.6M/month)
- The 30-min idle tail is 1.5 of 5.5 running hours, **27% of compute** ($60K/day). Cutting the timeout to 15 min saves 0.75 h per DAU, $30K/day (13.6%)
- Without auto-stop (workspaces left running 24 h): 1M x 24 x $0.04 = $960K/day, **4.4x** more
- Storage ($400K/month) is 6.1% of compute and the warm pool (~$300K/month) is 4.6%. Compute is what auto-stop controls

### Local Development Scale

- 2 simulated hosts (host agents managing Docker containers on one machine), 5-10 workspaces, 2-4 warm containers
- 1-3 concurrent browser sessions; snapshots are full tarballs to MinIO on stop only

## High-Level Architecture

```
                 ┌──────────────────────────────────────────────────┐
                 │  Browser: Monaco · xterm.js · file tree · preview│
                 └──────────┬──────────────────────────┬────────────┘
                 HTTPS REST │                          │ WSS (one multiplexed socket per tab)
                 + SSE      │                          │ HTTPS previews on a separate site
                            ▼                          ▼
              ┌──────────────────────────┐   ┌──────────────────────────────┐
              │ API edge (auth, limits)  │   │ Workspace gateway            │
              └────────────┬─────────────┘   │ token check · route by id    │
                           │                 │ preview proxy                │
                           ▼                 └──────────────┬───────────────┘
 ┌──────────────────────────────────────────────────┐       │ mTLS tunnel to the
 │ CONTROL PLANE (one per cell, ~1,000 hosts)       │       │ owning host agent
 │ ┌────────────┐ ┌─────────────┐ ┌──────────────┐  │       │
 │ │ Workspace  │ │ Scheduler + │ │ Warm-pool    │  │       │
 │ │ API        │ │ reconciler  │ │ manager      │  │       │
 │ └─────┬──────┘ └──────┬──────┘ └──────┬───────┘  │       │
 │ ┌─────┴───────────────┴───────────────┴───────┐  │       │
 │ │ PostgreSQL (cell DB) · Valkey (routes,      │  │       │
 │ │ activity, sessions, change notifications)   │  │       │
 │ └─────┬───────────────────────────────┬───────┘  │       │
 │ ┌─────┴──────┐ ┌─────────────┐ ┌──────┴───────┐  │       │
 │ │ Idle       │ │ Prebuild    │ │ Retention /  │  │       │
 │ │ reaper     │ │ service     │ │ chunk GC     │  │       │
 │ └────────────┘ └─────────────┘ └──────────────┘  │       │
 └────────────────────────┬─────────────────────────┘       │
                          │ desired state + generation      │
                          ▼                                 ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ WORKSPACE HOST (bare metal, ~75 microVMs)                                │
 │ ┌───────────────────────┐  vsock  ┌────────────────────────────────────┐ │
 │ │ Host agent            │◀───────▶│ Firecracker microVM (one per ws)   │ │
 │ │ lease · VMM control   │         │ workspace agent: PTY · fs · LSP ·  │ │
 │ │ snapshotter · egress  │         │ port detect · activity · git creds │ │
 │ │ rules · warm VMs      │         │ user processes, dockerd            │ │
 │ └──────────┬────────────┘         └────────────────────────────────────┘ │
 │            │ local NVMe: CoW volumes over cached base images             │
 └────────────┼─────────────────────────────────────────────────────────────┘
              │ dirty chunks every 60 s · lazy restore on resume
              ▼
 ┌────────────────────────┐  ┌────────────────────────┐  ┌──────────────────┐
 │ Object storage         │  │ Image registry         │  │ Egress NAT with  │
 │ chunks + manifests     │  │ template + prebuild    │  │ per-VM policy    │
 │ (cross-region replica) │  │ images                 │  │ → internet       │
 └────────────────────────┘  └────────────────────────┘  └──────────────────┘
```

The control plane decides *where* and *whether* a workspace runs; it is never on the keystroke path. The data plane (gateway, host agent, workspace agent) carries every byte of terminal, editor, and preview traffic and keeps working when the control plane is down. A global directory (not drawn) maps a user to a home region and a workspace ID to its cell.

## Core Components / Request Flows

### 1. Workspace API

Owns the workspace resource. Validates requests, enforces quotas (concurrent running workspaces per user, org budgets, allowed machine classes), writes `desired_state`, and streams lifecycle progress to the client over Server-Sent Events. It never talks to hosts directly: it writes intent and lets the reconciler act.

### 2. Scheduler and Reconciler

A level-triggered control loop, one leader per cell. Each pass selects workspaces whose `desired_state` differs from `state` (partial index, so the scan touches only the few thousand in transition) and drives one step:

- **desired running, state stopped**: pick a host (warm VM for the image digest first, then the host that still caches this volume, then least-loaded in the cell), bump `generation`, write `state = starting` and `host_id`, and publish the assignment to the host
- **desired stopped, state running**: tell the host to quiesce, take a final snapshot, release the VM
- **host lease expired**: mark its workspaces `recovering`, then start them elsewhere from the last committed snapshot

Placement spreads a user's workspaces and scores hosts by free memory slots, cached image digests, cached volumes, and zone balance.

### 3. Host Agent

One per bare-metal host. Renews a 20-second lease with the control plane every 5 seconds, watches assignments for its host, and converges local reality to them: boots or claims Firecracker microVMs via the jailer, attaches volumes, programs nftables egress rules on each VM's tap device, runs the snapshotter, and terminates mTLS tunnels from the gateway, forwarding each stream to the right VM over vsock. If it cannot renew its lease before expiry it **self-fences**: pauses every VM, stops uploading snapshots, and refuses gateway streams.

### 4. Workspace Agent (inside the VM)

A small daemon in the guest, reachable only over vsock. It multiplexes channels: PTY sessions (with a 1 MB replay ring buffer each), file operations with version checks, a file watcher with coalescing, language-server processes speaking JSON-RPC, a listening-port detector (polls `/proc/net/tcp`), activity reporting, and a git credential helper that asks the host for short-lived repo tokens. Its own state lives on a small reserved disk so it keeps working when the user's volume is full.

### 5. Warm-Pool Manager

Keeps pre-booted microVMs per (cell, image digest, machine class). A warm VM has booted the template image, started systemd and dockerd, and is waiting for a volume and an identity. Target size per pool comes from the claim rate over the last 15 minutes times the 60-second replenish window, with a floor for popular images and zero for the long tail (those rely on the host image cache): `target = max(floor, ceil(claim_rate_15m x 60 s))`. A claimed VM is replaced asynchronously, and VMs idle in the pool for more than 2 h are recycled so they pick up base-image patches.

### 6. Volume Service and Snapshotter

Each workspace volume is a copy-on-write block device on local NVMe, layered over the cached template or prebuild base. The host-side snapshotter tracks dirty blocks, and every 60 seconds it takes a crash-consistent point-in-time view, splits dirty data into 1 MB chunks, compresses them, uploads them content-addressed (key = SHA-256 of the chunk) to object storage, writes a manifest (ordered list of chunk hashes), and commits the manifest under the workspace's generation. On suspend it does the same after a clean guest shutdown, giving an application-consistent final snapshot.

On resume, the new host attaches a volume backed by the manifest. Reads of chunks not yet local fault them in from object storage; a prefetcher pulls the hot set recorded during the last session (~500 MB) first, then the rest in the background. If the previous host still caches the volume and has a free slot, placement prefers it and nothing is downloaded.

### 7. Workspace Gateway and Preview Proxy

Stateless WebSocket terminators in front of all hosts. A client connects to `wss://gw.<region>/ws/workspaces/{id}` with a short-lived signed token. The gateway verifies the token offline, looks up `workspace_id → (host, generation)` in an in-memory routing cache fed by Valkey change notifications, checks the token's generation matches, and opens a stream on its pooled mTLS tunnel to that host agent. Preview traffic (`https://{port}-{id}.<preview-site>`) takes the same route to the same agent, which forwards to the guest port.

### 8. Prebuild Service

On push to a configured branch, runs the template's create steps (clone, dependency install, postCreate commands) in a build VM, then snapshots the volume as a prebuild keyed by (template, repo, branch, commit). New workspaces clone that snapshot's manifest instead of starting from an empty disk. Superseded prebuilds are retained for 7 days for workspaces still referencing their chunks.

### 9. Idle Reaper and Retention

The reaper scans running workspaces by `last_activity_at` (flushed from Valkey every 5 min, read live from Valkey for candidates) and sets `desired_state = stopped` when the timeout passes, after a 5-minute warning to connected clients. Activity means user input: keystrokes, file saves, LSP requests from the client, preview requests from the owner's browser. A build running with no one watching does not count. Retention moves stopped workspaces to an archive storage class after 7 days and deletes them after 30 days, with an email at day 23.

### Flow: Open a Stopped Workspace

```
Browser            Workspace API      Reconciler        Host agent          Gateway
   │ POST /start       │                  │                 │                  │
   │──────────────────▶│ desired=running  │                 │                  │
   │◀── 202 + SSE ─────│─────────────────▶│ claim warm VM   │                  │
   │                   │                  │ gen = gen + 1   │                  │
   │                   │                  │ host assignment │                  │
   │                   │                  │────────────────▶│ attach volume    │
   │                   │                  │                 │ (lazy restore)   │
   │                   │                  │                 │ inject identity  │
   │                   │                  │◀─ running(gen) ─│                  │
   │◀─ SSE: running ───│                  │ route (id → host, gen) ───────────▶│
   │ POST /connect → token(gen)           │                 │                  │
   │ WSS /ws/workspaces/:id ──────────────────────────────────────────────────▶│
   │                   │                  │                 │◀── stream(gen) ──│
   │◀════════════ terminal · LSP · fs channels over one socket ════════════════│
```

### Flow: A Keystroke in the Terminal

1. xterm.js `onData` emits the bytes; the client frames them as `{channel: term-2, type: input}` on the shared WebSocket
2. The gateway forwards the frame on the host's tunnel stream (no parsing beyond the channel header)
3. The host agent writes it to the VM's vsock connection; the workspace agent writes it to the PTY master
4. The shell echoes; the agent reads the PTY, tags output with a byte sequence number, and appends it to the ring buffer
5. Output flows back the same path; the client writes it to xterm.js and acks bytes in 64 KB steps
6. If unacked output exceeds 256 KB, the agent stops reading the PTY; the kernel PTY buffer fills and the writing process blocks, which is the backpressure

### Workspace State Machine

```
            create                      reconciler places
 ┌─────────┐       ┌──────────┐  host reports ready  ┌─────────┐
 │ pending │──────▶│ starting │─────────────────────▶│ running │
 └─────────┘       └────▲─────┘                      └──┬───┬──┘
                        │                idle / user    │   │ host lease
                        │ start          stop           ▼   │ expired
 ┌──────────┐      ┌────┴─────┐  final snapshot  ┌──────────┐│
 │ archived │◀─────│ stopped  │◀─────────────────│ stopping ││
 └────┬─────┘ 7 d  └────┬─────┘  committed       └──────────┘│
      │                 │ delete                ┌────────────▼┐
      │ 30 d / delete   ▼                       │ recovering  │── start elsewhere
      └──────────▶┌──────────┐   ┌─────────┐    └─────────────┘   from last snapshot
                  │ deleting │──▶│ deleted │
                  └──────────┘   └─────────┘
```

Every arrow out of `stopped` or `recovering` into `starting` increments `generation`. Anything carrying an older generation (a host agent, a snapshot upload, a gateway route, a client token) is rejected.

## Database Schema

PostgreSQL, one database per cell. The global directory (user → home region, workspace → cell) is a small replicated table not shown here.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  idle_timeout_minutes  INT  NOT NULL DEFAULT 30 CHECK (idle_timeout_minutes BETWEEN 5 AND 240),
  max_running_per_user  INT  NOT NULL DEFAULT 2 CHECK (max_running_per_user > 0),
  allowed_classes       TEXT[] NOT NULL DEFAULT ARRAY['standard-4'],
  egress_mode           TEXT NOT NULL DEFAULT 'open' CHECK (egress_mode IN ('open', 'allowlist')),
  egress_allowlist      TEXT[] NOT NULL DEFAULT '{}',
  monthly_budget_cents  BIGINT CHECK (monthly_budget_cents IS NULL OR monthly_budget_cents >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID REFERENCES organizations(id),
  email          TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'member'
                 CHECK (role IN ('member', 'org_admin', 'platform_admin')),
  password_hash  TEXT,                       -- local development only; production uses SSO
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_org ON users (org_id);

CREATE TABLE machine_classes (
  name            TEXT PRIMARY KEY,          -- 'standard-4', 'large-8', 'xlarge-16'
  vcpus           INT  NOT NULL CHECK (vcpus > 0),
  memory_mb       INT  NOT NULL CHECK (memory_mb > 0),
  disk_gb         INT  NOT NULL CHECK (disk_gb > 0),
  cents_per_hour  INT  NOT NULL CHECK (cents_per_hour >= 0)
);

CREATE TABLE templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID REFERENCES organizations(id),   -- NULL = public template
  name          TEXT NOT NULL,
  version       INT  NOT NULL CHECK (version > 0),
  image_digest  TEXT NOT NULL CHECK (image_digest LIKE 'sha256:%'),  -- pinned digest, never a tag
  config        JSONB NOT NULL,              -- ports, postCreate/postStart tasks, editor extensions
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (org_id, name, version)
);

CREATE TABLE hosts (
  id                UUID PRIMARY KEY,
  region            TEXT NOT NULL,
  cell              TEXT NOT NULL,
  zone              TEXT NOT NULL,
  address           INET NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active', 'draining', 'cordoned', 'dead')),
  total_slots       INT  NOT NULL CHECK (total_slots > 0),
  used_slots        INT  NOT NULL DEFAULT 0,
  cached_digests    TEXT[] NOT NULL DEFAULT '{}',
  lease_expires_at  TIMESTAMPTZ NOT NULL,
  agent_version     TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (used_slots BETWEEN 0 AND total_slots)
);
CREATE INDEX idx_hosts_placement ON hosts (cell, used_slots) WHERE status = 'active';
CREATE INDEX idx_hosts_lease ON hosts (lease_expires_at) WHERE status IN ('active', 'draining');

CREATE TABLE volumes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  size_gb             INT  NOT NULL CHECK (size_gb > 0),
  base_snapshot_id    UUID,                  -- template or prebuild snapshot it was cloned from
  latest_snapshot_id  UUID,
  cached_on_host_id   UUID REFERENCES hosts(id) ON DELETE SET NULL,
  used_bytes          BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  hot_set_key         TEXT,                  -- object key of the chunk list read in the last session
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  volume_id      UUID REFERENCES volumes(id) ON DELETE CASCADE,  -- NULL for template/prebuild bases
  generation     BIGINT NOT NULL,
  seq            BIGINT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('periodic', 'suspend', 'manual', 'prebuild', 'template')),
  manifest_key   TEXT NOT NULL,              -- object-store key of the chunk manifest
  logical_bytes  BIGINT NOT NULL CHECK (logical_bytes >= 0),
  new_bytes      BIGINT NOT NULL CHECK (new_bytes >= 0),         -- bytes in chunks not seen before
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (volume_id, generation, seq)
);
CREATE INDEX idx_snapshots_volume ON snapshots (volume_id, created_at DESC);

ALTER TABLE volumes
  ADD CONSTRAINT fk_volumes_base   FOREIGN KEY (base_snapshot_id)   REFERENCES snapshots(id),
  ADD CONSTRAINT fk_volumes_latest FOREIGN KEY (latest_snapshot_id) REFERENCES snapshots(id);

CREATE TABLE prebuilds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  UUID NOT NULL REFERENCES templates(id),
  repo_url     TEXT NOT NULL,
  branch       TEXT NOT NULL,
  commit_sha   TEXT NOT NULL CHECK (length(commit_sha) = 40),
  snapshot_id  UUID REFERENCES snapshots(id),
  status       TEXT NOT NULL CHECK (status IN ('queued', 'building', 'ready', 'failed', 'superseded')),
  log_key      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  UNIQUE (template_id, repo_url, branch, commit_sha),
  CHECK (status <> 'ready' OR snapshot_id IS NOT NULL)
);
CREATE INDEX idx_prebuilds_lookup ON prebuilds (repo_url, branch, template_id, created_at DESC)
  WHERE status = 'ready';

CREATE TABLE workspaces (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              UUID NOT NULL REFERENCES users(id),
  org_id                UUID REFERENCES organizations(id),
  name                  TEXT NOT NULL,
  template_id           UUID NOT NULL REFERENCES templates(id),
  prebuild_id           UUID REFERENCES prebuilds(id),
  repo_url              TEXT,
  branch                TEXT,
  machine_class         TEXT NOT NULL REFERENCES machine_classes(name),
  region                TEXT NOT NULL,
  cell                  TEXT NOT NULL,
  desired_state         TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped', 'deleted')),
  state                 TEXT NOT NULL CHECK (state IN ('pending', 'starting', 'running', 'stopping',
                          'stopped', 'archived', 'recovering', 'deleting', 'deleted', 'failed')),
  generation            BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  host_id               UUID REFERENCES hosts(id),
  volume_id             UUID NOT NULL UNIQUE REFERENCES volumes(id),
  idle_timeout_minutes  INT  NOT NULL DEFAULT 30 CHECK (idle_timeout_minutes BETWEEN 5 AND 240),
  last_activity_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  state_changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  failure_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  CHECK (state NOT IN ('starting', 'running', 'stopping') OR host_id IS NOT NULL)
);
CREATE INDEX idx_workspaces_owner ON workspaces (owner_id, created_at DESC) WHERE deleted_at IS NULL;
-- Reconciler work queue: only rows in transition
CREATE INDEX idx_workspaces_reconcile ON workspaces (cell, state_changed_at)
  WHERE desired_state <> state AND state NOT IN ('archived', 'failed');
CREATE INDEX idx_workspaces_host ON workspaces (host_id) WHERE state IN ('starting', 'running', 'stopping');
CREATE INDEX idx_workspaces_idle ON workspaces (cell, last_activity_at) WHERE state = 'running';
CREATE INDEX idx_workspaces_retention ON workspaces (state, state_changed_at)
  WHERE state IN ('stopped', 'archived');

CREATE TABLE warm_vms (
  id             UUID PRIMARY KEY,
  host_id        UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  image_digest   TEXT NOT NULL,
  machine_class  TEXT NOT NULL REFERENCES machine_classes(name),
  state          TEXT NOT NULL CHECK (state IN ('booting', 'ready', 'claimed', 'discarded')),
  claimed_by     UUID REFERENCES workspaces(id),
  ready_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (state <> 'claimed' OR claimed_by IS NOT NULL)
);
CREATE INDEX idx_warm_ready ON warm_vms (image_digest, machine_class, ready_at) WHERE state = 'ready';

CREATE TABLE workspace_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY,
  workspace_id  UUID NOT NULL,
  generation    BIGINT NOT NULL,
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  reason        TEXT NOT NULL,               -- 'user_start', 'idle_timeout', 'host_lost', 'disk_full', ...
  actor         TEXT NOT NULL,               -- user id, 'reaper', 'reconciler', 'admin:<id>'
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_events_workspace ON workspace_events (workspace_id, created_at DESC);

CREATE TABLE port_shares (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  port          INT  NOT NULL CHECK (port BETWEEN 1 AND 65535),
  visibility    TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org', 'public')),
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, port)
);

CREATE TABLE secrets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('user', 'org', 'repo')),
  scope_id     TEXT NOT NULL,
  name         TEXT NOT NULL CHECK (name ~ '^[A-Z_][A-Z0-9_]*$'),
  ciphertext   BYTEA NOT NULL,               -- envelope-encrypted; data key wrapped by KMS
  key_id       TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, name)
);

CREATE TABLE idempotency_keys (
  user_id          UUID NOT NULL REFERENCES users(id),
  key              TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INT,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idx_idempotency_expiry ON idempotency_keys (created_at);

CREATE TABLE usage_records (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   UUID NOT NULL REFERENCES workspaces(id),
  org_id         UUID REFERENCES organizations(id),
  generation     BIGINT NOT NULL,
  machine_class  TEXT NOT NULL REFERENCES machine_classes(name),
  started_at     TIMESTAMPTZ NOT NULL,
  stopped_at     TIMESTAMPTZ,
  UNIQUE (workspace_id, generation),
  CHECK (stopped_at IS NULL OR stopped_at >= started_at)
);
CREATE INDEX idx_usage_org_time ON usage_records (org_id, started_at);
```

**Key queries.** Claiming a warm VM is a single statement that cannot hand the same VM to two workspaces:

```sql
UPDATE warm_vms SET state = 'claimed', claimed_by = $1
WHERE id = (
  SELECT id FROM warm_vms
  WHERE state = 'ready' AND image_digest = $2 AND machine_class = $3
  ORDER BY (host_id = $4) DESC, ready_at      -- $4 = host that caches this volume, if any
  LIMIT 1
  FOR UPDATE SKIP LOCKED)
RETURNING id, host_id;
```

Starting bumps the generation in the same statement that assigns the host, so the fence and the placement are one atomic fact:

```sql
UPDATE workspaces
SET state = 'starting', generation = generation + 1, host_id = $2, state_changed_at = now()
WHERE id = $1 AND desired_state = 'running' AND state IN ('pending', 'stopped', 'archived', 'recovering')
RETURNING generation;
```

A snapshot commit only succeeds for the current generation; zero rows updated means the uploader has been fenced:

```sql
UPDATE volumes v SET latest_snapshot_id = $3
FROM workspaces w
WHERE v.id = $1 AND w.volume_id = v.id AND w.generation = $2;
```

**Valkey keys.**

| Key | Type | TTL | Purpose |
|-----|------|-----|---------|
| `route:{workspaceId}` | Hash (host, address, generation) | none; deleted on stop | Gateway routing |
| `activity:{workspaceId}` | String (epoch ms) | 2 h | Live last-activity, flushed to PostgreSQL every 5 min |
| `sess:{sessionId}` | Hash | 7 d | Browser sessions |
| `ratelimit:{userId}:start` | Counter | 60 s | Start/create rate limit |
| `changes:{cell}` | Pub/sub channel | n/a | Nudges gateways and host agents to re-read routes and assignments |

## API Design

### Control Plane REST

```
POST   /api/v1/workspaces                         Create (template, prebuild, or snapshot); Idempotency-Key required
GET    /api/v1/workspaces                         List the caller's workspaces
GET    /api/v1/workspaces/:id                     State, generation, machine class, ports
PATCH  /api/v1/workspaces/:id                     Rename, change machine class (applies on next start), idle timeout
POST   /api/v1/workspaces/:id/start               desired_state = running → 202
POST   /api/v1/workspaces/:id/stop                desired_state = stopped → 202
DELETE /api/v1/workspaces/:id                     desired_state = deleted → 202
GET    /api/v1/workspaces/:id/events              SSE stream of lifecycle progress
POST   /api/v1/workspaces/:id/connect             Mint data-plane token + gateway URL (requires state = running)
POST   /api/v1/workspaces/:id/snapshots           User-initiated snapshot (e.g. before a risky upgrade)
PUT    /api/v1/workspaces/:id/ports/:port         Set preview visibility: private | org | public
GET    /api/v1/templates                          Templates visible to the caller
POST   /api/v1/prebuilds                          Trigger a prebuild for (template, repo, branch)

GET    /api/v1/admin/hosts                        Host list with slots, lease, cached digests
POST   /api/v1/admin/hosts/:id/drain              Stop placing; migrate workspaces at next suspend
GET    /api/v1/admin/warm-pool                    Pool sizes, claim rates, hit ratio per image
PUT    /api/v1/admin/orgs/:id/policy              Idle timeout, machine classes, egress allowlist, budget
```

Example create request (`Idempotency-Key` header) and response:

```json
{ "templateId": "tmpl_node20", "repoUrl": "https://git.example.com/acme/web", "branch": "main", "machineClass": "standard-4" }
{ "id": "ws_8KQ2", "state": "pending", "desiredState": "running", "generation": 0, "prebuildCommit": "9f2c...", "eventsUrl": "/api/v1/workspaces/ws_8KQ2/events" }
```

### Data Plane

```
WSS   /ws/workspaces/:id?token=…                  One multiplexed socket per tab
HTTPS https://{port}-{id}.<preview-site>/…        Forwarded port; auth via per-origin cookie
```

Frames carry a channel ID and type. Channels: `term:{sessionId}` (open, input, output with byte sequence, resize, ack, exit), `lsp:{languageId}` (JSON-RPC passthrough), `fs` (stat, read, write with base version, watch events), `ports` (opened, closed), `ctl` (ping/pong for RTT, `moved`, `stopping` warnings, durable save watermark).

```json
{ "ch": "term:2", "t": "output", "seq": 1048576, "data": "<base64>" }
{ "ch": "term:2", "t": "ack", "seq": 1114112 }
{ "ch": "fs", "t": "write", "path": "src/app.ts", "baseVersion": "h:9a41", "data": "...", "saveSeq": 812 }
{ "ch": "ctl", "t": "durable", "saveSeq": 790 }
```

### Internal (Host Agent ↔ Control Plane, mTLS)

```
POST /internal/v1/hosts/:id/lease                 Renew lease; body carries slot usage and cached digests
GET  /internal/v1/hosts/:id/assignments?since=…   Long-poll desired VMs: (workspaceId, generation, spec)
POST /internal/v1/workspaces/:id/observed         Report observed state for a generation
POST /internal/v1/volumes/:id/snapshots           Commit a manifest for (generation, seq)
```

## Key Design Decisions

### 1. Firecracker microVMs, Not Containers, as the Tenant Boundary

Developers need root, `sudo apt install`, and `docker compose up` inside their workspace. In a container, root plus Docker means either a privileged container (a well-documented escape path to the host) or a rootless nested runtime that breaks half of real-world compose files. Containers also share the host kernel, so every kernel privilege-escalation CVE is a cross-tenant breach. A Firecracker microVM gives each workspace its own guest kernel behind KVM, with a minimal device model (virtio net, block, vsock) and the VMM itself jailed with seccomp in an unprivileged chroot. Root inside the guest is harmless to neighbors.

gVisor was the main alternative: it intercepts syscalls in a user-space kernel, so it isolates well, but its syscall compatibility gaps and I/O overhead show up exactly in dev workloads (file-heavy builds, Docker inside the sandbox). What we give up with microVMs: hosts must be bare metal (or nested-virtualization capable), guest boot plus init takes ~6 s (hence warm pools), each VM carries its own guest kernel and page cache so memory density is lower than containers, and live memory sharing across tenants is gone.

### 2. Local NVMe Volumes With 60-Second Incremental Snapshots, Not Network Block Storage

Dev workloads are metadata-heavy: `npm install` creates tens of thousands of small files, and every `fsync` or `stat` on network block storage costs a round trip (0.5-1 ms) instead of ~20 µs on local NVMe. Local volumes make builds feel like a laptop. Durability comes from the host-side snapshotter shipping dirty chunks every 60 s to object storage, content-addressed so prebuild bases and template layers deduplicate. Stopped workspaces cost only object storage, never provisioned block volumes.

What we give up is RPO zero: a host loss loses up to 60 s of disk writes. The client mitigates this for the writes that matter most (saved files) by keeping their contents until a snapshot covering them is acknowledged, then offering to re-apply them after recovery. Resume also needs lazy restore to avoid downloading 5 GB before the user can type.

### 3. Level-Triggered Reconciliation With Generation Fencing

The API writes desired state; a reconciler drives observed state toward it; host agents converge to assignments. Edge-triggered commands ("start VM now" on a queue) lose meaning on retries, duplicates, and reordering, and leave the system wondering whether a command half-executed. Desired state is idempotent by construction: re-sending "workspace X generation 7 should run here" is a no-op if it already does.

Generation numbers handle the scenario reconciliation alone cannot: a partitioned host that is still running a VM after the control plane has restarted the workspace elsewhere. Every start increments `generation`, and every side effect (snapshot commit, gateway route, client token, host lease) carries it. The stale host's snapshot commit updates zero rows; its lease expired before the control plane acted (20 s lease versus 30 s dead declaration), so it has already paused its VMs. Two copies may briefly exist; two copies never both write durable state.

### 4. A Gateway Tier With One Multiplexed WebSocket Per Tab

Clients never connect to hosts directly. The gateway keeps hosts off the internet, centralizes token verification and DDoS protection, and makes host moves invisible: when a workspace resumes elsewhere, only the routing entry changes. Terminal, LSP, file events, and port notifications share one socket per tab because browsers limit concurrent connections per origin, each socket costs a TLS handshake and a gateway slot, and a single socket gives one reconnect point with one resume protocol. The cost is head-of-line blocking within the socket (a burst of terminal output delays an LSP response), handled by per-channel flow control and a small fair scheduler in the agent, and an extra in-region hop (< 1 ms).

### 5. Warm Pools Keyed by Image Digest, Backed by a Host Image Cache

The latency budget shows the image pull (20 s) dominates a cold start and guest init (6 s) dominates the rest. A warm pool removes both for popular images at 3.5% of fleet capacity. Keying pools by pinned digest rather than tag means a template update never hands a user a VM with the wrong image. The long tail of custom images cannot all be pooled, so the scheduler prefers hosts that already cache the digest (8.5 s path) and the registry pre-pushes new template versions to hosts before they are published.

### 6. Previews on a Separate Registrable Domain

Forwarded ports run the user's own, arbitrary web server. Serving it under the IDE's domain would let that code read IDE cookies, call IDE APIs with the user's credentials, or plant cookies for sibling subdomains. Previews live on a different registrable domain (listed on the Public Suffix List so each `{port}-{id}` host is its own site), and authentication happens by a redirect through the auth service that sets a cookie scoped to that one preview host. The cost is an extra redirect on first open and more certificate management (wildcard per region).

## Consistency and Idempotency

- **Create** requires an `Idempotency-Key`. The key, a hash of the request body, and the response are stored in `idempotency_keys`; a retry with the same key and body returns the stored response, a different body returns 422. Keys expire after 24 h
- **Start, stop, delete** set `desired_state`; repeating them is a no-op. The response includes the current generation so the client can follow progress on the SSE stream
- **Host assignments** are `(workspaceId, generation, spec)` tuples. Host agents apply them idempotently: if a VM for that generation exists, nothing happens; if a VM for an older generation exists, it is destroyed without snapshotting
- **Snapshots** are committed with a conditional update on generation. Chunks are content-addressed, so a retried upload rewrites identical bytes under the same key. Unreferenced chunks are reclaimed by a mark-and-sweep GC that only deletes chunks older than 24 h, so an in-flight snapshot's chunks are never collected before its manifest commits
- **Routing entries** in Valkey include the generation; the gateway rejects a client token whose generation differs, and the host agent rejects a stream for a generation it does not run
- **Usage records** are unique per `(workspace_id, generation)`, so a run is billed once. If a host dies, `stopped_at` is set to its last lease renewal
- **Activity timestamps** merge with `max()`, so out-of-order heartbeats cannot move `last_activity_at` backwards
- **File saves** carry the buffer's base version (content hash). If the file changed on disk (a `git checkout` in the terminal), the agent rejects the write and the editor shows a conflict instead of silently clobbering

## Security / Auth

| Layer | Mechanism |
|-------|-----------|
| User authentication | SSO / OAuth with the git provider in production; Redis-backed session cookie locally |
| Data-plane authorization | `/connect` mints a 5-minute signed token `{user, workspace, generation, capabilities}`; the gateway verifies it offline; the client refreshes before expiry |
| Tenant isolation | Firecracker microVM per workspace; jailer (chroot, unprivileged UID, seccomp) around each VMM; cgroups on VMM CPU and I/O |
| Network isolation | Per-VM tap device with nftables rules applied on the host: no east-west traffic between VMs, cloud metadata endpoint and internal ranges blocked, SMTP blocked, egress bandwidth capped at 100 Mbps per VM |
| Org egress policy | `allowlist` mode routes egress through a filtering proxy that only permits listed domains (registry, git host, package mirrors) |
| Secrets | Envelope-encrypted at rest; injected over vsock at start into a tmpfs mount and environment; never part of a snapshot unless the user writes them to disk |
| Git credentials | Credential helper in the guest requests a short-lived, repo-scoped token from the host agent, which asks the control plane |
| Previews | Separate registrable domain; private by default; per-preview-host cookie set via an auth redirect with a one-time code |
| Abuse | Free tier requires a verified account; mining detection on sustained all-core CPU plus known pool destinations; suspended workspaces are flagged for review |
| Rate limits | 10 creates or starts per user per minute; concurrent running workspaces per user from org policy; API limits per session |
| Audit | `workspace_events`, port visibility changes, and admin actions are append-only |

## Observability

| Metric | Type | Labels | Why |
|--------|------|--------|-----|
| `workspace_start_seconds` | Histogram | path (warm, cached, cold), class | The headline SLO; split by path shows whether the pool is undersized |
| `warm_pool_ready` | Gauge | image_digest, class | Pool depth; alert when below 20% of target |
| `warm_pool_claims_total` | Counter | result (hit, miss) | Hit ratio target >= 95% |
| `workspace_state` | Gauge | state, cell | Running count drives capacity planning |
| `reconcile_drift` | Gauge | cell | Rows where desired differs from observed for > 60 s |
| `snapshot_lag_seconds` | Histogram | cell | Time since last committed snapshot per running workspace; p99 must stay < 120 s |
| `host_lease_age_seconds` | Gauge | host | Early warning before fencing |
| `gateway_connections` | Gauge | node | Connection balance and deploy draining |
| `terminal_echo_rtt_ms` | Histogram | region | Client-reported ctl ping RTT; the keystroke SLO |
| `idle_stops_total` | Counter | reason | Reaper effectiveness; spikes indicate a broken activity signal |
| `host_disk_used_ratio` | Gauge | host | Cache eviction and admission control |

**Tracing.** A start is one trace with spans for placement, claim, volume attach, first chunk fetch, identity injection, agent ready, and client connect, so a slow p95 can be attributed to a step. **Logging.** Pino JSON logs with `workspaceId`, `generation`, `hostId`, and `traceId` on every line; terminal content and file contents are never logged.

## Failure Handling

| Failure | Detection | Response |
|---------|-----------|----------|
| Host loss | Lease not renewed for 30 s | Mark workspaces `recovering`; restart on warm VMs from the last snapshot; clients reconnect and are offered unsaved re-applies; ~35 s user-visible gap |
| Host partitioned but alive | Agent cannot renew within 20 s | Agent self-fences (pauses VMs, refuses streams); after the partition heals it destroys VMs whose generation is stale |
| Gateway node loss or deploy | Client socket closes | Client reconnects to another node with backoff; terminals replay from the last acked sequence; deploys send a `ctl: moved` frame first |
| Control plane DB down | Health checks | Running workspaces and the data plane continue; starts queue; the reaper pauses (it cannot record state, and it fails safe by not stopping) |
| Object storage degraded | Opossum breaker on uploads | Snapshots buffer on local NVMe up to a cap; suspends that need a final snapshot are deferred and the VM keeps running (cost over data loss); alert |
| Registry outage | Breaker on pulls | Warm pool and cached images keep starts working; cold starts for uncached images fail fast with a clear error |
| Workspace disk full | Guest `statfs` via agent | IDE banner at 90%; at 100% the agent (on its reserved disk) still serves the terminal so the user can clean up; snapshots are host-side so they still run |
| Host disk pressure | `host_disk_used_ratio` | Evict cached volumes of stopped workspaces and unused image layers; stop admitting at 85% |
| Runaway process | cgroup CPU throttling stats, guest memory | CPU is capped per VM; memory is fixed per VM so a leak triggers the guest OOM killer, not the host's; fork bombs hit the guest PID limit |
| Crypto mining or egress abuse | CPU and egress anomaly detection | Throttle, then suspend with `reason = abuse`; account flagged |
| Zone loss | Many leases expire together | Recover by priority (recent activity, paid tier) as capacity allows; no full N+1 zone headroom is held |
| Region loss | Regional health | Running sessions are lost; snapshots are replicated cross-region asynchronously (RPO ~15 min); users can restore in a fallback region at higher latency or recreate from git |

**Retries.** Control-plane-to-host calls use exponential backoff with jitter (100 ms, 200 ms, 400 ms, cap 5 s) and are safe because assignments are idempotent. Circuit breakers (Opossum) wrap object storage, the registry, the git provider, and KMS.

## Scalability Considerations

- **Cells.** A cell is ~1,000 hosts with its own PostgreSQL, Valkey, reconciler, and warm-pool manager. Peak needs ~5 cells. Cells cap blast radius and keep each database at ~1,000 snapshot commits/s and ~200 activity flushes/s
- **Gateways** are stateless; scale on connection count. Routing state is in-memory per node, refreshed by pub/sub, so a gateway handles a lookup without a network call
- **Hosts** scale linearly; the constraint is bare-metal procurement lead time, so capacity planning runs weeks ahead on running-workspace forecasts
- **Images** are distributed to hosts ahead of demand. At 10x, a registry serving cold pulls during the morning ramp becomes the first bottleneck, so hosts share layers peer-to-peer within a cell
- **Object storage** absorbs 15 GB/s of snapshot writes at peak; key prefixes are spread by chunk hash
- **What breaks first at 10x** (3M running, 40,000 hosts, 1,750 starts/s, 105,000 warm VMs, 150 GB/s of snapshots, 4M sockets): the morning ramp outruns warm-pool refill and image distribution, then per-cell databases. The answer is more cells (~40), predictive pool sizing from yesterday's curve, and P2P image distribution

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Isolation | Firecracker microVM | Containers / gVisor | Root + Docker inside is safe; per-tenant kernel |
| Volume | Local NVMe + 60 s snapshots | Network block storage | Laptop-speed metadata ops; stopped cost = object storage only |
| Lifecycle | Desired state + reconciler | Command queue | Idempotent, self-healing, no half-executed commands |
| Fencing | Generation on every side effect | Leases alone | A partitioned host can never commit stale state |
| Cold start | Warm pools by digest + image cache | Lazy image loading only | Removes 26 s of pull and boot for popular images |
| Traffic | Gateway + one multiplexed socket | Direct-to-host sockets | Hosts private; moves invisible; one reconnect path |
| Previews | Separate registrable domain | IDE subdomain | User code cannot touch IDE cookies or APIs |
| Idle policy | 30 min input-based timeout | Process-based activity | Unattended builds should not bill indefinitely |
| Suspend | Disk-only snapshot | Memory snapshot (hibernate) | 8 GB per workspace of memory images is too costly |
| Retention | Archive at 7 d, delete at 30 d | Keep forever | Storage grows without bound otherwise |

## Implementation Notes

Nothing is implemented yet. This section describes the **planned** local implementation that maps the production design onto Docker + Node.js/Express + TypeScript and React 19 + Vite + TanStack Router + Zustand + Tailwind.

### Planned Local Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Local machine                                                          │
│                                                                        │
│  Frontend (Vite :5173): Monaco · xterm.js · file tree · admin views    │
│        │ REST + SSE                          │ WebSocket + previews    │
│        ▼                                     ▼                         │
│  Control plane API (:3000)          Workspace gateway (:3001)          │
│  + reconciler, reaper, warm-pool    token check · route · preview      │
│        │                                     │                         │
│        │ assignments (long-poll)             │ HTTP/WS tunnel          │
│        ▼                                     ▼                         │
│  Host agent "host-a" (:3002)        Host agent "host-b" (:3003)        │
│        │ Docker Engine API (unix socket)     │                         │
│        ▼                                     ▼                         │
│  Workspace containers (one per workspace, labelled by host)            │
│                                                                        │
│  PostgreSQL :5432 · Valkey :6379 · MinIO :9000 (snapshots)             │
└────────────────────────────────────────────────────────────────────────┘
```

Two host-agent processes share one Docker daemon but own disjoint sets of containers (by label), which is enough to exercise placement, host loss (kill a host-agent process), fencing, and migration on resume.

### Production-Grade Patterns Planned

| Pattern | Why it matters at scale | Planned approach |
|---------|------------------------|------------------|
| Idempotency keys | Create retries must not produce two workspaces and two bills | `Idempotency-Key` header, `idempotency_keys` table, planned middleware at `backend/src/shared/idempotency.ts` |
| Generation fencing | A killed-then-restarted host agent must not overwrite newer snapshots | Conditional `UPDATE` on generation for snapshot commits and route writes |
| Circuit breakers (Opossum) | A slow MinIO or Docker daemon must not hang every request | Breakers around MinIO uploads/downloads, Docker API calls, and git clone |
| Prometheus metrics (prom-client) | Start latency by path and pool hit ratio are the SLOs | `/metrics` on each service with the metrics listed in Observability |
| Structured logging (Pino) | Lifecycle debugging needs `workspaceId` and `generation` on every line | Child loggers per workspace |
| Health checks | The reconciler must not place on a dead host agent | `/health/live` and `/health/ready` per service; host-agent lease in PostgreSQL |
| Rate limiting | Start loops and abuse | Valkey-backed limiter on create/start (10 per user per minute) |

Example of the planned reconciler step, kept short:

```typescript
// planned: backend/src/control-plane/reconciler.ts
for (const ws of await db.workspacesInTransition(cell, 50)) {
  if (ws.desiredState === 'running' && ['stopped', 'pending', 'recovering'].includes(ws.state)) {
    const vm = await claimWarmVm(ws.imageDigest, ws.machineClass, ws.cachedOnHostId)
      ?? await pickHost(ws);
    const generation = await markStarting(ws.id, vm.hostId);   // bumps generation atomically
    await notifyHost(vm.hostId, ws.id, generation);            // Valkey publish; agent long-polls
  }
}
```

### What Will Be Simplified or Simulated

| Production | Local substitute | Consequence |
|------------|------------------|-------------|
| Firecracker microVMs on bare metal | Docker containers with `--memory`, `--cpus`, `--pids-limit`; optional gVisor runtime if installed | Isolation is container-grade; documented as the main gap |
| vsock agent channel | Agent process inside the container on an internal Docker network, reached only by the host agent | Same protocol, different transport |
| Block-level incremental snapshots | `tar` + zstd of the workspace directory to MinIO on stop and on a 5-minute timer | Full copies, no dedup; RPO 5 min |
| Lazy chunk restore | Full download and untar on resume | Resume time grows with workspace size |
| Warm VMs with hot-attached volumes | Pre-started containers bound to an empty slot directory; restore untars into the slot on claim | Real latency difference between warm and cold is still visible |
| Egress policy on tap devices | Workspace network with no direct internet; an HTTP(S) CONNECT proxy container enforcing a per-workspace allowlist | Non-HTTP egress is simply blocked |
| Cells and global directory | Single cell, single region | No cross-cell routing |
| SSO and signed data-plane tokens | Session cookie (Valkey) for the API; HMAC-signed 5-minute token for the gateway | Same verification flow |
| Previews on a separate site | `{port}-{id}.preview.localhost:3001` (Chromium and Firefox resolve `*.localhost` to loopback) | Separate origin, same registrable domain locally |

### What Will Be Omitted

- Memory snapshots (hibernate) and live migration
- Prebuild triggers from git webhooks (a "build prebuild" button instead)
- Cross-region snapshot replication and region failover
- Abuse detection, billing, and budgets beyond usage records
- P2P image distribution and predictive warm-pool sizing
- Kubernetes or any orchestrator; the reconciler is the orchestrator
