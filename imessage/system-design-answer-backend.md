# iMessage - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for an end-to-end encrypted messaging platform: messages sync across all of a user's devices, groups work, media works, and everything works offline. The defining constraint is that **the server is a participant in the system but not a trusted one** — it stores, routes, and fans out ciphertext it cannot read. Every capability we normally take for granted from a backend (search the messages, deduplicate content, render a preview, resolve a conflict by inspecting the data) is off the table.

That single constraint is what makes this interesting. The backend's job collapses to three things it *can* do: be a **key directory**, be a **durable per-device mailbox**, and be a **fan-out engine**. Almost every design decision below falls out of doing those three things well while holding the encryption invariant.

## 🎯 Requirements Clarification

Questions I'd ask before designing:

- **Is the server allowed to see anything?** I'll assume the strict bar: it sees ciphertext, sender, recipients, timestamps, and sizes. That means no server-side search, no server-side link previews, no server-side spam classification on content. Metadata minimization (sealed sender) is a stretch goal, not v1.
- **Multi-device: is one device authoritative?** No — every device is a first-class peer with its own keypair. That decision drives the entire key architecture, and it's the one I most want to get right.
- **How large do groups get?** I'll design for groups up to ~100 members. Past a few hundred, the pairwise key-distribution cost genuinely breaks and you need a tree-based protocol (MLS). I'll say why later.
- **How long does the server keep undelivered messages?** Bounded — 30 days. "Forever" is not a policy, it's an unbounded storage liability, and I'll defend that number.

### Functional Requirements

- **Send**: encrypted 1:1 and group messages, plus attachments
- **Multi-device sync**: a message sent from my phone appears on my Mac and iPad, sent *and* received
- **Groups**: create, add/remove members, admin controls
- **Offline**: send while disconnected, deliver on reconnect, no loss
- **Receipts**: delivered and read state, synced across the sender's own devices too

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Delivery latency (recipient online) | p99 < 500ms | Chat feels broken above this |
| Message loss | Zero | The one bug users never forgive |
| Delivery semantics | At-least-once transport, exactly-once *effect* | Networks retry; the UI must not show a message twice |
| Ordering | Causal per conversation | Global ordering is unnecessary and expensive |
| Confidentiality | Server cannot decrypt, ever | Non-negotiable; it's the product |
| Availability | 99.99% for send/receive | |

### Scale Estimates

- 200M DAU, **5B messages/day** → ~58K/sec average, **100K/sec peak**
- ~2.3 devices per user → every message fans out to **~3 device mailboxes** (recipient's devices + sender's *other* devices) → ~300K device-deliveries/sec at peak
- ~15 active conversations per user
- Message metadata ~500 B, ciphertext body ~1 KB, per-device wrapped key ~256 B
- Attachments: 500M/day at ~2 MB → ~1 PB/day ingest, 50 PB stored

That per-device key number is the one to hold onto: 5B messages × ~3 device copies × 256 B ≈ **4 TB/day of key ciphertext alone**, on top of the message bodies. It's the reason group encryption can't be naive.

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Client Devices (the crypto lives here)           │
│              iPhone │ iPad │ Mac │ Watch  — local DB, keys,          │
│                      encrypt/decrypt, sync cursors                   │
└──────────────┬──────────────────────────────────────┬────────────────┘
               │ REST (send, sync, keys)              │ WSS (live push)
               ▼                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│           API Gateway  — TLS, auth, rate limiting, routing           │
└───┬──────────────────┬───────────────────┬──────────────────┬────────┘
    ▼                  ▼                   ▼                  ▼
┌─────────┐     ┌─────────────┐     ┌────────────┐    ┌──────────────┐
│   Key   │     │   Message   │     │    Sync    │    │  WebSocket   │
│Directory│     │   Service   │     │  Service   │    │   Gateways   │
│         │     │             │     │            │    │ (~50K conns  │
│ device  │     │ accept blob │     │ per-device │    │   each)      │
│ pubkeys │     │ + wrapped   │     │  cursors,  │    └──────▲───────┘
│ prekeys │     │   keys      │     │  receipts  │           │
└────┬────┘     └──────┬──────┘     └─────┬──────┘           │
     │                 │                  │                  │
     │                 ▼                  │                  │
     │          ┌─────────────┐           │                  │
     │          │  RabbitMQ   │──────▶ Delivery Workers ─────┤
     │          │ fan-out q   │        (per-device push,     │
     │          └─────────────┘         APNs fallback)       │
     ▼                 ▼                ▼                    ▼
┌──────────┐   ┌──────────────┐  ┌───────────┐   ┌────────────────┐
│PostgreSQL│   │  PostgreSQL  │  │   Redis   │   │  S3 / MinIO    │
│  keys,   │   │  messages,   │  │ sessions, │   │  encrypted     │
│ prekeys, │   │  mailboxes,  │  │ presence, │   │  attachments   │
│ devices  │   │  receipts    │  │  typing   │   │  (immutable)   │
└──────────┘   └──────────────┘  └───────────┘   └────────────────┘
                                                  + APNs / FCM push
```

The structural choice worth naming: **the key directory is a separate service from the message path.** They have completely different shapes — the directory is a small, read-heavy, cache-friendly store that must be *auditable*; the message path is a huge, write-heavy, append-only pipe that must be *fast*. Coupling them would mean scaling the wrong thing and, worse, letting message-path operators touch the trust anchor.

## 💾 Data Model

Described as tables rather than DDL:

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), username, email, password_hash, display_name | unique username, email | The account; not the crypto identity |
| devices | id (UUID PK), user_id (FK), device_name, device_type, push_token, is_active, last_active | (user_id) where is_active | The crypto identity lives here, not on the user |
| device_keys | device_id (PK/FK), identity_public_key, signing_public_key, registered_at | — | Long-lived. Cached in Redis 1h; invalidated on rotation |
| prekeys | id, device_id (FK), prekey_id, public_key, used (bool) | partial index on (device_id) WHERE NOT used | One-time keys; consumed on first contact |
| conversations | id (UUID PK), type (direct/group), name, created_by | — | |
| conversation_participants | (conversation_id, user_id) PK, role (admin/member), joined_at, left_at, muted | partial index on conversation_id WHERE left_at IS NULL | Membership + group RBAC |
| messages | id (UUID PK), conversation_id, sender_id, sender_device_id, ciphertext, iv, content_type, reply_to_id, edited_at, deleted_at | (conversation_id, created_at DESC) | **One row per message.** The body is stored once, opaque |
| message_keys | (message_id, device_id) PK, encrypted_key, ephemeral_public_key | (device_id) | **N rows per message** — the wrapped AES key, one per recipient device |
| device_mailbox | (device_id, seq BIGINT) PK, message_id, enqueued_at, acked_at | (device_id, seq) WHERE acked_at IS NULL | The delivery queue *and* the sync log. See Deep Dive 3 |
| group_sender_keys | (conversation_id, sender_id) PK, chain_key (opaque blob), chain_index | — | Server stores the *distribution* of these; the chain itself is client-derived |
| read_receipts | (user_id, conversation_id) PK, last_read_message_id, last_read_at | — | Last-write-wins by timestamp |
| attachments | id, message_id, content_hash, file_url, size, encrypted_key_ref | (message_id) | Content-addressed; the blob is encrypted before upload |
| idempotency_keys | key (PK: user:conversation:client_msg_id), user_id, result_id, status | — | Durable backstop behind the Redis fast path |

Two things I want to call out about this model:

> "Notice that `messages.ciphertext` has no accompanying searchable column, no plaintext preview, no `body_tsvector`. Anything the server could index would be a decryption oracle. The absence is the design. It means product features that other systems get for free — search, spam filtering, rich link previews — become client-side problems, and I should say that out loud rather than pretend the server can help."

> "Also notice that `messages` is 1 row but `message_keys` is N rows. The body is encrypted once with a random symmetric key; only that 256-byte key gets re-wrapped per device. Encrypting the *body* per device would multiply 5 billion kilobyte-sized blobs by three — an extra ~15 TB/day of storage and bandwidth to say the same thing three times."

## 🔌 API Design

```
POST   /api/v1/devices                    → Register device, upload identity + prekeys
POST   /api/v1/devices/:id/prekeys        → Replenish one-time prekeys
DELETE /api/v1/devices/:id                → Revoke device (triggers group re-key)
GET    /api/v1/keys/:userId               → All active device pubkeys + one prekey each (consumes)
GET    /api/v1/keys/:userId/count         → Remaining prekey count (client self-monitors)

POST   /api/v1/conversations              → Create direct or group
POST   /api/v1/conversations/:id/members  → Add member (admin only)
DELETE /api/v1/conversations/:id/members/:userId → Remove member

POST   /api/v1/messages                   → Send: {ciphertext, iv, [{deviceId, wrappedKey}]}
                                            Requires client-generated message ID
GET    /api/v1/sync?since=<seq>&limit=100 → Device mailbox delta since last cursor
POST   /api/v1/sync/ack                   → Ack up to seq N (releases server storage)
POST   /api/v1/messages/:id/receipts      → Delivered / read

WSS    /ws                                → Live push: message.new, receipt, typing, presence
```

The send endpoint is worth a beat: **the client tells the server which devices to deliver to and hands it a wrapped key per device.** The server does not — cannot — construct those. The server's only authority is to *validate* that the device list matches its own view of the conversation's participants, and to reject the send if the client tried to omit a device (which would be an attempt to silently exclude someone from a group) or include a stranger.

## 🔧 Deep Dive 1: The Key Directory Is the Trust Anchor

This is the part of an E2E system that people skip, and it's the part that actually decides whether the encryption means anything.

**The mechanics first.** Each device generates an identity keypair and uploads ~100 one-time prekeys. To start a session with Bob, Alice fetches Bob's device list, and for each device gets the identity key plus one prekey, which the server marks consumed. Alice runs X3DH — an ephemeral key plus Bob's identity and prekey — to derive a shared secret per device, and wraps her message key with it. Prekey consumption must be atomic (a conditional update that claims exactly one unused row per request), or two concurrent senders get the same prekey and forward secrecy is silently gone. When a device's unused prekey count drops below ~20, the server sends it a silent push to upload more.

**Prekey exhaustion is a real failure mode**, not a hypothetical: a device that's been offline for a month while people message it will run dry. The fallback is the device's *signed* prekey, which is long-lived — the session still establishes, but forward secrecy for that session is weaker. That's the right call: **degrade the crypto property, never fail the message.** A user whose messages silently stop arriving will uninstall the app; a user with a slightly weaker ratchet for one session will not, and the ratchet recovers on the first reply anyway.

**Now the actual problem.** The server hands Alice the list of Bob's devices and their public keys. What stops the server from adding a device to that list — one whose private key the server holds?

Nothing, cryptographically. **The server can mount a MITM at any time by lying in the key directory.** Every E2E messaging system has this hole; the question is what you build around it.

> "This is the honest limit of E2E encryption as normally deployed: it protects you from a passive attacker on the wire and from a database dump, but a *malicious or compelled key server* can just serve a bad key. So the mitigations aren't cryptographic, they're about making the lie observable. Three layers. First, **safety numbers**: a hash of both parties' identity keys, rendered as digits both users can compare out of band. Bulletproof, and used by roughly nobody. Second, **device-add notifications**: when a device joins your account, every conversation you're in shows 'Alice added a new device.' This flips the attack from invisible to noisy — the server can still do it, but it can't do it quietly. Third, and this is the one I'd actually invest in: **key transparency**. The directory publishes every key binding into an append-only Merkle log; clients verify inclusion proofs for the keys they're handed and periodically audit that their *own* key history contains no entries they didn't create. That converts 'trust the server' into 'the server cannot equivocate without leaving a permanent, provable record.' It's exactly the CT/CONIKS design and it's the only mitigation that scales past user diligence."

**What it costs**: the key directory now has to be an append-only, signed, auditable log — which means it can't be a table you `UPDATE`. It becomes its own service with its own durability story, monitoring for log-forking, and a client that does real cryptographic verification work on every new contact. That's a meaningful chunk of engineering for a property most users will never consciously observe. I'd still build it, because the alternative is that the whole E2E claim rests on the promise of the exact party it's supposed to protect against.

## 🔧 Deep Dive 2: Group Encryption — Sender Keys, and the Bill They Come With

**The problem, in numbers.** A 50-member group, 2.3 devices each ≈ 115 devices. Naive per-device encryption means every single message carries 115 wrapped keys — 115 × 256 B ≈ 29 KB of key material to deliver a 200-byte "ok sounds good." The cost is **O(members × devices) per message**, and it lands on the sender's phone (115 ECDH operations before it can hit send) and on our storage (`message_keys` grows 115× faster than `messages`).

**The fix: sender keys** (the Signal group protocol). Each member generates one symmetric sender key per group and distributes it *once*, pairwise-encrypted, to every other device. After that one-time distribution, sending a group message is: encrypt once with your ratcheting chain key, upload one ciphertext, done. **O(1) per message.** The 115 pairwise operations still happen — but once per member per group, not once per message. Amortized over the thousands of messages a group sends, it's free.

**Where the bill comes due: member removal.** When you remove someone, their cached sender keys for every other member remain valid — they could still decrypt future messages if they somehow received them. So **every remaining member must rotate their sender key and redistribute it to every remaining device.** For our 50-member group: 49 members × ~113 remaining devices ≈ **5,500 pairwise-encrypted key distributions**, triggered by one person tapping "Remove."

> "So the trade-off is a straight bet on the ratio of messages to membership changes, and for a group chat that bet is overwhelmingly correct — a 50-person group might send 10,000 messages a month and remove one person a year. Per-device encryption would cost 10,000 × 115 = 1.15M wrapped keys a month; sender keys cost roughly 5,700 at setup plus 5,500 on that one removal. Two orders of magnitude. Where the bet *loses* is a group with churn: a 100-person work channel where people join and leave weekly turns into a re-key storm, and every removal blocks on 100 clients — some of them offline — actually performing and uploading their rotations. Members who are offline during a rotation can't send until they catch up, so the group gets briefly, partially wedged."

**What I give up, concretely:** removal becomes an *asynchronous, eventually-consistent* operation with a visible tail. I'd handle that by (a) queueing the redistribution rather than doing it inline, (b) letting removal take effect immediately at the *authorization* layer — the server refuses to deliver anything from the removed member's device the instant the row is written, so the crypto rotation is defense-in-depth rather than the enforcement mechanism, and (c) instrumenting rotation completion so I can see a group stuck at 80% rotated.

**And the ceiling I'm accepting:** sender keys are O(N) in the group size for *setup and re-key*, which is why they fall over somewhere past a few hundred members. The real answer above that is **MLS**, which uses a ratchet tree to make membership changes O(log N) instead of O(N) — a 1,000-member group re-keys in ~10 operations instead of 1,000. I'd name MLS explicitly as the migration path and *not* build it now: it's a substantially harder protocol, and 99% of groups are under 20 people.

## 🔧 Deep Dive 3: Delivery — Why the Mailbox Is Per-Device, Not Per-Conversation

Here's a modeling decision that looks like an implementation detail and is actually the biggest scaling call in the system.

The obvious model: shard `messages` by `conversation_id`. Everything about a conversation lives together, membership checks are local, history reads are a single-shard index scan. Clean.

**It breaks on the read path that actually matters.** The dominant read isn't "show me this conversation" — the client already has that in its local database. The dominant read is **reconnect sync**: a device comes back after 6 hours and asks "what did I miss, across everything?" With conversation-sharding, that's a scatter-gather across every shard holding any of the user's ~15 conversations, per device, and it happens for *every* device on *every* reconnect — subway exits, app foregrounds, laptop wakes. Millions of times an hour, each fanning out to N shards, each shard doing a cursor comparison. You've turned the single hottest query in the product into a distributed query.

**So the mailbox is the primary structure: an append-only, per-device queue keyed by (device_id, seq).** Sending a message writes the body once, writes the wrapped keys, then appends one lightweight row to each recipient device's mailbox. Reconnect sync becomes exactly one query on one shard: *give me my rows after seq N.* It's a sequential index scan on a monotonic key, and the device_id shards perfectly because devices never talk to each other.

| Approach | Reconnect sync | Send cost | Verdict |
|----------|----------------|-----------|---------|
| ✅ Per-device mailbox (sharded by device_id) | One indexed scan, one shard | Fan-out write: ~3 rows/message, 300K rows/sec at peak | **Chosen** — optimizes the hot path |
| ❌ Per-conversation store (sharded by conversation_id) | Scatter-gather across ~15 shards, per device, per reconnect | One row/message | Rejected — the common read is a distributed query |

> "This is fan-out-on-write, and I want to be precise about *why* it's safe here when it's famously dangerous elsewhere. Fan-out-on-write kills you when the fan-out factor is unbounded — a celebrity with 50M followers. Messaging has no celebrities: the fan-out is (members × devices), and membership is bounded by product rules at ~100 and ~5 devices. The worst case is 500 rows, not 50 million. Once fan-out is bounded, precomputing it at write time is strictly better than paying a merge cost on every one of the billions of reads. I'm buying a hard bound on reconnect latency with a bounded, predictable write amplification — and 300K small appends/sec across a device-sharded cluster is an ordinary amount of work."

**The mailbox is also the retention mechanism, and that's the second half of this decision.** A mailbox row is deleted when the device acks it. When every recipient device has acked, the message body and its wrapped keys become garbage-collectable. That gives me a *self-cleaning* system rather than an ever-growing archive — which matters enormously, because the server is holding ciphertext it can't compress, dedupe, or summarize.

But a device can go dark forever — an old iPad in a drawer will never ack. Without a bound, its mailbox grows without limit and pins the underlying message bodies with it. So: **30-day retention, then drop.**

> "Thirty days is a product decision disguised as an ops number, and I'd defend it as: past a month, a device that reappears is better served by *nothing* than by a month-old backlog. The user has already read those messages on their phone. Storing them forever costs us real petabytes to serve a case that helps no one, and — worth saying — it makes us a much more attractive target for a subpoena. Short retention isn't just cheap, it's a security property. What I give up is the genuinely sad case: your only device breaks, you get a new one three months later, and your history is gone, because the server can't restore what it can't read. The answer to that is client-side encrypted backup with a user-held key — which is a whole additional system, and it's the right one to build, but it's a *backup* product, not a *messaging* one, and conflating them is how you end up storing everyone's messages forever."

**Live delivery** rides on top: after the mailbox append, a fan-out worker consumes from RabbitMQ and pushes to the device's WebSocket gateway (routed via Redis pub/sub, since the device may be connected to any of N gateways). If the device isn't connected, we send an APNs push containing *no content* — just a wake signal — and the device pulls from its mailbox over the sync endpoint. The push notification can't carry the message because we can't decrypt it, so the client decrypts locally and populates the notification itself. WebSocket delivery is an *optimization* over the mailbox, never a replacement: if the push fails, the mailbox still has the row, and the next sync gets it. **The mailbox is the contract; the socket is just the fast path.**

## 🔐 Device Provisioning: The Problem the Server Can't Solve

Adding a new device to an existing account is where the E2E constraint bites hardest, and it's the question I'd expect an interviewer to push on.

Alice buys a new Mac. It generates a fresh keypair, registers, uploads prekeys. From this moment forward, everyone who messages Alice will fetch her updated device list and wrap the message key for the Mac too. Forward messaging works.

**But the Mac has no history.** The server is sitting on Alice's last 30 days of ciphertext — and it cannot give the Mac anything useful, because every one of those messages was wrapped for devices that existed *at the time it was sent*. There is no `message_keys` row for a device that didn't exist. The server cannot create one; that would require decrypting the message key, which is precisely what it can't do.

Three ways out, and the choice tells you what kind of product you're building:

| Approach | How it works | Cost |
|----------|--------------|------|
| ✅ Device-to-device transfer | The new device establishes an authenticated session with an existing one (QR code scan, proving physical possession) and the old device streams decrypted history to it, re-encrypted for the new device | Requires both devices online and co-present; history transfer of a large archive is slow |
| ❌ Server-side re-encryption | The server re-wraps existing message keys for the new device | **Impossible.** The server would have to hold the plaintext keys. This is the design the whole system exists to prevent |
| ➕ Encrypted cloud backup | Client uploads its history encrypted under a key derived from a user passphrase or held in a hardware secure enclave; new device restores from it | Real answer for the "phone in the ocean" case, but it's a separate product with its own key-recovery threat model |

> "I'd ship device-to-device transfer for v1 and be explicit that the new device simply starts empty otherwise. That is a *worse* product than a cloud-backed messenger, and I want to name that honestly rather than hand-wave it — 'your history doesn't follow you to a new device unless you transfer it' is a real cost we are paying for the encryption guarantee. The interesting design consequence is that once you build encrypted backup, the backup key becomes the single most valuable secret in the system, and how you let a user recover it if they forget their passphrase becomes the hardest security decision in the entire product. It's harder than anything in the messaging path, which is why I'd separate it rather than bolt it on."

Two related mechanics, both server-side and both cheap:

- **A new device must be announced.** The server pushes a device-added event to every conversation Alice is in. That's not a nicety — it's the detection mechanism for the key-directory attack in Deep Dive 1. If a device you didn't add appears, you find out.
- **Device revocation is server-authoritative and immediate.** Marking a device inactive means it stops appearing in key lookups, its sessions are killed, its mailbox is dropped, and every group it participated in schedules a sender-key rotation. The crypto rotation is eventually consistent; the authorization cut is not.

## 📎 Attachments: Encrypt, Then Store

Attachments are the largest thing we store (~1 PB/day ingest) and the simplest to reason about, precisely *because* of the encryption constraint.

The flow: the client generates a random symmetric key, encrypts the file locally, and uploads the ciphertext directly to object storage via a short-lived presigned URL — it never passes through our API servers. It then sends a normal message whose payload contains the storage URL, the content hash, and the file key, all wrapped per recipient device exactly like a text message's key. Recipients fetch the ciphertext from the CDN and decrypt locally.

Three consequences worth stating out loud:

1. **The upload path bypasses the application entirely.** A 25 MB video does not consume an API server's memory, connection, or CPU. Presigned URLs mean object storage handles the bytes and we handle only the metadata. This is the difference between a media pipeline that scales and one that falls over on a Friday night.
2. **We cannot deduplicate.** The same viral video sent by a million people encrypts to a million distinct ciphertexts, because each has a different random key. Any normal CDN would store it once; we store it a million times. **That is the price of the guarantee** — and it's a big one, a genuine multiple on storage cost. The mitigation is convergent encryption (derive the key from the file's own hash so identical files produce identical ciphertext), and I would *reject* it: it reintroduces exactly the confirmation-of-a-file attack we're trying to prevent, letting anyone with a candidate file check whether you have it. Paying for redundant storage is the correct trade here.
3. **No server-side thumbnails, no transcoding, no content scanning.** The sender's device generates the thumbnail and encrypts it as a second small blob. Everything a media backend normally does for you is now the client's job.

Attachments are content-addressed and immutable, so they're trivially CDN-cacheable and expire on a TTL independent of the message retention window.

## 🛡️ Idempotency, Consistency, and Failure Handling

**Exactly-once effect on an at-least-once transport.** A phone loses signal mid-send, retries, and the server may already have committed the first attempt. The client generates the message ID; the server keys idempotency on `{userId}:{conversationId}:{clientMessageId}`. Two layers, because they fail differently: a Redis check (sub-millisecond, 24h TTL) catches the overwhelming majority, and a unique constraint in PostgreSQL is the durable backstop for when Redis is cold. A duplicate returns the *original* message ID and its mailbox sequence — not just a "seen" flag — so the client can reconcile its optimistic local row.

Delivery receipts are keyed `{messageId}:{deviceId}:delivered` — naturally idempotent, since marking the same message delivered twice is harmless.

**Conflict resolution, given we can't read the data:**

| Data | Strategy | Why it's safe |
|------|----------|---------------|
| Messages | Append-only, unique IDs | No conflict is possible — there's nothing to merge |
| Read receipts | Last-write-wins on client timestamp | Two devices marking "read" both advance the same cursor; the race is benign |
| Deletes | Tombstone (`deleted_at`) that syncs like a message | Devices remove locally. **No un-delete** — resurrecting a tombstone is a privacy bug |
| Group membership | Server-authoritative, serialized per conversation | The one thing the server *must* order, since crypto correctness depends on it |

That last row is the exception worth defending: everything else in this system is eventually consistent, but membership changes are strongly ordered per conversation, because "was Bob in the group when this message was sent" must have exactly one answer. Concurrent add and remove resolving differently on different clients would produce members who can't decrypt, or ex-members who can.

**Degradation, in priority order:**

| Component down | Behavior |
|----------------|----------|
| WebSocket gateway | Delivery falls back to APNs wake + pull sync. Latency degrades from 200ms to seconds; nothing is lost |
| RabbitMQ / fan-out workers | Messages still commit and land in mailboxes. Live push stops; clients get them on next sync or reconnect |
| Redis | Sessions fall back to PostgreSQL. Presence and typing indicators disappear (they're pure-Redis and ephemeral by design). Rate limiting **fails open** |
| Key directory | New conversations can't start. Existing sessions keep working — the ratchet is client-side and doesn't need the server |
| PostgreSQL (message shard) | Sends for those devices fail with a retryable error. The client queues locally and retries; nothing is silently dropped |

Rate limiting fails open deliberately: I would rather serve some spam for ninety seconds than stop delivering everyone's messages because a cache is down. That is *not* the call I'd make on a payments system — but here, availability of the message path outranks abuse enforcement.

## 🔁 Syncing a User With Themselves

A detail that's easy to miss and annoying to retrofit: **the hardest sync target isn't the recipient, it's the sender's own other devices.**

When Alice sends from her phone, her Mac must show that message as sent — with the same content, in the same position in the conversation. But the Mac cannot decrypt a message that was encrypted for Bob's devices. So Alice's phone must treat her *own* other devices as additional recipients: it wraps the message key for them too, and the server appends to their mailboxes exactly like any other device. Self-fan-out is not a special case; it's the same code path, which is why the mailbox is keyed by device rather than by user.

This is also why the delivery fan-out factor is ~3 rather than ~2.3 — every message goes to the recipient's devices *plus* the sender's other devices.

**Read state** is the messier half. Alice reads a message on her phone; her Mac must clear the unread badge, and Bob should see "Read." Two different propagation paths for one event:

1. **To Alice's own devices** — a small encrypted sync message on the same mailbox rails, so her Mac learns the conversation is read.
2. **To Bob** — a receipt, which the server *can* handle in plaintext because it carries no content: just "this message was read at this time."

Conflicts are benign and resolved last-write-wins on the client's timestamp: two of Alice's devices both marking the conversation read simply advance the same cursor to the same place. I'd deliberately *not* build anything more sophisticated here. A CRDT or a vector clock would guarantee convergence, and it would guarantee it for a value that is monotonically increasing and idempotent already — you'd be paying real complexity to solve a problem the data model doesn't have.

**Typing indicators and presence** never touch PostgreSQL. They live only in Redis with 5- and 30-second TTLs and are broadcast best-effort over WebSocket. They're the definition of data that is worthless the moment it's stale — persisting them would be a pure cost with no benefit, and the auto-expiring TTL *is* the correctness model.

## 🔒 Auth, Authorization, and Abuse

Session-based auth: bcrypt-verified credentials mint a random session token in Redis with sliding 30-day expiry. Devices authenticate separately, so a session can be revoked per-device — which matters, because "sign out my stolen iPad" must not sign out my phone.

Authorization is two-tiered. Conversation membership gates everything on the message path, and it's checked on *every* send. That check would be a database query per message — 100K/sec of pure participant lookups — so participant sets are cached in Redis as sets, turning a 15ms join into a sub-millisecond membership test, invalidated on membership change. Within a group, an `admin`/`member` role gates adds, removes, and settings changes.

| Endpoint | Limit | Scope | What it stops |
|----------|-------|-------|---------------|
| Send message | 60/min | Per user | Message-bombing someone's device and draining their battery |
| Attachment upload | 20/min | Per user | Storage abuse via the presigned-URL path |
| Login | 5/15min | Per IP | Credential stuffing |
| Device registration | 10/hour | Per user | Device enumeration and MITM device injection |
| Key lookup | 100/min | Per user | Scraping the social graph out of the key directory |

That last one deserves a note: **the key directory is a social-graph oracle.** Anyone who can query "does this phone number have an account, and how many devices" can enumerate the user base. Rate limiting it isn't about load, it's about privacy — the directory leaks metadata even when it's behaving perfectly.

And the uncomfortable one: **we cannot do content-based abuse detection.** No spam classifier, no CSAM hashing on the server, nothing. Everything we have is behavioral — send velocity, fan-out to strangers, block-and-report rates, account age. It's genuinely weaker than what a plaintext platform can do, and pretending otherwise would be dishonest. The tools that remain are user reports (where the *reporter's* client attaches the decrypted message, because the reporter can consent to reveal it) and graph-shaped signals.

## 📊 Observability

The hard part of observing an E2E system is that **you cannot log the thing you most want to look at.** Every debugging tool has to work on metadata alone.

| Signal | Why it matters |
|--------|----------------|
| Delivery latency histogram (send → device ack) | The core SLO. Split by online-push vs. push-then-pull, or the two hide each other |
| Undelivered mailbox depth per device, p99 | The earliest signal of a stuck fan-out or a gateway silently dropping pushes |
| Prekey exhaustion rate | A rising rate means clients aren't replenishing — silent forward-secrecy degradation |
| Sender-key rotation completion time | A group stuck mid-rotation is a group where some members can't send |
| Idempotency hit rate | A spike means clients are retrying, which means something upstream is timing out |
| Key-directory write audit | Every key binding, append-only. This is the log you read after a compromise |
| Decryption-failure reports from clients | The canary for a protocol bug. Clients can't tell us *what* failed to decrypt, only that something did — but a spike is unambiguous |
| WebSocket connection gauge per gateway | A cliff means a gateway died and 50K devices are about to reconnect at once |

Structured JSON logs carry `requestId`, `userId`, `deviceId`, `conversationId`, `messageId` — and **never content, never keys.** A support case ("my message never arrived") is answered by tracing one message ID across accept → mailbox append → fan-out → ack, entirely on metadata. That works, and it's the only thing that does.

That last metric is the one I'd watch most nervously. In a plaintext system, a serialization bug shows up as a garbled message in a log and someone fixes it in an hour. Here, the failure is silent on the server and total on the client: the recipient's device simply cannot open the envelope, and the only thing we ever learn is a counter going up. It means **the client-reported decryption-failure rate is effectively our correctness test in production**, and it needs an alert threshold tight enough to catch a bad rollout within minutes rather than after a day of undelivered messages.

Health checks are the usual three — liveness (is the process up), readiness (can it reach PostgreSQL and Redis, gating whether the load balancer routes new WebSocket connections here), and a deep check reporting per-dependency latency. The readiness probe matters more than usual because a gateway with a broken Redis connection still accepts TCP connections happily; without the probe, the load balancer keeps feeding it devices that will never receive a push.

## 📈 Scalability: What Breaks First

1. **The `message_keys` table.** It's the fastest-growing thing in the system — ~4 TB/day of 256-byte rows that exist only until every device acks. It's not a query problem, it's a *write and vacuum* problem: PostgreSQL churning through billions of short-lived rows a day. Fixes, in order: partition by day and drop whole partitions instead of deleting rows (turning garbage collection from a billion DELETEs into a DDL statement), then move the wrapped keys out of PostgreSQL entirely into a store built for high-write-rate, TTL'd, key-value data — Cassandra partitioned by device_id, which is exactly this access pattern's shape.

2. **Fan-out write amplification at peak.** 100K messages/sec × ~3 devices = 300K mailbox appends/sec, and a large group multiplies that. This shards cleanly by device_id — the mailbox has no cross-device queries by construction — so it scales horizontally. The wrinkle is that a *send* now writes to many device shards, so it's a multi-shard write. I don't want a distributed transaction here: the message body commits first, then mailbox appends happen idempotently from the queue, retried until they land. A partially fanned-out message is a message that's late for some devices, not a lost one.

3. **WebSocket connection count.** 200M DAU × 2.3 devices, with a large fraction connected — millions of concurrent sockets at ~50K per gateway means hundreds of gateways. This is the easy one: gateways are stateless, and Redis pub/sub (or a Kafka topic per gateway shard) routes a push to whichever gateway holds the device. The thing to watch is the *reconnect thundering herd* — a gateway dies, 50K devices reconnect at once and each immediately issues a sync query. Jittered backoff on the client, and the sync path has to be cheap enough to absorb it, which is precisely why the mailbox read is one indexed scan.

4. **Group re-key storms.** Not a throughput bottleneck but a latency cliff, and it's the one that would surprise me in production: a raid of removals in a large group generates O(N²) key distributions. Bound it — rate-limit membership churn, batch simultaneous removals into a single rotation round.

5. **The key directory, but for a different reason.** It's tiny — a few hundred bytes per device, read-heavy, ~99% cache hit rate on device pubkeys with a 1-hour TTL. It will never fall over on load. What breaks is the *transparency log*: an append-only Merkle structure that must accept every key registration and serve inclusion proofs, and that has a single logical head. Sharding an append-only log without giving an attacker a way to fork it is a genuinely hard problem, and it's the one I'd expect to spend the most engineering time on relative to its traffic.

Attachments barely register as a *scaling* problem: they're immutable, content-addressed, encrypted blobs on object storage with a CDN in front, and the upload path never touches our servers. They're the biggest number in the capacity table and the least interesting problem in the system.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Device identity | ✅ Per-device keypairs | ❌ One key shared across a user's devices | Compromise is isolated; revoking one device doesn't re-key the account |
| Message encryption | ✅ Encrypt body once, wrap the key per device | ❌ Encrypt body per device | 3× on 256 bytes, not on 1 KB — saves ~15 TB/day |
| Group encryption | ✅ Sender keys | ❌ Per-device fan-out encryption | O(1) vs O(members×devices) per message; groups send far more than they churn |
| Large groups (>~200) | ✅ Name MLS as the migration path | ❌ Build MLS now | Ratchet tree is O(log N) re-key, but 99% of groups are under 20 |
| Delivery storage | ✅ Per-device mailbox, sharded by device_id | ❌ Per-conversation store | Reconnect sync is the hot read; make it one scan, not a scatter-gather |
| Retention | ✅ 30 days, then drop | ❌ Store until acked, forever | Bounded storage; less subpoena surface. Backup is a separate product |
| Key directory integrity | ✅ Append-only log + transparency proofs + device-add alerts | ❌ Trust the server | The server *can* MITM; make it impossible to do so undetectably |
| Prekey exhaustion | ✅ Fall back to signed prekey | ❌ Reject the message | Degrade the crypto property, never fail delivery |
| Consistency | ✅ Eventual + causal per conversation; membership strongly ordered | ❌ Linearizable everywhere | Chat tolerates seconds of skew; group membership does not |
| Rate limiting | ✅ Fail open | ❌ Fail closed | Message delivery outranks abuse enforcement — the opposite call from a payments system |
| Attachment dedup | ✅ Accept redundant storage | ❌ Convergent encryption | Dedup would let anyone confirm you hold a known file — pay for the storage instead |
| New-device history | ✅ Device-to-device transfer | ❌ Server re-encrypts the archive | The server has no key to re-wrap with; the "easy" option is cryptographically impossible |

## 🚀 Closing: What I'd Build Next

Three threads I'd pull with more time. **Sealed sender** — right now the server sees *who is talking to whom*, which for many users is the more dangerous fact than the content; hiding the sender identity from the server (while still authenticating it to the recipient) is a real, tractable protocol change. **Client-side encrypted backup**, because the 30-day retention decision above quietly leaves users one broken phone away from losing everything, and the honest answer is that the recovery story belongs in a separate, key-escrowed system rather than in the message store. And **abuse handling without content access** — spam and harassment are graph and behavior problems here, not content problems, and every tool a normal platform reaches for is unavailable to us by construction.

The thing I'd want to leave the interviewer with: in most systems the server is the smart component. Here, the server is deliberately dumb, and almost every hard decision — group re-keying, sync, retention, even abuse — is hard *specifically because* we refused to let the server look at the data. That refusal is the whole product.
