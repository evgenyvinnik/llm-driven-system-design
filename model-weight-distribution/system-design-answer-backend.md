# Model Weight Distribution — System Design Answer (Backend Focus)

*45–50 minute system design interview · Backend / infrastructure engineer*

## 🎯 Introduction (2 minutes)

> "We need to get a 500 GB checkpoint onto 1,000 GPU hosts, quickly and correctly, and then switch the fleet to it without breaking serving. Before I draw a single box, I want to compute how fast this could possibly go, because every design choice after that is measured against that number. Then I'll design a topology-aware peer-to-peer swarm that gets close to it, cover integrity with per-chunk hashes, deal with stragglers and dead hosts, describe the resumable downloader every host uses to talk to origin, and finish with how a new model version rolls out safely."

---

## 📋 Requirements Clarification (4 minutes)

### Clarifying Questions

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| How big is the artifact, and does every host need all of it? | Sets F in every formula | 500 GB; each 8-GPU host needs the full checkpoint |
| How many hosts, and how are they laid out? | Sets N and the topology | 1,000 hosts in one region: 40 racks x 25 hosts |
| NIC speed and duplex? | Sets the per-host floor | 10 Gbps, full duplex (10 down and 10 up at once) |
| What is the source? | Sets the source term | One origin with 10 Gbps of upload |
| Are rack uplinks oversubscribed? | Decides whether topology matters | ToR uplink 100 Gbps against 250 Gbps of host ports (2.5:1) |
| Do hosts serve traffic while staging? | Whether we must cap distribution | Sometimes; we need a per-host cap |
| Is the fleet trusted? | Incentives vs authentication | One operator, so no tit-for-tat; but weights are confidential, so peers are authenticated and every byte is verified |

### Functional Requirements

1. Register a model version: chunk it, hash every chunk, sign a manifest
2. Distribute a version to every host in a pool, verified chunk by chunk
3. Resume after a host crash or restart from what was already verified
4. Roll out: stage, canary, activate in waves, pin pools to an exact version, roll back
5. Control a rollout: pause, resume, abort, exclude a host
6. Expose progress, ETA against the lower bound, and stragglers

### Non-Functional Requirements

| Property | Target |
|----------|--------|
| Speed | 99% of healthy hosts verified within 1.25x the lower bound (500 s); the rest within 2x (800 s) |
| Integrity | No host serves or activates a byte that has not matched its hash |
| Origin load | About one copy of the checkpoint per region per rollout |
| Availability | Control plane off the data path; a tracker outage does not stop transfers |
| Isolation | Distribution can be capped so it does not starve inference traffic |

**Out of scope:** how checkpoints are trained or sharded, loading tensors into GPU memory beyond an activation step, and internet-scale untrusted swarms.

---

## 🧮 Start From the Lower Bound (7 minutes)

> "This is the part I'd want to get right before anything else. If I can't say what 'fast' means, I can't tell a good design from a bad one."

**Assumptions:** decimal units, so 500 GB = 4,000 gigabits. 10 Gbps per host, full duplex. Origin upload 10 Gbps. N = 1,000.

**Per-host floor.** A host cannot receive 4,000 Gb faster than its 10 Gbps download link: 4,000 / 10 = **400 seconds**, or 6 minutes 40 seconds. No design beats this.

**Client-server.** If the origin serves the hosts one after another, each copy takes 400 s, so the last host finishes at 1,000 x 400 = 400,000 s, which is about 4.6 days.

**The general bound.** Three things must all be true at once, so the time is at least the largest of them:

1. The source must push at least one full copy: F divided by source upload = 400 s
2. The slowest receiver must download everything: F divided by its download = 400 s
3. All N copies must be uploaded by somebody, and the total upload available is the source plus every host: 1,000 x 4,000 Gb divided by (10 + 10,000) Gbps = 399.6 s

So the lower bound is **400 s**, and it is achievable only if every host uploads at nearly full rate the whole time.

### How Candidate Strategies Compare

| Strategy | Time | What limits it |
|----------|------|----------------|
| Origin serves hosts one at a time | 400,000 s ≈ 4.6 days | Source upload; mean completion ≈ 2.3 days |
| Origin serves all hosts at once | 400,000 s ≈ 4.6 days | Same source, split 1,000 ways (10 Mbps each) |
| Whole-file doubling: every finished host sends to one new host | 10 rounds x 400 s ≈ 67 min | 2^10 = 1,024 holders; store-and-forward wastes time |
| Single pipelined binary tree, chunked | ≈ 800 s | Leaves receive at half rate; half the hosts never upload |
| Pipelined chain, chunked | ≈ 413 s | Speed of the slowest host; one failure stalls everyone after it |
| Binomial pipeline (theory) | ≈ 400.1 s | Floor plus about 10 chunk-steps of pipeline depth |
| ✅ Rack-aware swarm | ≈ 445 s at 90% goodput | Protocol overhead and scheduling imperfection |

### One Machine at a Time vs Many at Once

> "The tempting question is whether the origin should send to one host at full speed or to many hosts in parallel. For the whole file, it doesn't matter for the finish time: both take N times F over the source upload, 4.6 days. Splitting the bandwidth only decides who finishes when. Sequential gets the first host done at 400 s and the average at 2.3 days. All-at-once gets nobody done until day 4.6, which is strictly worse. The real lever is that the receivers have 10 Tbps of upload sitting idle."

The question comes back at chunk granularity, and there the answer is different. If a holder sends a whole chunk to one peer at full rate, the number of copies doubles every chunk-time. If it splits its uplink across k peers, after k chunk-times it has produced only k new copies instead of 2^k. So the origin should send each chunk to a single peer at full speed, and never send the same chunk twice until every chunk has gone out once (BitTorrent calls this super-seeding). In steady state, peers can spread their uplink over a few slots because the total throughput is the same and a single slow receiver then cannot idle the uplink.

### Pipeline Depth

With 16 MB chunks (31,250 of them), a chunk takes 12.8 ms at 10 Gbps. A new chunk reaches all 1,001 nodes in about log2(1,001) ≈ 10 doublings, which is 0.13 s. Pipelining all 31,250 chunks gives (31,250 + 10) x 12.8 ms ≈ 400.1 s. That's "the floor plus pipeline depth", and the depth is negligible once chunks are small.

```
Whole-file doubling (each round 400 s)
  round:    1      2      3     ...     10
  holders:  2  →   4  →   8  →  ...  → 1,024              ≈ 4,000 s

Chunked pipeline (each step 12.8 ms)
  chunk 1        ├─ 10 steps ─┤
  chunk 2          ├─ 10 steps ─┤
  ...
  chunk 31,250                              ├─ 10 steps ─┤ ≈ 400.1 s
```

### Variant: 10 GB From a Constrained Source to Thousands of Hosts

The original version of this prompt: a ~10 GB file, one bandwidth-constrained source, thousands of hosts with limited upload and download. I'll assume N = 2,000, source upload 1 Gbps, host download 1 Gbps, host upload 250 Mbps.

| Term | Value |
|------|-------|
| Source serves hosts in turn | 2,000 x 80 s = 160,000 s ≈ 44 h ≈ 1.85 days |
| F / source upload | 80 Gb / 1 Gbps = 80 s |
| F / host download | 80 s |
| N x F / total upload | 160,000 Gb / (1 + 500) Gbps ≈ 319 s |
| **Lower bound** | **≈ 320 s (5.3 min)** |

> "The binding term flips. Each host could download in 80 seconds, but the fleet only has 501 Gbps of upload against 2,000 Gbps of download demand, so on average each host can receive at about 250 Mbps. This swarm is upload-bound, which changes the priorities: no duplicate transfers, finished hosts must keep seeding, and the source must never send the same chunk twice early on. If uploads were symmetric at 1 Gbps, the bound would fall back to 80 s."

---

## 🏗️ High-Level Architecture (5 minutes)

```
┌──────────────────┐      ┌─────────────────────────────┐      ┌──────────────────┐
│  Model Registry  │─────▶│        Control Plane        │─────▶│ PostgreSQL       │
│  chunk, hash,    │      │  Rollout service · Tracker  │      │ versions, pins,  │
│  sign manifest   │      │   (stateless, 3 replicas)   │      │ rollouts, hosts  │
└────────┬─────────┘      └──────────────┬──────────────┘      ├──────────────────┤
         │                               │ announce / peers    │ Redis: live      │
         ▼                               │ control epoch       │ swarm state      │
┌──────────────────┐                     │                     └──────────────────┘
│  Origin storage  │     ┌───────────────┴─────────────────────────────┐
│  shards+manifest │     │                                             │
└────────┬─────────┘ ┌───▼────── Rack 1 ──────────────┐   ┌── Rack 40 ─▼────────┐
         │ ~1 copy   │ ┌───────┐  ┌───────┐  ┌──────┐ │   │ ┌───────┐  ┌──────┐ │
         └──────────▶│ │ Agent │◀▶│ Agent │◀▶│ x25  │ │◀─▶│ │ Agent │◀▶│ x25  │ │
                     │ └───────┘  └───────┘  └──────┘ │   │ └───────┘  └──────┘ │
                     └────────────────────────────────┘   └─────────────────────┘
              mostly rack-local traffic; about one copy per rack crosses the spine
```

| Component | Responsibility |
|-----------|----------------|
| Model registry | Splits files into 16 MB chunks, computes SHA-256 per chunk, writes and signs the manifest. The version id is the SHA-256 of the manifest |
| Origin storage | S3-compatible object store; serves range reads; sized for about one copy per rollout per region |
| Tracker | Membership, topology-aware peer lists, progress aggregation, control epoch. Not on the data path |
| Rollout service | Rollout state machine, lower-bound computation, straggler detection, activation waves, version pins |
| Host agent | Downloads, verifies, journals, and serves chunks; activates versions |

**One host's path, step by step:**

1. The agent announces "started" to the tracker and gets up to 20 peers (about 15 in its rack, 5 elsewhere) plus the manifest location.
2. It fetches the 1 MB manifest and checks its signature against the pinned registry key.
3. It preallocates the files, then loops: pick a chunk, request it from the best peer that has it, verify the hash, write it at its offset, sync, journal it, and tell neighbors it has it.
4. Every 5 s it announces its verified count and rates; every few announces it includes its 3.9 KB bitfield.
5. When all chunks are verified it reports "staged" and keeps seeding.

---

## 💾 Data Model (3 minutes)

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| model_versions | digest (PK, SHA-256 of manifest), model_id, version_label, total_bytes, chunk_size, chunk_count, manifest_uri, signature | (model_id, created_at) | Immutable once sealed; tags resolve to a digest |
| model_files | (digest, file_index) PK, path, size_bytes, first_chunk, chunk_count | unique (digest, path) | Chunks never span files |
| hosts | id, rack_id, pool, nic_gbps, disk_free_bytes, status, last_heartbeat_at | (pool, status), (rack_id) | Inventory; the tracker's topology source |
| pool_pins | pool PK, active_digest, previous_digest, lock_version | — | Version pinning; optimistic concurrency |
| rollouts | id, digest, pool, state, control_epoch, bandwidth_cap, min_success_ratio, lower_bound_seconds, idempotency_key | unique idempotency_key; partial unique on pool while in flight | At most one in-flight rollout per pool |
| rollout_hosts | (rollout_id, host_id) PK, wave_no, state, chunks_verified, rate, is_straggler, last_seq | (rollout_id, state); partial on stragglers | Flushed from Redis every 10 s |
| host_versions | (host_id, digest) PK, state (staging, staged, active, previous) | partial unique: one active per host | What is on each disk |
| control_actions | rollout_id, action, resulting_epoch, idempotency_key | unique (rollout_id, idempotency_key) | Audit plus retry safety |

**Redis holds the hot state:** per-rollout membership, per-rack host sets, each host's verified-chunk bitfield (31,250 bits ≈ 3.9 KB), per-chunk replica counts (about 62.5 KB as 16-bit counters), per-host progress, and the control state with its epoch. The chunk hashes live in the manifest object (31,250 x 32 bytes ≈ 1 MB), not in Postgres rows.

> "The important sizing fact: a rollout produces 31.25 million chunk completions, about 78,000 a second across the fleet. None of that goes to the tracker or the database. Chunk-level state stays between neighbors; the tracker sees per-host summaries at 200 announces a second."

---

## 🔌 API Design (2 minutes)

```
Control plane
POST /api/v1/models/:name/versions        → register version (manifest + signature)
POST /api/v1/rollouts                     → create rollout (Idempotency-Key required)
GET  /api/v1/rollouts/:id                 → state, waves, lower bound, ETA
GET  /api/v1/rollouts/:id/hosts?state=    → per-host progress, paged
POST /api/v1/rollouts/:id/pause|resume    → bump control epoch
POST /api/v1/rollouts/:id/abort           → stop and release staged bytes
POST /api/v1/rollouts/:id/promote         → activate the next wave
PUT  /api/v1/pools/:pool/pin              → pin a pool to a digest (If-Match)

Tracker
POST /api/v1/tracker/announce             → progress in; peers + control epoch out
GET  /api/v1/tracker/:rollout/availability → per-chunk replica counts

Peer protocol (agent to agent, mTLS)
GET  /v1/chunks/:digest/:index            → chunk bytes; 404 not held; 429 slots busy
GET  /v1/bitfield/:digest                 → current verified bitfield
WS   /v1/peers/:digest/have               → HAVE notifications to neighbors

Origin
GET  /:bucket/:digest/:file  with Range and If-Match → one chunk range
```

---

## 🔧 Deep Dive 1: Swarm vs Pipelined Chain or Tree (8 minutes)

### Choosing the Chunk Size

| Chunk size | Chunks | Step at 10 Gbps | Effect |
|------------|--------|-----------------|--------|
| 1 MB | 500,000 | 0.8 ms | Manifest 16 MB, bitfields 62.5 KB, per-request overhead dominates |
| ✅ 16 MB | 31,250 | 12.8 ms | Manifest 1 MB, bitfield 3.9 KB, pipeline depth 0.13 s, cheap retries |
| 256 MB | 1,953 | 205 ms | Coarse rarest-first, 2 s startup, a corrupt chunk wastes 256 MB |

> "Sixteen megabytes keeps the pipeline depth negligible and the metadata small, and a failed transfer only costs 13 milliseconds of link time."

### The Decision

I chose a **BitTorrent-style swarm** with rarest-first chunk selection, coordinated by a tracker and made rack-aware, over a pipelined chain or tree.

### Why the Swarm Works Here

The bound is only reachable if all 1,000 uplinks stay busy for the whole transfer. In a swarm, any host that has a chunk can serve it, so work flows to whoever has spare upload. A slow host is simply chosen less often; a dead host stops appearing in peer lists. Rarest-first spreads copies of every chunk early, so the swarm keeps every uplink fed and never ends up with one chunk that only the origin has. At about 90% goodput (TCP and protocol overhead, occasional idle slots, endgame duplicates), I expect ≈ 445 s, inside the 500 s target.

### How the Chain Breaks

A pipelined chain is beautiful on paper: about 413 s, because each host forwards each chunk to the next host as soon as it arrives. But its throughput is the minimum over all 1,000 links. If each host has even a 0.1% chance of being degraded during those 7 minutes (a flaky NIC, a noisy neighbor, a disk with high write latency), the chance that at least one host in the chain is degraded is 1 − 0.999^1000 ≈ 63%. So most rollouts would run at the speed of their worst host. A crash is worse: every host after it stops receiving until we splice the chain, and the hosts after the splice point then need the chunks they missed.

### How the Tree Breaks

A single binary tree halves the uplink each child gets, so leaves receive at 5 Gbps and finish at ≈ 800 s. Worse, about half the hosts are leaves and never upload anything, which throws away half the capacity the bound depends on. Striping the file across several trees so every host is an interior node in one of them (the SplitStream idea) restores the bound, but now every slow host is a bottleneck in one tree, and the trees need constant repair. At that point we've built a swarm with extra rigidity.

### What We Give Up

Determinism. In a chain, I can predict each host's finish time exactly; in a swarm, per-host ETA is statistical. We also accept some duplicate bytes (at most 1% from the endgame), more control messages (HAVE notifications between neighbors), and harder debugging, which pushes us to invest in per-chunk metrics.

| Approach | Time | Under a slow host | Under a failure |
|----------|------|-------------------|-----------------|
| ✅ Rack-aware swarm | ≈ 445 s | Routed around | Peers re-request elsewhere |
| ❌ Pipelined chain | ≈ 413 s | Everyone slows to it | Everyone after it stalls until spliced |
| ❌ Single tree | ≈ 800 s | Its subtree slows | Its subtree stalls |
| ❌ Striped multi-tree | ≈ 400 s + depth | One stripe slows | Repair one tree per failure |

---

## 🔧 Deep Dive 2: Topology-Aware Peers, and Tracker vs Gossip (7 minutes)

### Why Topology Matters

> "The bound assumed a flat network. Ours has 40 racks, and each rack's 25 hosts share a 100 Gbps uplink against 250 Gbps of host ports."

With random peers, 975 of a host's 999 possible senders are in other racks, so 97.6% of bytes cross a top-of-rack switch. Each rack then needs 25 x 4,000 Gb x 0.976 = 97,600 Gb through a 100 Gbps uplink, which takes 976 s. That's 2.4x the floor, and the hosts' NICs sit mostly idle while the ToR is saturated.

### The Decision: Rack-Aware Selection With Ingress Stripes

1. The tracker returns mostly same-rack peers (up to 15) and a few elsewhere (up to 5), preferring hosts with many chunks and free upload slots.
2. Each host owns a 1/25 stripe of chunk indices (index modulo rack size equals its position in the rack). For a chunk in its stripe that nobody in the rack has, it fetches cross-rack, or from the origin if no other rack has it yet.
3. Every other chunk it fetches from a rack-local neighbor that has it, rarest-first.
4. If a stripe owner is slow or dead and a chunk has been unavailable in the rack for 3 s, any host may fetch it cross-rack.

Each chunk enters each rack about once, call it 1.5 copies with retries. That's 6,000 Gb, or 60 s of uplink time spread over a 400 s rollout: 15% utilization. The cross-rack work is also spread evenly over all 25 hosts instead of loading a single "rack leader".

**What we give up:** we depend on accurate inventory (which rack each host is in), and a stripe owner is briefly the only path for its chunks into the rack, which is why the 3 s starvation fallback exists.

### Upload Slots

Each agent serves from 4 upload slots and keeps about 16 requests in flight across up to 8 peers. Four slots means a single slow receiver can't idle the uplink, and several download sources mean a single slow sender can't stall a host. The origin is different: it's the scarce resource, so it sends each chunk once to one peer at full rate.

### Tracker vs Gossip

**Decision:** a central tracker, stateless over Redis and run as three replicas, owns membership, peer lists, progress, and control. Chunk availability travels only between neighbors as HAVE messages.

**Why the tracker works:** this is one operator's fleet with an inventory database. At 200 announces a second (1,000 hosts every 5 s) plus 0.8 MB/s of bitfields, the load is trivial. It gives us one place to compute global progress and stragglers, one authoritative rollout state for pause and abort, and topology-aware peer selection that uses inventory a gossiping host doesn't have.

**How gossip breaks here:** gossip spreads a pause in O(log N) rounds with no acknowledgment, so "is the fleet paused?" has no definite answer, and an abort that misses three hosts leaves them downloading a version we rejected. Global progress becomes an estimate assembled from samples, which is the wrong basis for a "99% staged" completion rule. Gossip and DHTs fit open internet swarms with no operator; here they add convergence delay and debugging pain while solving a problem we don't have.

**What we give up:** a dependency. We keep it off the data path: if the tracker is down, agents keep their current peers and continue exchanging HAVE messages and chunks. Only new joins, peer refreshes, and control changes wait.

| Approach | Control semantics | Global view | Failure impact |
|----------|-------------------|-------------|----------------|
| ✅ Tracker + neighbor HAVE | Authoritative, acknowledged epochs | Exact | Joins and control pause; transfers continue |
| ❌ Pure gossip | Eventual, unacknowledged | Sampled | None central, but slow and hard to debug |
| ❌ Tracker for every chunk event | Exact | Exact | 78,000 updates/s; tracker on the data path |

---

## 🔧 Deep Dive 3: Integrity, Stragglers, Failures, and the Resumable Downloader (8 minutes)

### Per-Chunk SHA-256 Manifests

**Decision:** a signed manifest listing every file and the SHA-256 of every 16 MB chunk. The version id is the manifest's own hash.

**Why it works:** a host verifies each chunk before writing it to its journal, before advertising it, and before serving it. A corrupt byte, from a bad NIC, a disk error, or a malicious peer, travels at most one hop, and we know which peer sent it. Three bad chunks from one peer ban it from the swarm and quarantine the host. The signature means only the registry can define what "correct" is; every peer is untrusted for data.

**How a whole-file hash breaks:** you learn about corruption only after 500 GB have arrived, by which time the bad chunk has been re-served to dozens of hosts. You can't tell which chunk is bad or who sent it, so every affected host re-downloads everything.

**What we give up:** a 1 MB manifest fetch per host before the first chunk, about 0.6 of a core for hashing at 1.25 GB/s, and a signing key to protect. I considered a Merkle tree, which allows verifying pieces smaller than a chunk, but a flat 1 MB list is small enough that the tree buys nothing.

### Stragglers

A **straggler** is a host whose 30-second download rate is below half the swarm median. When the tracker flags one:

1. Give it more and faster peers, and allow it to fetch directly from origin.
2. Stop choosing it as a source for other hosts, so it doesn't drag them down.
3. If it is still not staged at 2x the floor (800 s), exclude it from this rollout and file a host-health ticket.

The completion rule is 99% of hosts staged, not 100%, so one sick host can't hold a fleet hostage. **Endgame mode** handles the last chunks: once a host is missing at most 1% of its chunks, it requests each from two peers and cancels the slower request. That costs at most 1% duplicate bytes and avoids the classic "99% done for five minutes" tail.

### Host and Infrastructure Failures

| Failure | Detection | Response |
|---------|-----------|----------|
| Peer slow mid-chunk | Fetch exceeds 3x its expected time | Cancel and re-request from another peer |
| Host crash | 3 missed announces (15 s) | Dropped from peer lists; resumes from its journal on restart |
| Whole rack down | 25 hosts miss announces together | Counted as failures; continue if 99% is still reachable |
| Tracker down | Agent's circuit breaker opens | Keep current peers; retry with backoff and jitter |
| Origin down | Range GET failures | Fine if every chunk has a replica in the swarm (rarest-first makes that early); else another region's origin |
| Disk full | Agent health check | Fail the host for this rollout |

### The Parallel, Resumable Range Downloader

Every agent uses the same downloader for origin fetches, and it ships as a CLI for engineers pulling a model to a dev box. The steps:

1. **Resolve and pin.** Resolve the tag to a digest, fetch and verify the manifest, and record each file's ETag on first contact. Every later range request carries If-Match with that ETag; a 412 means the object changed underneath us, so we stop rather than mix bytes from two versions.
2. **Preallocate** each file at its final size under a temporary name.
3. **Fetch in parallel.** Request 16 MB ranges over 16 connections. Object stores typically cap a connection near 100 MB/s, so one stream would take 500,000 MB / 100 MB/s = 5,000 s (83 min); about 13 streams fill a 1.25 GB/s NIC, and 16 leaves headroom. Concurrency adapts: add connections while throughput rises, remove them on throttling responses.
4. **Verify, write, journal.** Hash each range, write it at its offset, batch an fdatasync, then append the chunk index to a journal file and sync it.
5. **Retry** failed ranges with exponential backoff and jitter, with a per-range timeout and a cap on attempts.
6. **Finish** by checking that every chunk is journaled, then atomically rename the files into place.

**Resume** reads the journal and fetches only what is missing. The ordering matters: data is synced before its index is journaled, so a journaled chunk is always on disk and correct. The alternative, rehashing on restart, costs 500 GB / 2 GB/s = 250 s, more than half the transfer itself.

| Approach | Resume cost | Risk |
|----------|-------------|------|
| ✅ Sync data, then journal index | Proportional to missing chunks | Journal must be written after data |
| ❌ Rehash everything on restart | 250 s for 500 GB | None, but slow |
| ❌ Trust file size or sparse regions | Instant | Torn writes look complete |

---

## 🚀 Rolling Out a New Model Version (3 minutes)

> "Distributing bytes and serving them are separate risks, so I separate them."

1. **Stage everywhere at once.** All 1,000 hosts form one swarm. Staging takes about 7 minutes and doesn't change what is served. Staging only a 25-host canary first would forfeit the fleet's upload capacity, and the canary hosts would wait on the origin.
2. **Activate in waves.** Canary rack (25 hosts, 2.5%), soak for 30 minutes against error rate, latency, and output quality checks; then 25%; then 100%. Within a wave, at most 10% of the pool reloads at once so serving capacity stays above its floor. A reload from local NVMe at about 5 GB/s takes about 100 s.
3. **Pin by digest.** A pool's pin names an exact manifest digest, never a tag like "latest". Every replica, and every host within a multi-host replica, serves byte-identical weights. A tensor-parallel group with mixed versions would produce garbage, so a replica group activates together.
4. **Instant rollback.** The previous version stays on disk (two versions = 1 TB, within the 1.5 TB cache), so rollback is a symlink swap plus a reload, with no download.
5. **Abort** before activation just evicts the staged bytes.

Control changes bump a **control epoch**. Agents apply a control state only if its epoch is newer and echo the epoch they applied, so we know exactly how many hosts have actually paused. Rollout creation and control actions require idempotency keys, and only one rollout can be in flight per pool (a partial unique index enforces that).

---

## 📈 Scalability and What Breaks First (3 minutes)

- **10,000 hosts.** The swarm's capacity grows with N, so the bound stays ≈ 400 s. Control traffic grows to 2,000 announces/s and 7.8 MB/s of bitfields, so bitfields become deltas and the tracker shards by rollout and pod.
- **Multiple regions.** Treat a region like a big rack: one copy crosses the WAN per region (500 GB over 100 Gbps is 40 s), then each region swarms locally.
- **Faster NICs.** At 100 Gbps the network floor is 40 s, but writing 500 GB to one NVMe at 5 GB/s takes 100 s, and hashing 12.5 GB/s needs about 6 cores. The bottleneck moves to disk and CPU.
- **Serving while staging.** Capping distribution at 8 Gbps protects inference traffic and moves the floor to 4,000 / 8 = 500 s; the console shows the capped bound.

**What breaks first:**

1. **ToR uplinks**, the moment peer selection ignores topology (976 s instead of ≈ 445 s)
2. **Tracker bitfield ingest** around 10,000 hosts per rollout without deltas
3. **Origin**, when autoscaled hosts join outside a rollout and each pulls 500 GB from origin. Late joiners must join the standing swarm, where every host is already a seeder

---

## ❓ Follow-up Questions

**"Spread a 10 GB file from one constrained source to thousands of hosts."** The bound is the largest of the source term, the download term, and N times F over total upload. With my numbers it's ≈ 320 s and upload-bound, against 1.85 days for client-server. Upload is the scarce resource, so every uploaded byte must be new to its receiver, and finished hosts keep seeding.

**"Distribute 500 GB to 1,000 GPU workers, starting from the lower bound."** 400 s per host floor, 4.6 days client-server, ≈ 445 s for a rack-aware swarm at 90% goodput.

**"Design a parallel, resumable model downloader."** Deep dive 3: pinned ETag, parallel 16 MB ranges over about 16 connections, verify-write-sync-journal, resume from the journal.

**"Model artifact distribution to an inference fleet."** Stage everywhere through the swarm, activate in waves, pin by digest, keep the previous version for instant rollback.

**"What if a host only needs its tensor-parallel shard?"** Each shard becomes its own swarm with F = 62.5 GB (1/8 of the model) and a 50 s floor.

**"What if the origin dies at minute 3?"** By then rarest-first has put copies of every chunk the origin has sent into the swarm. The source term means the origin needs 400 s to send one full copy, so at minute 3 roughly 45% of chunks have left it; hosts finish those and wait on another region's origin for the rest.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| ✅ Topology | Swarm | ❌ Pipelined chain or tree | Near the floor; slow hosts are routed around |
| ✅ Peer selection | Rack-aware + ingress stripes | ❌ Random peers | 976 s → ≈ 445 s with 2.5:1 uplinks |
| ✅ Coordination | Tracker + neighbor HAVE | ❌ Gossip | Authoritative control and exact progress |
| ✅ Chunk size | 16 MB | ❌ 1 MB or 256 MB | 0.13 s pipeline depth, 1 MB manifest |
| ✅ Integrity | Per-chunk SHA-256, signed | ❌ Whole-file hash | Corruption caught one hop away; sender named |
| ✅ Origin seeding | Each chunk once first | ❌ Serve on demand | Origin egress ≈ one copy |
| ✅ Resume | Journal after sync | ❌ Rehash on restart | Rehash costs 250 s |
| ✅ Completion rule | 99% staged | ❌ 100% staged | One sick host can't block the fleet |
| ✅ Rollout | Stage all, activate in waves | ❌ Stage in waves | Staging is cheap; activation is the risk |
| ✅ Versioning | Pin by digest | ❌ Mutable tags | Identical replicas, instant rollback |

---

## 📝 Summary

> "I started from the lower bound: 400 seconds for 500 GB over 10 Gbps, against 4.6 days if the origin serves everyone. The gap closes only if every host uploads, so the data plane is a swarm of 16 MB chunks with rarest-first selection, and the origin sends each chunk once. The network isn't flat, so peers are mostly rack-local and each host owns a stripe of chunks to pull into its rack; that's the difference between 976 seconds and about 445. A tracker coordinates membership, progress, and control but stays off the data path. Every chunk is checked against a signed SHA-256 manifest before it's written, advertised, or served. Stragglers get help and then get excluded, and completion means 99%, not 100%. The downloader that talks to origin is parallel, pinned to one object version, and resumes from a journal instead of rehashing. Finally, rollout separates staging from activation: stage everywhere in one swarm, activate in waves, pin by digest, and keep the previous version on disk so rollback takes seconds."
