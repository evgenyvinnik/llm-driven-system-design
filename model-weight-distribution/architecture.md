# Model Weight Distribution - Architecture Design

## System Overview

A system that moves a large model checkpoint (500 GB) from one origin to every host in a GPU inference fleet (1,000 hosts), as close as possible to the physical lower bound set by network bandwidth, and then switches the fleet to the new version safely. The data plane is a topology-aware peer-to-peer swarm: the checkpoint is split into content-addressed chunks described by a signed manifest of per-chunk SHA-256 hashes, and every host downloads chunks from its neighbors while uploading the chunks it already has. The control plane is a tracker and rollout service that hands out peer lists, records progress, detects stragglers, and stages versions through canary waves with version pinning. A resumable, parallel range downloader is the fallback path from origin storage and the building block every host agent uses.

**Learning goals:**

- Derive a bandwidth lower bound before designing anything, and use it as the yardstick for every alternative
- Understand why the receivers' upload capacity, not the source, decides how fast a file can reach N hosts
- Compare a pipelined chain or tree with a BitTorrent-style swarm under stragglers and failures
- Make peer selection aware of racks and oversubscribed uplinks
- Use per-chunk hashes so corruption is caught one hop from where it happened
- Separate distributing bytes from activating a version, so rollback is instant

## Requirements

### Functional Requirements

- **Register a model version**: upload a checkpoint to origin storage, build a manifest of files and per-chunk SHA-256 hashes, sign it, and identify the version by the manifest digest
- **Distribute**: deliver every byte of a version to every host in a target pool, verified chunk by chunk
- **Resume**: a host that crashes or restarts continues from the chunks it has already verified
- **Roll out**: stage a version on a pool, activate it in waves (canary first), and pin each pool to an exact digest
- **Control**: pause, resume, and abort a rollout; exclude a host; promote the next wave
- **Observe**: per-host and per-rack progress, ETA against the lower bound, stragglers, failures
- **Download directly**: a CLI and library that pulls a version from origin with parallel, resumable range requests

### Non-Functional Requirements

- **Speed**: 99% of healthy hosts hold a verified copy within 1.25x the bandwidth lower bound (500 s for the reference scenario); the slowest 1% within 2x (800 s)
- **Integrity**: no host ever serves or activates a byte that has not matched its manifest hash; a corrupt or malicious peer can waste bandwidth but cannot inject data
- **Origin protection**: origin egress for a rollout stays near one copy of the checkpoint, regardless of fleet size
- **Availability**: the control plane is not on the data path; a tracker outage stops new joins and control changes but does not stop in-flight transfers
- **Isolation**: distribution traffic can be capped per host so it does not starve inference traffic on the same NIC
- **Scale**: 1,000 hosts per pool today, 10,000 hosts across regions without redesign
- **Confidentiality**: weights are high-value IP; encrypted in transit and at rest, and served only to authenticated fleet members

### Out of Scope

- Training checkpoint sharding and how weights are produced
- Loading weights into GPU memory (covered only as an activation step)
- Internet-scale, untrusted swarms (no incentives or tit-for-tat needed inside one operator's fleet)
- Delta encoding between versions (noted under Scalability Considerations)

## Capacity Estimation

### Assumptions (used in every document in this project)

| Quantity | Value | Note |
|----------|-------|------|
| Checkpoint size F | 500 GB = 4,000 Gb | Decimal units throughout; ~100 safetensors shards of 5 GB |
| Hosts N | 1,000 | Each 8-GPU host needs the complete checkpoint |
| Host NIC | 10 Gbps, full duplex | 10 Gbps down and 10 Gbps up at the same time |
| Origin upload | 10 Gbps | One bandwidth-constrained source |
| Topology | 40 racks x 25 hosts | ToR uplink 100 Gbps against 250 Gbps of host ports (2.5:1 oversubscribed) |
| Chunk size | 16 MB = 128 Mb | 31,250 chunks; 12.8 ms per chunk at 10 Gbps |
| Local NVMe | >= 1.5 TB free, ~5 GB/s write | Room for the active and previous versions (1 TB) |
| SHA-256 | ~2 GB/s per core | With SHA extensions |
| Object store | ~100 MB/s per connection | Typical per-connection cap |

### The Lower Bound

For a file of size F, a source with upload u_s, N receivers with download d_i and upload u_i, no schedule can finish faster than:

```
T_min = max( F / u_s,               the source must emit at least one full copy
             F / min(d_i),          the slowest receiver must download F
             N * F / (u_s + Σ u_i)) all N copies must be uploaded by someone
```

Reference scenario: F = 4,000 Gb, u_s = 10 Gbps, d_i = u_i = 10 Gbps, N = 1,000.

| Term | Value |
|------|-------|
| F / u_s | 4,000 / 10 = 400 s |
| F / d | 4,000 / 10 = 400 s |
| N * F / (u_s + N * u) | 4,000,000 / 10,010 = 399.6 s |
| **T_min** | **400 s (6 min 40 s)** |

### Strategies Against the Bound

| Strategy | Time | Why |
|----------|------|-----|
| Origin serves hosts one at a time | 1,000 x 400 s = 400,000 s ~ 4.6 days | Source-bound; mean completion 200,200 s ~ 2.3 days |
| Origin serves all hosts at once | 400,000 s ~ 4.6 days | 10 Mbps each; nobody finishes early |
| Whole-file doubling (each finished host sends to one new host) | 10 rounds x 400 s = 4,000 s ~ 67 min | 2^10 = 1,024 >= 1,001 holders; store-and-forward |
| Single pipelined binary tree, chunked | ~800 s | Interior nodes split upload 2 ways; leaves (half the hosts) upload nothing |
| Pipelined chain, chunked | 400 + 999 x 12.8 ms ~ 413 s | Near the floor, but throughput = slowest host, and one failure breaks it |
| Binomial pipeline (theoretical optimum) | (31,250 + 10) x 12.8 ms ~ 400.1 s | Floor plus log2(N) chunk-times of pipeline depth |
| **Rack-aware swarm (chosen)** | **~445 s at 90% goodput** | Floor / 0.9; self-healing; target <= 500 s |

The key observation: whether the origin sends to one host at a time or to all at once, the makespan is N x F / u_s. Splitting bandwidth only changes who finishes when. The only way below 4.6 days is to make receivers upload.

### Variant: 10 GB to Thousands of Hosts

F = 10 GB = 80 Gb, N = 2,000, source upload 1 Gbps, host download 1 Gbps, host upload 250 Mbps.

| Term | Value |
|------|-------|
| Origin serves each host in turn | 2,000 x 80 s = 160,000 s ~ 44 h ~ 1.85 days |
| F / u_s | 80 s |
| F / d | 80 s |
| N * F / (u_s + N * u) | 160,000 / (1 + 500) = 319 s |
| **T_min** | **~320 s (5.3 min), upload-bound** |

Here the binding term flips. Hosts could download in 80 s, but the fleet's total upload (501 Gbps) is a quarter of its total download demand (2,000 Gbps), so on average each host can only receive at ~250 Mbps. Every byte of upload must be useful: no duplicate transfers, finished hosts keep seeding, and the source sends each chunk once. With 16 MB chunks this file has 625 chunks.

### Control Plane Load

| Item | Value |
|------|-------|
| Announces | 1,000 hosts / 5 s = 200 req/s |
| Bitfield size | 31,250 bits ~ 3.9 KB; 200/s x 3.9 KB ~ 0.8 MB/s |
| Chunk completions per rollout | 1,000 x 31,250 = 31.25 M (~78,000/s fleet-wide, 78/s per host) |
| Aggregate fleet download at the floor | 1,000 x 10 Gbps = 10 Tbps; 500 TB moved per rollout |
| Manifest | 31,250 x 32 B = 1 MB of hashes |
| Console stream | ~16 B per host per second ~ 16 KB/s per viewer |

The 78,000 chunk events per second are the reason chunk-level state stays between peers and only per-host summaries reach the tracker.

### Local Development Scale

| Quantity | Value |
|----------|-------|
| Synthetic checkpoint | 512 MB, 4 MB chunks = 128 chunks |
| Simulated hosts | 12 (3 racks x 4) |
| Host and origin throttle | 8 MB/s up and down (token bucket) |
| Rack uplink throttle | 16 MB/s per rack (2:1 against 32 MB/s of host ports) |
| Floor | 512 / 8 = 64 s |
| Origin serving each host in turn | 12 x 64 = 768 s |
| Random peers | 8/11 of bytes cross racks; 4 x 512 x 8/11 = 1,489 MB per rack / 16 MB/s ~ 93 s |
| Rack-aware peers | ~1 copy (512 MB) per rack / 16 MB/s = 32 s of uplink time |
| Disk | 12 x 512 MB ~ 6.1 GB |

## High-Level Architecture

```
                         ┌──────────────────────────────┐
                         │       Rollout Console        │
                         │  per-rack heatmap, ETA, ctl  │
                         └──────────────┬───────────────┘
                                        │ HTTPS + SSE
┌───────────────────┐    ┌──────────────▼───────────────┐    ┌──────────────────────┐
│  Model Registry   │───▶│        Control Plane         │───▶│      PostgreSQL      │
│  register, sign,  │    │ Rollout service + Tracker    │    │ versions, rollouts,  │
│  build manifest   │    │ stateless, 3 replicas        │    │ hosts, pins, events  │
└─────────┬─────────┘    └──────────────┬───────────────┘    ├──────────────────────┤
          │                             │                    │ Redis: bitfields,    │
          ▼                             │ announce, peers,   │ progress, epochs     │
┌───────────────────┐                   │ control epoch      └──────────────────────┘
│  Origin Storage   │                   │
│  object store:    │      ┌────────────┴─────────────────────────────────────────┐
│  shards+manifest  │      │                                                      │
└─────────┬─────────┘ ┌────▼────── Rack 1 ──────────────────┐  ┌── Rack 40 ───────▼─────┐
          │ range GET │ ┌─────────┐  ┌─────────┐  ┌───────┐ │  │ ┌─────────┐  ┌───────┐ │
          │ one copy  │ │ Agent 1 │◀▶│ Agent 2 │◀▶│ ...25 │ │  │ │ Agent 1 │◀▶│ ...25 │ │
          └──────────▶│ └─────────┘  └─────────┘  └───────┘ │  │ └─────────┘  └───────┘ │
                      │              ToR switch             │  │       ToR switch       │
                      └──────────────────┬──────────────────┘  └────────────┬───────────┘
                                         │       100 Gbps ToR uplinks       │
                                         └───────────── Spine ──────────────┘
                                             cross-rack chunk transfers
```

Bytes flow origin → a few hosts per rack → everyone in the rack. Control flows agents ↔ tracker. The console reads aggregated state; it never sees chunk-level events.

## Core Components / Request Flows

### 1. Model Registry

Accepts a checkpoint (a directory of shard files), splits each file into 16 MB chunks (chunks never span files; the last chunk of a file may be short), computes SHA-256 per chunk, writes the canonical manifest, and signs it. The **version digest** is the SHA-256 of the canonical manifest bytes, so the digest names exactly one set of bytes. Tags like `prod` or `2026-10-rc3` are mutable pointers resolved to a digest once, at rollout creation.

### 2. Origin Storage

An S3-compatible object store holding chunk ranges of the shard files and the manifest. It is sized to emit roughly one copy per rollout per region. Locally it is MinIO.

### 3. Tracker

Stateless HTTP service over Redis. Agents announce every 5 s with their verified-chunk count, rates, and (every few announces) a compressed bitfield. The tracker answers with a peer list chosen by topology: up to 15 same-rack peers and 5 cross-rack peers, preferring hosts with many chunks and spare upload slots, plus the origin as a last resort. It aggregates bitfields into per-chunk replica counts, which the console and the origin's seeding order use. It is not on the data path: an agent that cannot reach it keeps its current peers.

### 4. Rollout Service

Owns rollouts as a state machine (`pending → distributing → activating → completed`, with `paused`, `aborted`, `failed`), computes the lower bound for the target pool from inventory, detects stragglers from tracker summaries, and drives activation waves. Every control change bumps a **control epoch** that agents read on their next announce.

### 5. Host Agent

A daemon on every GPU host. It downloads chunks from peers (and from origin when necessary), verifies each against the manifest, writes it with `pwrite` into a preallocated file, records it in a local journal, advertises it to neighbors, and serves chunks to peers from 4 upload slots. On activation it swaps a symlink from the active version directory to the new one and asks the inference server to reload.

### 6. Rollout Console

React app showing per-rack and per-host progress, ETA against the floor, stragglers, chunk availability, and control buttons. It consumes a server-sent event stream of 1 Hz per-host deltas.

### Request Flow: Distributing a Version

```
1. Operator: POST /rollouts {digest, pool, waves}      → rollout row, epoch 1
2. Rollout service resolves hosts, computes T_min      → state = distributing
3. Agent announce (event=started)                      → tracker returns peers + manifest URL
4. Agent fetches manifest, verifies signature          → knows 31,250 chunk hashes
5. Loop until all chunks verified:
     pick chunk (rack ingress stripe first, then rarest-first among peers)
     request from best peer holding it; timeout = 3x expected chunk time
     verify SHA-256 → pwrite → fdatasync batch → journal → HAVE to neighbors
6. Agent announce (event=completed)                    → rollout_hosts.state = staged
7. Rollout service activates wave 1 (canary rack)      → agents swap symlink, reload
8. Health gates pass → waves 2, 3                       → pool pin = new digest
```

### Chunk Selection Algorithm

```typescript
// Planned agent scheduler (sketch). Runs whenever a download slot frees up.
function nextChunk(state: AgentState): ChunkRequest | null {
  const missing = state.missing; // chunks not yet verified
  // 1. Rack ingress: this host owns chunks where index % rackSize === rackPosition.
  //    If no peer in the rack has one of them, fetch it cross-rack (or from origin).
  const owned = missing.filter(i => i % state.rackSize === state.rackPosition
                                  && state.rackReplicas(i) === 0);
  if (owned.length) return fromBestRemote(rarest(owned, state.globalReplicas));
  // 2. Everything else: rarest-first among chunks some neighbor already holds.
  const available = missing.filter(i => state.neighborReplicas(i) > 0);
  if (available.length) return fromBestNeighbor(rarest(available, state.neighborReplicas));
  // 3. Endgame: with <= 1% missing, request each remaining chunk from 2 peers, cancel the loser.
  if (missing.length <= state.chunkCount * 0.01) return duplicateRequest(missing);
  // 4. Starved for too long (owner of a stripe is dead): fall back to remote fetch.
  return state.starvedFor > 3_000 ? fromBestRemote(rarest(missing, state.globalReplicas)) : null;
}
```

The stripe rule makes each chunk enter each rack about once, and spreads cross-rack work evenly over the 25 hosts in the rack.

## Database Schema

PostgreSQL holds durable control-plane state. Chunk hashes live in the manifest object (1 MB), not in rows. Live swarm state lives in Redis.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE models (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    owner_team  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE model_versions (
    digest          CHAR(64) PRIMARY KEY,               -- SHA-256 of canonical manifest bytes
    model_id        UUID NOT NULL REFERENCES models(id),
    version_label   TEXT NOT NULL,                      -- human tag, immutable once sealed
    total_bytes     BIGINT  NOT NULL CHECK (total_bytes > 0),
    chunk_size      INTEGER NOT NULL CHECK (chunk_size BETWEEN 1048576 AND 268435456),
    chunk_count     INTEGER NOT NULL CHECK (chunk_count > 0),
    manifest_uri    TEXT NOT NULL,
    signature       BYTEA NOT NULL,                     -- Ed25519 over the digest
    signing_key_id  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'registered'
                    CHECK (status IN ('registered', 'sealed', 'deprecated', 'deleted')),
    created_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (model_id, version_label)
);
CREATE INDEX idx_model_versions_model ON model_versions (model_id, created_at DESC);

CREATE TABLE model_files (
    digest       CHAR(64) NOT NULL REFERENCES model_versions(digest) ON DELETE CASCADE,
    file_index   INTEGER  NOT NULL,
    path         TEXT     NOT NULL,
    size_bytes   BIGINT   NOT NULL CHECK (size_bytes > 0),
    first_chunk  INTEGER  NOT NULL CHECK (first_chunk >= 0),
    chunk_count  INTEGER  NOT NULL CHECK (chunk_count > 0),
    PRIMARY KEY (digest, file_index),
    UNIQUE (digest, path)
);

CREATE TABLE racks (
    id           TEXT PRIMARY KEY,
    zone         TEXT NOT NULL,
    pod          TEXT NOT NULL,
    uplink_gbps  INTEGER NOT NULL CHECK (uplink_gbps > 0)
);

CREATE TABLE hosts (
    id                 TEXT PRIMARY KEY,
    rack_id            TEXT NOT NULL REFERENCES racks(id),
    pool               TEXT NOT NULL,                   -- serving pool, e.g. 'chat-prod-us-east'
    nic_gbps           INTEGER NOT NULL CHECK (nic_gbps > 0),
    disk_free_bytes    BIGINT  NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'draining', 'quarantined', 'retired')),
    agent_version      TEXT,
    last_heartbeat_at  TIMESTAMPTZ
);
CREATE INDEX idx_hosts_pool_status ON hosts (pool, status);
CREATE INDEX idx_hosts_rack ON hosts (rack_id);

-- Version pinning: the digest each pool should be serving.
CREATE TABLE pool_pins (
    pool             TEXT PRIMARY KEY,
    model_id         UUID NOT NULL REFERENCES models(id),
    active_digest    CHAR(64) NOT NULL REFERENCES model_versions(digest),
    previous_digest  CHAR(64) REFERENCES model_versions(digest),
    lock_version     INTEGER NOT NULL DEFAULT 0,        -- optimistic concurrency
    updated_by       TEXT NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rollouts (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    digest                CHAR(64) NOT NULL REFERENCES model_versions(digest),
    pool                  TEXT NOT NULL,
    state                 TEXT NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'distributing', 'paused', 'activating',
                                           'completed', 'aborted', 'failed')),
    control_epoch         INTEGER NOT NULL DEFAULT 1,   -- bumped on every control change
    bandwidth_cap_mbps    INTEGER CHECK (bandwidth_cap_mbps > 0),
    min_success_ratio     NUMERIC(4,3) NOT NULL DEFAULT 0.990,
    lower_bound_seconds   INTEGER,                      -- computed from inventory at start
    idempotency_key       TEXT NOT NULL UNIQUE,
    created_by            TEXT NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at            TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ
);
-- At most one in-flight rollout per pool.
CREATE UNIQUE INDEX uq_rollouts_active_pool ON rollouts (pool)
    WHERE state IN ('pending', 'distributing', 'paused', 'activating');
CREATE INDEX idx_rollouts_digest ON rollouts (digest);

CREATE TABLE rollout_waves (
    rollout_id     UUID NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
    wave_no        SMALLINT NOT NULL CHECK (wave_no >= 1),
    host_percent   NUMERIC(5,2) NOT NULL CHECK (host_percent > 0 AND host_percent <= 100),
    gate           TEXT NOT NULL DEFAULT 'manual' CHECK (gate IN ('manual', 'auto')),
    soak_seconds   INTEGER NOT NULL DEFAULT 1800,
    state          TEXT NOT NULL DEFAULT 'waiting'
                   CHECK (state IN ('waiting', 'activating', 'soaking', 'passed', 'failed')),
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    PRIMARY KEY (rollout_id, wave_no)
);

CREATE TABLE rollout_hosts (
    rollout_id       UUID NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
    host_id          TEXT NOT NULL REFERENCES hosts(id),
    wave_no          SMALLINT NOT NULL,
    state            TEXT NOT NULL DEFAULT 'queued'
                     CHECK (state IN ('queued', 'downloading', 'staged', 'activating',
                                      'active', 'failed', 'excluded')),
    chunks_verified  INTEGER NOT NULL DEFAULT 0 CHECK (chunks_verified >= 0),
    bytes_verified   BIGINT  NOT NULL DEFAULT 0,
    rate_bps         BIGINT,                            -- 30 s download rate
    is_straggler     BOOLEAN NOT NULL DEFAULT false,
    failure_reason   TEXT,
    attempts         SMALLINT NOT NULL DEFAULT 0,
    last_seq         BIGINT NOT NULL DEFAULT 0,         -- highest announce seq applied
    started_at       TIMESTAMPTZ,
    staged_at        TIMESTAMPTZ,
    activated_at     TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rollout_id, host_id)
);
CREATE INDEX idx_rollout_hosts_state ON rollout_hosts (rollout_id, state);
CREATE INDEX idx_rollout_hosts_stragglers ON rollout_hosts (rollout_id) WHERE is_straggler;

-- What each host has on disk. Exactly one active version per host.
CREATE TABLE host_versions (
    host_id       TEXT NOT NULL REFERENCES hosts(id),
    digest        CHAR(64) NOT NULL REFERENCES model_versions(digest),
    state         TEXT NOT NULL CHECK (state IN ('staging', 'staged', 'active', 'previous', 'evicting')),
    staged_at     TIMESTAMPTZ,
    activated_at  TIMESTAMPTZ,
    PRIMARY KEY (host_id, digest)
);
CREATE UNIQUE INDEX uq_host_versions_active ON host_versions (host_id) WHERE state = 'active';

CREATE TABLE control_actions (
    id               BIGSERIAL PRIMARY KEY,
    rollout_id       UUID NOT NULL REFERENCES rollouts(id),
    action           TEXT NOT NULL CHECK (action IN ('pause', 'resume', 'abort', 'promote',
                                                     'exclude_host', 'retry_host')),
    target_host_id   TEXT REFERENCES hosts(id),
    resulting_epoch  INTEGER NOT NULL,
    idempotency_key  TEXT NOT NULL,
    actor            TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (rollout_id, idempotency_key)
);

CREATE TABLE rollout_events (
    id          BIGSERIAL PRIMARY KEY,
    rollout_id  UUID NOT NULL REFERENCES rollouts(id),
    host_id     TEXT REFERENCES hosts(id),
    type        TEXT NOT NULL,      -- straggler_flagged, chunk_corrupt, host_failed, wave_passed ...
    payload     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rollout_events_rollout ON rollout_events (rollout_id, created_at);
```

### Manifest Format (object storage)

```json
{
  "model": "assistant-large",
  "versionLabel": "2026-10-rc3",
  "chunkSize": 16000000,
  "files": [
    { "path": "model-00001-of-00100.safetensors", "size": 5000000000,
      "firstChunk": 0, "chunkCount": 313 }
  ],
  "chunks": ["9f86d081884c7d65...", "3e23e8160039594a..."]
}
```

A 5 GB shard is 312.5 chunks, so each shard has 313 chunks with a short last one; across 100 shards that is 31,300 chunk entries, slightly more than the 31,250 of a single contiguous file. The signature covers the digest of these exact bytes.

### Redis Keys (live swarm state)

| Key | Type | Contents | TTL |
|-----|------|----------|-----|
| `swarm:{rollout}:members` | Hash | host → rack, address, last announce, seq | rollout lifetime |
| `swarm:{rollout}:rack:{rack}` | Set | host ids in the rack | rollout lifetime |
| `swarm:{rollout}:bf:{host}` | String (bitmap) | verified-chunk bitfield, ~3.9 KB | rollout lifetime |
| `swarm:{rollout}:avail` | String | per-chunk replica counts (uint16), ~62.5 KB | recomputed every 5 s |
| `swarm:{rollout}:progress` | Hash | host → chunks verified, rate, straggler flag | rollout lifetime |
| `swarm:{rollout}:control` | Hash | state, epoch, bandwidth cap | rollout lifetime |

Progress is flushed from Redis to `rollout_hosts` every 10 s (100 row upserts per second for 1,000 hosts).

## API Design

### Control Plane

```
POST   /api/v1/models/:name/versions            Register a version (manifest + signature)
GET    /api/v1/versions/:digest                 Version metadata
GET    /api/v1/versions/:digest/manifest        Signed manifest (redirect to origin)
POST   /api/v1/rollouts                         Create rollout (Idempotency-Key header)
GET    /api/v1/rollouts/:id                     State, waves, lower bound, ETA
GET    /api/v1/rollouts/:id/hosts?state=&rack=  Per-host progress (paged)
GET    /api/v1/rollouts/:id/stream              SSE: snapshot, then 1 Hz deltas
POST   /api/v1/rollouts/:id/pause               Bump epoch; agents stop requesting
POST   /api/v1/rollouts/:id/resume
POST   /api/v1/rollouts/:id/abort               Stop, release staged bytes
POST   /api/v1/rollouts/:id/promote             Activate next wave
POST   /api/v1/rollouts/:id/hosts/:host/exclude
PUT    /api/v1/pools/:pool/pin                  Pin pool to digest (If-Match: lock_version)
```

Example create request and response:

```json
POST /api/v1/rollouts
Idempotency-Key: 3c1d...e9
{ "digest": "a41f...", "pool": "chat-prod-us-east",
  "waves": [{"hostPercent": 2.5, "gate": "manual"}, {"hostPercent": 25}, {"hostPercent": 100}],
  "bandwidthCapMbps": null }

201 Created
{ "id": "r-7f2c", "state": "distributing", "controlEpoch": 1,
  "hosts": 1000, "lowerBoundSeconds": 400, "targetSeconds": 500 }
```

### Tracker

```
POST   /api/v1/tracker/announce      Host progress in, peer list + control epoch out
GET    /api/v1/tracker/:rollout/availability   Per-chunk replica counts (console, seeding)
```

```json
POST /api/v1/tracker/announce
{ "rolloutId": "r-7f2c", "hostId": "h-0412", "seq": 88, "event": "progress",
  "chunksVerified": 18032, "downBps": 9300000000, "upBps": 9100000000,
  "bitfield": "<base64, every 3rd announce>" }

200 OK
{ "intervalSeconds": 5, "controlEpoch": 1, "state": "distributing", "capMbps": null,
  "peers": [{ "hostId": "h-0413", "addr": "10.4.12.13:7000", "rack": "r12" }, "..."] }
```

### Peer Protocol (agent to agent)

```
GET  /v1/chunks/:digest/:index     Chunk bytes; 404 if not held, 429 if all upload slots busy
GET  /v1/bitfield/:digest          Current verified bitfield
WS   /v1/peers/:digest/have        Stream of HAVE(index) notifications to neighbors
```

### Origin (S3-compatible)

```
GET /:bucket/:digest/:file   Range: bytes=a-b   If-Match: <etag>
```

## Key Design Decisions

### 1. Swarm over a pipelined chain or tree

**Chosen: rack-aware, tracker-assisted swarm with rarest-first chunk selection.**

The bound says all 1,000 uplinks must be busy for the whole transfer. A swarm does that dynamically: any host holding a chunk can serve it, so a slow or dead host simply stops being chosen. Expected time is ~445 s at 90% goodput.

A pipelined chain reaches ~413 s on paper, but its throughput equals the slowest of 1,000 hosts, and a failure stalls everyone downstream until the chain is spliced. If each host has a 0.1% chance of being degraded during the window, the chance that at least one is degraded is 1 − 0.999^1000 ≈ 63%, so most rollouts would hit a slow link. A single tree wastes the upload of its leaves, which in a binary tree are half the hosts, and runs at ~2x the floor. Multiple striped trees (SplitStream style) recover the floor but need constant repair as hosts slow down.

**Given up:** determinism. Per-host ETA is statistical, chunks are sometimes sent twice (endgame), and debugging requires per-chunk telemetry.

### 2. Topology-aware peer selection

**Chosen: tracker returns mostly same-rack peers; each host owns a 1/25 stripe of chunk indices for cross-rack ingest.**

With random peers, 975 of 999 possible senders are in other racks, so 97.6% of bytes cross a ToR. Each rack would need 25 x 4,000 Gb x 0.976 = 97,600 Gb through a 100 Gbps uplink: 976 s, 2.4x the floor. Rack-aware selection brings each chunk into the rack about once (~1.5 copies with retries), 6,000 Gb or 60 s of uplink time spread over a 400 s rollout.

**Given up:** the tracker needs accurate inventory (rack, pod), and stripe owners become a temporary single source for their chunks inside the rack. A 3 s starvation timeout lets other hosts fetch cross-rack when an owner is slow.

### 3. Central tracker over gossip

**Chosen: replicated stateless tracker over Redis for membership, peer lists, progress and control; neighbor-to-neighbor HAVE messages for chunk availability.**

A managed fleet has an operator and inventory. At 200 announces/s the tracker is cheap, and it is the natural home for rollout control, straggler detection, and the console's global view. Pause and abort need an authoritative state with acknowledgments; gossip spreads them in O(log N) rounds with no confirmation that the last host heard. Gossip or a DHT suits untrusted internet swarms with no operator, which is not this problem.

**Given up:** a dependency. It is kept off the data path: agents cache peers and keep transferring when the tracker is down; only joins and control changes wait.

### 4. Per-chunk SHA-256 manifest, signed

**Chosen: flat list of per-chunk SHA-256 hashes in a signed manifest; the manifest digest is the version id.**

Every chunk is verified before it is written to the journal, advertised, or served, so a corrupt byte travels at most one hop and the sender is identified. A whole-file hash would detect corruption only after 500 GB had arrived and already been re-served to other hosts, without saying which chunk or peer. A Merkle tree allows verifying sub-chunk pieces and a smaller root, but the flat list is only 1 MB, so the added complexity buys nothing here.

**Given up:** a 1 MB manifest fetch per host before the first chunk (negligible) and the need to manage a signing key.

### 5. Stage everywhere, activate in waves

**Chosen: distribute to the whole pool in one swarm, then activate canary → 25% → 100%; pin pools by digest; keep the previous version on disk.**

Distribution costs about 7 minutes and does not change what is served, so there is no reason to stage in waves (staging a 25-host canary alone forfeits the fleet's upload capacity). Risk lives in activation, so activation is gated. Rollback is a symlink swap to the previous digest, already on disk, plus a ~100 s reload from NVMe at ~5 GB/s.

**Given up:** 1 TB of disk per host for two versions, and bandwidth spent staging a version that the canary might reject.

## Consistency and Idempotency

- **Content addressing makes data transfer idempotent.** A chunk is named by (digest, index) and is immutable; downloading it twice writes identical bytes to the same offset.
- **Journal-before-advertise.** The agent writes the chunk, batches `fdatasync`, then appends the index to its journal, then sends HAVE. After a crash, every journaled chunk is durable and correct; anything not journaled is fetched again. Resume never rehashes 500 GB (that would take 250 s at 2 GB/s).
- **Announce ordering.** Announces carry a per-host monotonically increasing `seq`; the tracker ignores any seq ≤ `last_seq`, so retried or reordered announces cannot roll progress backwards.
- **Control epochs.** Every pause, resume, abort, or cap change increments `control_epoch`. Agents apply a control state only if its epoch is newer than the one they hold and echo the epoch they applied; the console shows "paused on 987 / 1,000 hosts" from those echoes.
- **Idempotent control API.** Rollout creation and control actions require an `Idempotency-Key`; the unique constraints on `rollouts.idempotency_key` and `control_actions (rollout_id, idempotency_key)` turn retries into the original response.
- **Pins use optimistic concurrency.** `PUT /pools/:pool/pin` requires `If-Match: lock_version`, so two operators cannot silently overwrite each other's pin.
- **Activation invariant.** An agent activates a digest only if every chunk in its manifest is in its journal. Activation is a symlink swap (atomic `rename`) followed by a reload, idempotent by digest.
- **Range downloads pin the object.** Every origin range request carries `If-Match` with the ETag seen on the first request; a 412 means the object changed and the download aborts instead of mixing bytes from two versions.

## Security / Auth

- **Signed manifests.** The registry signs the manifest digest with an Ed25519 key; agents pin the registry's public keys and reject unsigned or unknown-key manifests. Per-chunk hashes then make every peer untrusted for data.
- **mTLS everywhere.** Agents, tracker, and origin authenticate with workload certificates from the fleet CA. A peer serves chunks only to clients whose certificate maps to a host in the same rollout (checked against a short-lived swarm token issued at announce).
- **Encryption.** TLS in transit (AES-GCM runs at several GB/s per core, so 10 Gbps costs about one core); dm-crypt at rest on the model cache.
- **Authorization.** RBAC on the control plane: `viewer` reads, `operator` pauses and excludes hosts, `release-manager` creates rollouts and promotes waves; promoting to 100% on production pools needs a second approver.
- **Rate limiting.** Announces limited to 1 per 2 s per host at the tracker; control endpoints limited per user.
- **Peer misbehavior.** Three hash mismatches from one peer within a rollout ban it from the swarm and quarantine the host for inspection.

## Observability

### Metrics (prom-client naming)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `mwd_bytes_total` | Counter | direction, scope (rack_local, cross_rack, origin) | Proves rack-awareness; origin egress per rollout |
| `mwd_chunk_fetch_seconds` | Histogram | scope | Expect ~12.8 ms at line rate for 16 MB |
| `mwd_chunk_verify_failures_total` | Counter | peer_rack | Corruption or attack |
| `mwd_rollout_hosts` | Gauge | rollout, state | Funnel: downloading → staged → active |
| `mwd_rollout_lower_bound_seconds` | Gauge | rollout | The yardstick |
| `mwd_rollout_efficiency_ratio` | Gauge | rollout | lower bound / elapsed (or projected) |
| `mwd_stragglers` | Gauge | rollout | Hosts below half the swarm median rate |
| `mwd_tracker_announce_seconds` | Histogram | result | Tracker health |
| `mwd_rack_uplink_utilization` | Gauge | rack | From switch telemetry, to validate the model |

### Logging and Tracing

Pino JSON logs. Chunk-level events are never logged individually (31.25 M per rollout); agents log errors and per-minute summaries. Each rollout is a trace with spans per wave and per activation batch.

### Alerts

- Efficiency projected below 0.8 for 2 minutes
- Origin egress above 1.5 copies per region for a rollout
- Any verify failure (page on more than 10 per rollout)
- Straggler count above 2% of hosts

## Failure Handling

| Failure | Detection | Response |
|---------|-----------|----------|
| Slow peer | Chunk fetch exceeds 3x its expected time (~40 ms at full line rate; ~150 ms when the sender splits 10 Gbps over 4 upload slots) | Cancel, re-request elsewhere, lower that peer's score |
| Straggler host | 30 s download rate below half the swarm median | Flag; give it more peers and origin access; exclude if still slow at 2x floor |
| Host crash | 3 missed announces (15 s) | Remove from peer lists; on restart resume from journal |
| Corrupt chunk | SHA-256 mismatch | Discard, strike the sender, re-request; ban after 3 strikes |
| Disk full / I/O error | Agent health check | Fail host for this rollout; do not count against success ratio twice |
| Rack switch down | 25 hosts miss announces together | Treat as rack failure; rollout continues if success ratio still reachable |
| Tracker down | Announce errors (circuit breaker opens) | Keep current peers and HAVE gossip; retry with backoff and jitter |
| Origin down | Range GET errors (circuit breaker) | Swarm completes if every chunk has a replica; else fail over to another region's origin |
| Bad version | Canary health gates (errors, latency, eval checks) | Abort; pools stay pinned to the previous digest; staged bytes evicted |

**Endgame.** When a host has at most 1% of chunks missing, it requests each remaining chunk from two peers and cancels the slower request. This costs at most 1% duplicate bytes and keeps one slow peer from holding the last chunk.

**Success ratio.** A rollout completes distribution when `min_success_ratio` (99%) of hosts are staged, instead of waiting for 100%. The rest are retried in the background or excluded.

**QoS.** If a pool is serving while it stages, a per-host token bucket caps distribution. At 8 Gbps the floor becomes 4,000 / 8 = 500 s, and the console's lower bound reflects the cap.

**Circuit breakers.** Opossum breakers on the agent's tracker client and origin client: open after 50% errors over 20 calls, half-open after 10 s.

## Scalability Considerations

- **More hosts.** The swarm's capacity grows with N, so the bound stays ~400 s at 10,000 hosts. What grows is control traffic: 2,000 announces/s and 7.8 MB/s of bitfields. Bitfields become deltas (ranges of new chunks) and the tracker shards by (rollout, pod).
- **Multiple regions.** Treat a region like a big rack: send one copy across the WAN per region (500 GB at 100 Gbps is 40 s), then swarm inside the region. Per-region origin replicas protect against cross-region loss.
- **Faster NICs.** At 100 Gbps the network floor drops to 40 s, but a single NVMe at ~5 GB/s needs 100 s to write 500 GB, and hashing 12.5 GB/s needs about 6 cores. The bottleneck moves from the network to disk and CPU; stripe writes across drives or stream into page cache.
- **Bigger models.** Time is linear in F: 2 TB at 10 Gbps is 1,600 s.
- **Sharded loading.** If a host only needs its tensor-parallel slice (1/8 of 500 GB = 62.5 GB), each slice forms its own swarm and the floor drops to 50 s.
- **Delta updates.** Fine-tunes that change some tensors reuse identical chunks from the previous version; the agent copies matching chunks locally and fetches only changed ones.

### What Breaks First

1. **ToR uplinks**, if peer selection is not rack-aware (976 s instead of ~445 s).
2. **Tracker bitfield ingest**, at ~10,000 hosts per rollout without deltas.
3. **Origin**, when autoscaling adds cold hosts outside a rollout and each pulls from origin. New hosts must join the standing swarm of seeders instead.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Distribution topology | Swarm | Pipelined chain or tree | Near floor and self-healing; chain speed is set by its slowest host |
| Peer selection | Rack-aware with ingress stripes | Random peers | Random sends 97.6% of bytes across ToRs: 976 s vs ~445 s |
| Coordination | Central tracker + neighbor HAVE | Gossip / DHT | Managed fleet needs authoritative control and global progress |
| Chunk size | 16 MB | 1 MB or 256 MB | 12.8 ms pipeline step, 1 MB manifest, cheap retries |
| Integrity | Per-chunk SHA-256, signed manifest | Whole-file hash | Catches corruption one hop away and names the sender |
| Hash structure | Flat list | Merkle tree | 1 MB is small; no sub-chunk verification needed |
| Origin seeding | Each chunk once before any repeats | Serve on demand | Origin egress near one copy |
| Resume | Journal after fdatasync | Rehash on restart | Rehash costs 250 s; journal makes resume proportional to missing chunks |
| Completion | 99% success ratio | Wait for 100% | One sick host must not block a fleet |
| Rollout | Stage all, activate in waves | Stage in waves | Distribution is cheap; activation is the risk |
| Versioning | Pin by digest | Mutable tags | Byte-identical replicas; instant rollback |

## Implementation Notes

Nothing is implemented yet. This section describes the **planned** local build.

### Planned Local Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                           Local Machine                                │
│                                                                        │
│  ┌──────────────┐     ┌────────────────────────────────────┐           │
│  │  Console     │────▶│  Control plane (Express) :3000     │           │
│  │  Vite :5173  │ SSE │  rollouts API + tracker + stream   │           │
│  └──────────────┘     │  (:3001-3003 for multi-instance)   │           │
│                       └──────┬──────────────┬──────────────┘           │
│                              │              │                          │
│                       ┌──────▼─────┐ ┌──────▼──────┐  ┌─────────────┐  │
│                       │ PostgreSQL │ │   Valkey    │  │   MinIO     │  │
│                       │   :5432    │ │   :6379     │  │   :9000     │  │
│                       └────────────┘ └─────────────┘  └──────▲──────┘  │
│                                                              │ range   │
│  ┌──────────────────── Fleet simulator ──────────────────────┴───────┐ │
│  │  12 virtual hosts on :7001-7012, 3 racks x 4                      │ │
│  │  per-host token buckets (8 MB/s up/down), per-rack uplink 16 MB/s │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

### Production-Grade Patterns Planned

| Pattern | Planned location | Why it matters at scale |
|---------|------------------|-------------------------|
| Idempotency keys | planned `backend/src/shared/idempotency.ts` | Retried rollout creation must not start two swarms on one pool |
| Circuit breakers (Opossum) | planned `backend/src/agent/clients.ts` | An agent must keep transferring when tracker or origin is failing |
| Prometheus metrics (prom-client) | planned `backend/src/shared/metrics.ts` | Efficiency against the lower bound is the core product metric |
| Structured logging (Pino) | planned `backend/src/shared/logger.ts` | Per-minute agent summaries; no per-chunk logs |
| Health checks | planned `/health` on control plane and each agent | Disk free, journal writable, tracker reachable |
| Rate limiting | planned announce limiter in the tracker | Protect the tracker from a misconfigured agent loop |
| Token bucket throttling | planned `backend/src/agent/throttle.ts` | Simulates 10 Gbps NICs and oversubscribed racks on loopback |

A sketch of the planned throttle, shared by host links and rack uplinks:

```typescript
// Planned: a transfer waits on every bucket on its path (sender up, receiver down, and,
// if cross-rack, both racks' uplinks), so oversubscription emerges from the model.
await Promise.all(pathBuckets.map(b => b.take(chunk.length)));
```

### Simplified or Substituted

| Production | Local |
|------------|-------|
| S3-compatible origin per region | MinIO |
| 1,000 hosts, 40 racks, 10 Gbps NICs | 12 virtual hosts, 3 racks, 8 MB/s token buckets |
| ToR and spine switches | Per-rack token bucket for cross-rack bytes |
| mTLS with workload identities | Shared dev token; TLS omitted |
| Inference server reload | Agent flips a symlink and reports "active" after a simulated delay |
| Canary health gates on real traffic | Simulated error-rate signal the operator can toggle |
| 500 GB checkpoint | 512 MB of random bytes with a real signed manifest |

### Omitted

- Multi-region distribution and WAN seeding
- Kubernetes, real switch telemetry, real GPU loading
- Delta updates between versions
- Tracker sharding and bitfield deltas
- Two-person approval workflow (single admin role locally)
