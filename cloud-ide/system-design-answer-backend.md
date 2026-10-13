# Cloud IDE — System Design Answer (Backend Focus)

*45-minute system design interview format — Backend Engineer Position*

> Reported prompts (OpenAI, candidate-reported): "Cloud IDE that edits and runs code in browser-accessible workspaces", "Multi-tenant cloud IDE: isolation, workspaces, run/build, failure modes", "Cloud development environment platform like an online IDE", "Devbox service for on-demand remote development environments".

## 🎯 Introduction (2 minutes)

"Thanks. I'll design a Codespaces-style platform: a developer clicks 'open', and a few seconds later has an editor, a terminal, and language intelligence backed by a real Linux machine that keeps their disk between sessions. As the backend engineer I'll spend most of the time on the control plane and the workspace lifecycle, on tenant isolation, and on keeping disks durable when the compute under them is disposable. I'll also cover how a keystroke gets routed to the right host, warm pools for cold start, failure modes, and cost control, because at this scale the bill is a design constraint, not an afterthought."

"The core tension: a workspace is long-lived, stateful, runs untrusted code as root, and costs money every minute it runs. I want compute to be cattle and the disk to be the pet."

---

## 📋 Requirements Clarification (5 minutes)

### Clarifying Questions

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| Do users need root and Docker inside the workspace? | Decides containers versus VMs | Yes. `sudo apt install` and `docker compose up` must work |
| Is running-process state kept across suspend, or only disk? | Memory snapshots cost 8 GB per workspace | Disk only. Processes restart on resume |
| How much work can a host failure lose? | Local disk versus network block storage | Up to 60 s of disk writes |
| Multi-region? | Placement, data residency, failover | Yes. A workspace is pinned to the region nearest its owner |
| Org controls? | Policy plumbing | Idle timeout, machine classes, egress allowlist, budgets |
| Real-time co-editing? | Adds a CRDT/OT layer | Out of scope; one owner per workspace |

### Functional Requirements

1. Create a workspace from a template (image plus config) or from a prebuild snapshot of a repo at a commit
2. Start, stop, resume, and delete; resume restores the disk exactly
3. Suspend automatically after 30 minutes without user activity (org-configurable)
4. Terminal, file, and language-server traffic from the browser to the workspace
5. Run and build anything, with selectable machine classes
6. Forward listening ports to authenticated preview URLs
7. Admin: drain hosts, inspect warm pools, view lifecycle events

### Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Resume time-to-interactive | p95 < 5 s |
| Create from prebuild | p95 < 15 s |
| Keystroke echo | p95 < 100 ms within a region's footprint |
| Running workspaces survive control-plane outage | Yes; data plane is independent |
| Host-loss data loss | <= 60 s of disk writes |
| Isolation | No cross-tenant read, write, or network path |

**Out of scope:** co-editing, GPU workspaces, the CI system that triggers prebuilds, invoicing.

---

## 📐 Back-of-Envelope (4 minutes)

"Let me size it so the later choices have numbers behind them."

| Input | Value |
|-------|-------|
| Registered / daily active developers | 10M / 1M |
| Sessions per DAU per day | 3 |
| Active hours + idle tails | 4 h + 3 x 30 min = 5.5 h running per DAU per day |
| Default machine | 4 vCPU, 8 GB RAM, 32 GB disk |
| Host | Bare metal: 96 vCPU, 768 GB RAM, 7.68 TB NVMe, 25 Gbps NIC, $3/hour |

**Fleet.** Average running is 1M x 5.5 / 24 = ~229K; peak is ~300K. A host has (768 - 64 reserved) / 8 = 88 memory slots; at 85% fill that's 75 workspaces per host, so peak needs 300K / 75 = **4,000 hosts**. CPU is overcommitted 3.1x (300 nominal vCPU on 96), which is fine because the average workspace uses 0.4 vCPU. Memory is not overcommitted: an OOM kill takes out someone's session.

**Starts.** 3M starts per day is ~35/s on average and ~175/s at the morning peak.

**Warm pool.** By Little's law, pool size = claim rate x replenish window = 175/s x 60 s = **10,500 pre-booted VMs**, which is 140 hosts or 3.5% of the fleet, about $10K/day.

**Storage.** 4M retained stopped workspaces x 5 GB compressed delta = **20 PB**, ~$400K/month. Snapshotting every 60 s at a 50 KB/s average dirty rate is 15 GB/s fleet-wide at peak and 5,000 snapshot commits per second.

**Traffic.** ~400K concurrent WebSockets at peak (1.3 tabs per running workspace), 800K messages/s, 6.4 Gbps. That's 24 gateway nodes at ~17K connections each, versus a 50K-per-node ceiling.

**Cost.** $3 / 75 = **$0.04 per workspace-hour**, so compute is 1M x 5.5 h x $0.04 = **$220K/day**. The 30-minute idle tails are 1.5 of those 5.5 hours: **27% of compute**. Without auto-stop it would be $960K/day.

> "Two numbers drive the design. The image pull is 20 of the 28.5 seconds of a cold start, which is why warm pools exist. Idle tails are 27% of the compute bill, which is why the idle signal has to be precise."

---

## 🏗️ High-Level Architecture (6 minutes)

```
          ┌───────────────────────────────────────────────┐
          │ Browser: editor · terminal · file tree        │
          └──────────┬─────────────────────────┬──────────┘
          REST + SSE │                         │ one multiplexed WSS per tab
                     ▼                         ▼
       ┌───────────────────────┐   ┌───────────────────────────┐
       │ API edge (auth, rate  │   │ Workspace gateway         │
       │ limits)               │   │ token check · route by id │
       └──────────┬────────────┘   │ preview proxy             │
                  ▼                └─────────────┬─────────────┘
 ┌─────────────────────────────────────────┐     │ mTLS tunnel
 │ CONTROL PLANE (per cell, ~1,000 hosts)  │     │ per host
 │ Workspace API · Scheduler/Reconciler    │     │
 │ Warm-pool manager · Idle reaper         │     │
 │ Prebuild service · Retention + chunk GC │     │
 │ PostgreSQL (cell DB) · Valkey           │     │
 └──────────────────┬──────────────────────┘     │
                    │ assignments (id, generation, spec)
                    ▼                            ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ WORKSPACE HOST (bare metal, ~75 microVMs)                   │
 │ Host agent: lease · VMM control · snapshotter · egress rules│
 │      │ vsock                                                │
 │      ▼                                                      │
 │ Firecracker microVM: workspace agent (PTY, fs, LSP, ports)  │
 │ user processes · dockerd · CoW volume on local NVMe         │
 └──────────────────────┬──────────────────────────────────────┘
                        │ dirty chunks every 60 s · lazy restore
                        ▼
 ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────────┐
 │ Object storage   │ │ Image registry   │ │ Egress NAT with      │
 │ chunks+manifests │ │ templates        │ │ per-VM policy        │
 └──────────────────┘ └──────────────────┘ └──────────────────────┘
```

| Component | Responsibility |
|-----------|----------------|
| Workspace API | Validates, enforces quotas, writes desired state, streams progress over SSE |
| Scheduler / reconciler | Drives observed state toward desired state; placement; generation bumps |
| Warm-pool manager | Keeps pre-booted VMs per (cell, image digest, machine class) |
| Host agent | Lease with control plane, converges VMs to assignments, snapshotter, egress rules, tunnel endpoint |
| Workspace agent | In-guest daemon over vsock: PTYs with replay buffers, file ops, file watching, LSP processes, port detection, activity |
| Gateway | Stateless WebSocket terminator; routes by workspace ID to the owning host |

> "I split the system into a control plane and a data plane on purpose. The control plane decides where and whether a workspace runs. It's never on the keystroke path. If its database is down for ten minutes, nobody can start a workspace, but nobody who's already typing notices."

---

## 💾 Data Model (3 minutes)

PostgreSQL per cell is the source of truth; Valkey holds hot, reconstructible state.

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| workspaces | id, owner_id, template_id, machine_class, desired_state, state, generation, host_id, volume_id, last_activity_at | (cell, state_changed_at) partial where desired differs from state; (cell, last_activity_at) where running; (host_id) where active | `generation` increments on every start; the partial index is the reconciler's work queue |
| hosts | id, cell, zone, status, total_slots, used_slots, cached_digests, lease_expires_at | (cell, used_slots) where active; (lease_expires_at) | Lease renewed every 5 s, 20 s TTL |
| volumes | id, size_gb, base_snapshot_id, latest_snapshot_id, cached_on_host_id, hot_set_key | primary key | `cached_on_host_id` drives resume affinity |
| snapshots | id, volume_id, generation, seq, kind, manifest_key, new_bytes | unique (volume_id, generation, seq) | Manifest lists content-addressed chunk hashes |
| warm_vms | id, host_id, image_digest, machine_class, state, claimed_by | (image_digest, machine_class, ready_at) where ready | Claimed with skip-locked row selection |
| prebuilds | template_id, repo_url, branch, commit_sha, snapshot_id, status | unique on the 4-tuple; lookup by repo and branch where ready | Keyed by pinned template version |
| workspace_events | workspace_id, generation, from_state, to_state, reason, actor | (workspace_id, created_at) | Range-partitioned by month; audit and debugging |
| usage_records | workspace_id, generation, machine_class, started_at, stopped_at | unique (workspace_id, generation) | One billing row per run |
| idempotency_keys | user_id, key, request_hash, response | primary key (user_id, key) | 24 h expiry |

| Valkey key | Purpose |
|------------|---------|
| route:{workspaceId} | host, address, generation for the gateway |
| activity:{workspaceId} | Live last-activity timestamp; flushed to PostgreSQL every 5 min (1,000 writes/s instead of 5,000) |
| changes:{cell} | Pub/sub nudge to gateways and host agents |

---

## 🔌 API Design (2 minutes)

```
POST   /api/v1/workspaces                  → create from template/prebuild; Idempotency-Key required
GET    /api/v1/workspaces/:id              → state, generation, machine class, ports
POST   /api/v1/workspaces/:id/start        → desired_state = running; 202
POST   /api/v1/workspaces/:id/stop         → desired_state = stopped; 202
DELETE /api/v1/workspaces/:id              → desired_state = deleted; 202
GET    /api/v1/workspaces/:id/events       → SSE lifecycle progress
POST   /api/v1/workspaces/:id/connect      → 5-min signed data-plane token + gateway URL
PUT    /api/v1/workspaces/:id/ports/:port  → preview visibility: private | org | public
POST   /api/v1/prebuilds                   → build a prebuild for (template, repo, branch)
POST   /api/v1/admin/hosts/:id/drain       → stop placing; migrate at next suspend
WSS    /ws/workspaces/:id                  → multiplexed terminal, LSP, fs, ports, control channels
POST   /internal/v1/hosts/:id/lease        → host agent lease renewal (mTLS)
GET    /internal/v1/hosts/:id/assignments  → long-poll desired VMs for this host
```

> "Start and stop don't do anything synchronously. They write intent and return 202. That's what makes them idempotent and lets a retry storm be harmless."

---

## 🔧 Deep Dive 1: Lifecycle as Reconciliation, With Generation Fencing (8 minutes)

```
 pending ──▶ starting ──▶ running ──▶ stopping ──▶ stopped ──▶ archived (7 d)
                ▲            │                       │  │          │
                │            │ host lease expired    │  └─ delete ─┴──▶ deleting ──▶ deleted
                │            ▼                       │
                └──────── recovering ◀───────────────┘ (start)
         every edge into "starting" increments generation
```

**The decision.** The API only writes `desired_state`. A per-cell reconciler (one leader) repeatedly selects workspaces whose desired state differs from observed state, using a partial index so it only scans the few thousand in transition, and advances each one step. Host agents long-poll their assignments, each a tuple of workspace, generation, and spec, and converge local VMs to them. Every transition into `starting` bumps `generation` in the same row update that assigns the host.

**Why this works for workspaces.** Lifecycle operations are slow (seconds), fail partway, and get retried by impatient users and flaky networks. Desired state is idempotent by construction: "workspace X, generation 7, should run on host H" can be delivered ten times and the result is the same. If the reconciler crashes mid-step, the next leader reads the same rows and continues. A host agent that restarts re-reads its assignments and reconciles whatever it finds: VMs for current generations stay, VMs for stale generations are destroyed without snapshotting.

**How the alternative breaks.** The obvious design is a command queue: the API publishes "start VM" to RabbitMQ and a host consumes it. Now consider a host that consumes the message, boots the VM, and crashes before acking. The message is redelivered to another host, and the user has two VMs. Or the stop message is processed before a delayed start message, and the workspace ends up running after the user stopped it. Every handler has to answer "did a previous attempt half-execute?", and the queue becomes a second source of truth that disagrees with the database. Edge-triggered commands encode *transitions*; level-triggered reconciliation encodes *the goal*, and goals survive retries, duplicates, and reordering.

**The partition problem, and why leases alone don't solve it.** A host loses its network link to the control plane but keeps running its VMs. After 30 s without a lease renewal, the control plane marks its workspaces `recovering` and restarts them elsewhere from the last snapshot. Now two copies exist. If the old one later uploads a snapshot, it overwrites newer state with older state. A lease alone isn't enough because clocks and pauses (a long GC, a frozen VM) can make a holder believe its lease is still valid. So every durable side effect carries the generation:

1. Snapshot commits are a conditional update on the workspace's current generation; a stale host updates zero rows and stops uploading
2. Gateway routes carry the generation, and the host agent refuses streams for a generation it isn't running
3. Client tokens carry the generation, so a client that reconnects goes through `/connect` and lands on the new copy
4. The host agent self-fences at 20 s (pauses its VMs, refuses traffic), before the control plane acts at 30 s

> "Two copies of a workspace can briefly exist. Two copies can never both write durable state. That's the invariant I'd defend."

**Warm pools inside the lifecycle.**

| Step | Cold | Image cached | Warm VM |
|------|------|--------------|---------|
| Placement and claim | 0.2 s | 0.2 s | 0.1 s |
| Image pull and unpack (4 GB at 200 MB/s) | 20 s | 0 | 0 |
| Guest boot and init (systemd, dockerd, agent) | 6 s | 6 s | 0 |
| Volume attach, lazy restore of 500 MB hot set at 1 GB/s | 0.5 s | 0.5 s | 0.5 s |
| Identity, secrets, IDE services | 1.5 s | 1.5 s | 1.5 s |
| Client connect | 0.3 s | 0.3 s | 0.3 s |
| **Total** | **28.5 s** | **8.5 s** | **2.4 s** |

A warm VM has booted a template image and is waiting for a volume and an identity. Pools are keyed by pinned image digest, never a tag, so a template update can't hand a user the wrong image. Claiming is one row update with skip-locked selection, preferring the host that still caches this user's volume. The pool manager sizes each pool from the last 15 minutes of claims times the 60-second replenish window, with a floor for popular images and zero for the long tail; long-tail images get the 8.5 s path by preferring hosts that cache their digest.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Desired state + reconciler + generation | Idempotent, self-healing, safe under partitions | Extra latency per step (~100 ms of loop and poll); generation must be threaded everywhere |
| ❌ Command queue to hosts | Familiar, push-based | Duplicate and reordered commands; half-executed steps; second source of truth |
| ❌ Leases without fencing tokens | Simple | A paused or partitioned holder still writes stale snapshots |

**What we give up.** Convergence is asynchronous, so the API can't answer "is it running?" synchronously; the client follows the SSE stream. We pay ~$10K/day for the warm pool. And every component, from the snapshotter to the gateway, has to know about generations, which is invasive.

---

## 🔧 Deep Dive 2: Tenant Isolation — Containers vs microVMs, and Egress (7 minutes)

**Threat model.** Every tenant runs arbitrary code as root, including code from dependencies they never read. Assume a hostile tenant with a kernel exploit. Assets to protect: other tenants' disks and processes, the host, the control plane, cloud credentials, and the internet (from being attacked by us).

| Option | Boundary | Root + Docker inside | Overhead | Verdict |
|--------|----------|----------------------|----------|---------|
| Plain containers (runc) | Shared kernel; namespaces + seccomp | Needs privileged mode or rootless nesting | Lowest | ❌ |
| gVisor | User-space kernel intercepts syscalls | Partial; compatibility gaps | High on I/O-heavy builds | ❌ |
| Kata / Firecracker microVM | Hardware virtualization; own guest kernel | Yes, safely | ~6 s boot; guest kernel memory | ✅ |

**The decision.** Each workspace is a Firecracker microVM. The VMM process runs inside the jailer: chroot, unprivileged UID, seccomp filter, its own cgroup. The device model is tiny: virtio block, virtio net, and vsock.

**Why it works here.** Developers need `sudo` and Docker. Inside a microVM, root owns a guest kernel and nothing else; a kernel exploit in the guest compromises the guest. Escaping requires a bug in KVM or in Firecracker's minimal device emulation, a far smaller attack surface than the full Linux syscall interface.

**How containers break.** To run `docker compose up` inside a container you either mount the host Docker socket (which is root on the host) or run a privileged container (which can load kernel modules and access host devices). Even without Docker, every container shares the host kernel, so each local privilege-escalation CVE is a cross-tenant breach on a box holding 75 tenants' source code. gVisor closes that hole, but its syscall emulation shows up as slow file-heavy builds and subtle incompatibilities, which in a dev environment means support tickets that look like "my build is flaky".

**Egress policy.** Developers need npm, pip, and git, so default egress is open, but enforced *outside* the guest, on the host's tap device with nftables, where guest root can't touch it:

1. No east-west traffic between VMs
2. Cloud metadata endpoint and internal ranges (control plane, other hosts) blocked
3. SMTP blocked; egress capped at 100 Mbps per VM; connection-rate limits
4. Org `allowlist` mode routes egress through a filtering proxy that only permits listed domains

The workspace agent is reached only over vsock, so the guest needs no inbound network path at all.

**Runaway processes and noisy neighbors.** Memory is fixed per VM, so a leak triggers the guest's OOM killer, not the host's. Fork bombs hit the guest PID limit. CPU shares are capped per VMM cgroup, so a pegged workspace gets its 4 vCPUs' share under contention but can't starve neighbors. Sustained all-core CPU plus connections to known mining pools trips abuse detection: throttle, then suspend with `reason = abuse`.

**What we give up.** Hosts must be bare metal (KVM), which lengthens procurement. Each VM carries its own guest kernel and page cache, so density is lower than containers. Guest init takes ~6 s, which is why the warm pool exists at all. And we lose cross-tenant memory sharing (identical libraries loaded 75 times).

---

## 🔧 Deep Dive 3: Persistent Volumes on Ephemeral Compute (7 minutes)

**The decision.** The running volume is a copy-on-write block device on the host's local NVMe, layered over a cached template or prebuild base. A host-side snapshotter tracks dirty blocks, and every 60 s it takes a crash-consistent point-in-time view, cuts dirty data into 1 MB chunks, compresses them, uploads them content-addressed (key = SHA-256 of the chunk), and commits a manifest under the current generation. Suspend does the same after a clean guest shutdown.

**Why it works for dev workloads.** Builds are metadata-heavy. `npm install` creates tens of thousands of small files; every `stat` and `fsync` on network block storage is a 0.5–1 ms round trip, versus ~20 µs locally. Local NVMe makes builds feel like a laptop. Content addressing deduplicates against template layers and prebuilds, which is why the average stopped workspace costs 5 GB rather than 32 GB. Snapshots happen from the host, at the block layer, so they still work when the guest disk is 100% full or the guest kernel has hung.

**How network block storage breaks.** It gives RPO zero, but it charges latency on exactly the operations dev tools do most, and its provisioned-capacity pricing means a stopped workspace still pays for a 32 GB volume, about 128 PB provisioned for 4M stopped workspaces instead of 20 PB of deduplicated chunks. It also concentrates noisy-neighbor risk in the storage cluster: one tenant's `rm -rf node_modules && npm install` loop eats IOPS shared with thousands of others.

**Resume without downloading 5 GB.** The new host attaches a volume backed by the manifest. Reads of chunks that aren't local fault them in from object storage. A prefetcher first pulls the hot set recorded during the last session (~500 MB, 0.5 s at 1 GB/s), then streams the rest in the background. Placement prefers the host that still caches the volume (`cached_on_host_id`), in which case nothing is downloaded.

**Host loss, end to end.**

1. t = 0: host dies. Clients' sockets drop; they show "reconnecting"
2. t = 20 s: (if merely partitioned) the host agent self-fences
3. t = 30 s: the control plane declares the lease dead, marks ~75 workspaces `recovering`
4. t = ~33 s: each is placed on a warm VM elsewhere, generation bumped, volume attached from its last committed manifest
5. t = ~35 s: clients reconnect through `/connect`; terminal sessions restart (processes are gone); the editor offers to re-apply file saves newer than the last durable snapshot, which it kept for exactly this case

At 3% annual host failure, 4,000 hosts lose ~120 hosts a year, about one every 3 days, so this path runs constantly and has to be boring.

**Disk full.** Inside the workspace, the volume is a fixed-size block device, so the guest gets ENOSPC rather than filling the host. The workspace agent keeps its own state on a small reserved disk, so the terminal still works and the user can clean up; the IDE shows a banner at 90%. On the host, disk pressure comes from caches (stopped workspaces' volumes, old image layers), which are evicted LRU; admission stops at 85%.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Local NVMe + 60 s incremental snapshots + lazy restore | Laptop-speed I/O; cheap when stopped; dedup | RPO 60 s; snapshotter and chunk GC to build |
| ❌ Network block storage | RPO 0; simple detach/attach | Slow metadata ops; pays for provisioned GB while stopped |
| ❌ Local disk, snapshot only on stop | Simplest | Host loss loses the whole session |

**What we give up.** RPO is 60 s, not zero. We own a chunk store with mark-and-sweep GC (only chunks older than 24 h with no manifest reference are deleted, so in-flight snapshots are safe). And the first minutes after a cross-host resume can see occasional cold reads for chunks outside the hot set.

---

## 🔀 Routing Terminal, LSP, and Port Traffic (3 minutes)

The browser opens one WebSocket per tab to the regional gateway with a 5-minute signed token containing user, workspace, generation, and capabilities. The gateway verifies it offline, looks up `workspace → (host, generation)` in an in-memory routing cache fed by Valkey pub/sub, and opens a stream on a pooled mTLS tunnel to that host agent, which forwards it over vsock to the workspace agent. Channels (terminal sessions, one per language server, file ops, port events, control) are multiplexed with per-channel flow control so a burst of terminal output can't starve an LSP response.

Previews (`{port}-{id}` on a separate registrable domain) take the same route. The separate domain matters because the user's dev server is arbitrary code; on the IDE's domain it could read IDE cookies or call IDE APIs as the user.

> "Clients never learn a host address. When a workspace moves, only the route changes; the client reconnects, gets a fresh token with the new generation, and replays terminal output from its last acknowledged byte. Gateway deploys use the same path: we send a 'moved' control frame and the client reconnects elsewhere."

Terminal backpressure: the agent stops reading the PTY when 256 KB is unacknowledged. At a 60 ms RTT that caps one terminal at 256 KB / 0.06 s = 4.3 MB/s, and when the PTY buffer fills, the writing process blocks, which is exactly what should happen to `cat` of a 2 GB log.

---

## 💰 Cost Control (2 minutes)

| Lever | Effect |
|-------|--------|
| Idle timeout on user input, not process activity | The 30 min tail is 27% of compute; 15 min would save $30K/day |
| Shorter timeout when no client is connected | Closed laptops stop paying sooner |
| Warning at T−5 min over the control channel | Users keep work without opting out of auto-stop |
| Archive storage class at 7 days, delete at 30 days | Bounds the 20 PB of stopped disks |
| CPU overcommit 3.1x, memory 1:1 | Density without OOM-killing sessions |
| Org budgets and per-user concurrent limits | Stops a script from starting 500 workspaces |
| Usage records per (workspace, generation) | Billing is exact once per run |

> "Activity means human input: keystrokes, saves, LSP requests from the client, preview requests from the owner's browser. A build running with nobody watching doesn't count. Otherwise every workspace with a dev server in watch mode would run forever, and that's the $960K/day world."

---

## 🚨 Failure Modes (2 minutes)

| Failure | Response |
|---------|----------|
| Host loss | Recover from last snapshot on warm VMs; ~35 s gap; <= 60 s of writes lost |
| Host partitioned | Self-fence at 20 s; stale generation destroyed after heal |
| Gateway node loss | Client reconnects; terminals replay from last acked sequence |
| Control-plane DB down | Data plane unaffected; starts queue; reaper pauses (fails safe by not stopping) |
| Object storage slow | Breaker opens; snapshots buffer locally; suspends deferred (keep running rather than lose data) |
| Registry down | Warm pool and image caches keep starts working; uncached cold starts fail fast |
| Runaway process / mining | Contained in the VM; throttle, then suspend and flag |

---

## 📈 Scalability: What Breaks First (2 minutes)

The control plane is partitioned into cells of ~1,000 hosts, each with its own PostgreSQL, Valkey, reconciler, and warm-pool manager. Peak needs ~5 cells; each cell database sees ~1,000 snapshot commits/s and ~200 activity flushes/s. Gateways are stateless and scale on connection count.

**What breaks first** is the morning ramp. Starts spike 5x, and if the warm pool runs dry, requests fall to the 8.5 s or 28.5 s path, and cold pulls hammer the registry, which slows refill further, a feedback loop. Mitigations: size pools predictively from yesterday's curve, push new template images to hosts before publishing them, and share image layers peer-to-peer within a cell.

---

## ❓ Follow-up Questions (3 minutes)

**"10x more users?"** 3M peak running needs 40,000 hosts, 105,000 warm VMs, 1,750 starts/s at peak, 150 GB/s of snapshot writes, and 4M WebSockets (80 gateway nodes at the 50K ceiling, ~240 with headroom). Cells scale linearly (~40). The real constraint is bare-metal procurement lead time and image distribution, so I'd invest in forecasting and P2P layer distribution.

**"A data center goes down?"** A zone loss expires ~1/3 of a region's leases at once. Snapshots live in multi-zone object storage, so every workspace is recoverable, but I deliberately don't hold N+1 zone headroom (50% more hosts). Instead recovery is prioritized by recent activity and paid tier while autoscaling catches up. A region loss kills running sessions; snapshots replicate cross-region asynchronously (RPO ~15 min), so users can restore in a fallback region at higher latency or recreate from git.

**"MVP in two weeks?"** Single region, one cell, gVisor containers on a handful of hosts, no warm pool, snapshot-on-stop only, workspace pinned to its host. I'd still ship three things on day one because they're expensive to retrofit: generation in the schema, the gateway with signed tokens, and idle auto-stop.

**"How do run and build work?"** Inside the workspace, like a laptop: terminal commands and template tasks (postCreate, postStart). The platform's job is machine classes (resize applies on next start, placed on a host class that fits), port detection, and prebuilds that run the expensive install once per commit instead of once per workspace.

**"Devbox variant over SSH?"** Same lifecycle and gateway; the gateway also terminates SSH-over-WebSocket (or an SSH proxy authenticates with short-lived certificates) and forwards to the workspace agent. Activity is SSH input.

**"Why not memory snapshots?"** Hibernating 8 GB of RAM per workspace is 4M x several GB of extra storage, and resume would download it. Disk-only suspend plus postStart tasks is cheaper; I'd offer a short in-host pause (keep the VM paused in RAM for ~10 minutes) as a premium fast-resume path.

**"Why not Kubernetes?"** Pods are the wrong unit for VMs with stateful local volumes, generation fencing, and warm pools keyed by digest. I'd borrow its reconciliation pattern rather than its scheduler.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Rationale |
|----------|----------|---------------|-----------|
| Isolation | Firecracker microVM | Containers / gVisor | Root + Docker safely; per-tenant kernel |
| Lifecycle | Desired state + reconciler | Command queue | Idempotent; no half-executed commands |
| Fencing | Generation on every side effect | Leases alone | Partitioned hosts can't commit stale state |
| Volumes | Local NVMe + 60 s snapshots | Network block storage | Fast metadata ops; stopped cost = deduped chunks |
| Cold start | Warm pools by digest | Lazy image loading only | Removes 26 s of pull and boot |
| Routing | Gateway + one multiplexed socket | Direct-to-host | Hosts private; moves invisible |
| Idle signal | Human input | Process activity | Watch-mode servers would never stop |
| Suspend | Disk only | Memory snapshot | Cost of RAM images |
| Headroom | Prioritized recovery | N+1 zone capacity | 50% more hosts is too expensive |

---

## 📝 Summary

"To summarize: the control plane stores desired state per workspace in a cell-local PostgreSQL, and a reconciler converges hosts toward it, with a generation number on every start so a partitioned host can never commit stale state. Each workspace is a Firecracker microVM, so users get root and Docker without sharing a kernel, and egress policy is enforced on the host where guest root can't reach it. Disks live on local NVMe for laptop-speed builds and stream content-addressed chunks to object storage every 60 seconds, giving a 60-second RPO on host loss and 5 GB average stopped cost. Warm pools keyed by image digest cut resume from 28.5 seconds to 2.4. A stateless gateway routes one multiplexed WebSocket per tab to the right host. And an idle timeout on human input keeps the 27% idle tail from becoming the whole bill. The hardest part isn't any single component; it's keeping compute disposable while the disk stays durable."
