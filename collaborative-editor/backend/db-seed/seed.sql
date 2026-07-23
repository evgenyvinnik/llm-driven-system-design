-- Seed data for development/testing
--
-- Every document is seeded as a snapshot at version 0 rather than as a stream of
-- operations. Loading replays the latest snapshot plus any operations after it,
-- so a version-0 snapshot is the cheapest valid starting state and avoids
-- fabricating an operation history that no client actually produced.

-- Insert default users for testing
INSERT INTO users (id, username, display_name, color) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice', 'Alice Johnson', '#3B82F6'),
  ('22222222-2222-2222-2222-222222222222', 'bob', 'Bob Smith', '#10B981'),
  ('33333333-3333-3333-3333-333333333333', 'charlie', 'Charlie Brown', '#F59E0B')
ON CONFLICT (id) DO NOTHING;

INSERT INTO documents (id, title, owner_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Welcome Document', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Q3 Engineering Roadmap', '11111111-1111-1111-1111-111111111111'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Design Review — Sync Protocol', '22222222-2222-2222-2222-222222222222'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Incident Postmortem 2026-07-14', '33333333-3333-3333-3333-333333333333'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Meeting Notes — Weekly Sync', '22222222-2222-2222-2222-222222222222')
ON CONFLICT (id) DO NOTHING;

INSERT INTO document_snapshots (document_id, version, content) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0, 'Welcome to the Collaborative Editor!

Open this document in two browser windows, pick a different user in each, and
type in both. Every keystroke is an operation (retain / insert / delete) that is
applied locally first, then transformed against anything that landed in between.

Try it: put both cursors on the same line and type at the same time. Neither
edit is lost, and both windows converge on the same text.'),

  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 0, 'Q3 Engineering Roadmap

Theme: make the sync path observable before making it faster.

1. Snapshot worker
   The snapshot.worker queue is published to every 50 operations but has no
   consumer. Snapshots currently only land when the last client disconnects.
   Decide: background worker, or a synchronous write on the 50th operation?

2. In-memory operation ring
   Transforming against the oplog costs a Postgres read per keystroke. A bounded
   ring of recent operations per document would take that off the hot path, with
   a database fallback when a client is further behind than the ring reaches.

3. Access control
   document_access exists in the schema with view/edit/admin levels and nothing
   reads it. Enforcing it means the WebSocket handshake needs a real session.

4. Version history UI
   The operations table already holds everything needed to scrub through a
   document''s history. Nothing renders it yet.'),

  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 0, 'Design Review — Sync Protocol

Context
-------
Clients apply edits optimistically and reconcile with a server-authoritative
version number. The invariant that makes this tractable: exactly one operation
in flight per client at a time.

Why one and not two
-------------------
The server acks in order, but with two operations outstanding the client would
need to know which server-side operations the second was transformed against
relative to the first. The pairwise transform loses a well-defined base and the
chain breaks. Holding a single in-flight operation collapses that ambiguity.

The batching bonus
------------------
Keystrokes typed during a round-trip get composed into one operation, so the
operation rate scales with latency rather than typing speed. On a 500ms link a
client sends at most two operations per second — each carrying every keystroke.

Open question
-------------
Cross-server fanout forwards the originating server''s transformed operation
verbatim. Under which interleaving does a receiving server need to re-transform
against its own concurrent operations?'),

  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 0, 'Incident Postmortem — 2026-07-14

Summary
-------
Editors on server 2 stopped receiving remote operations for roughly 9 minutes.
Local editing continued to work throughout; no data was lost.

Timeline
--------
14:02  RabbitMQ broker restarted for a host upgrade.
14:02  Publish circuit breaker opened after 3 consecutive failures.
14:02  Operations continued to apply locally and persist to Postgres.
14:11  Broker healthy. Breaker half-opened, then closed.
14:11  Fallback buffer drained; clients on other servers caught up.

What worked
-----------
The bounded fallback buffer did its job — edits were never blocked on the
broker. Degrading to single-server sync is the correct failure mode.

What did not
------------
Nothing surfaced the degraded state to users. Two people editing the same
document from different servers each saw a document that looked fine and was
silently diverging until the broker recovered.

Action item
-----------
Surface broker/breaker state in the client as a "reconnecting" indicator. A
stale document that looks live is worse than one that admits it is stale.'),

  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 0, 'Meeting Notes — Weekly Sync

Attendees: Alice, Bob, Charlie

- Transform latency histogram is now bucketed by concurrent-operation count
  (0, 1-5, 6-10, 10+). Most operations land in the 0 bucket, which is the
  expected shape: genuine concurrency is rarer than it feels.

- Agreed the resync path is the right recovery for a base-length mismatch.
  Crashing the connection loses pending work; resync only loses unsent edits.

- Bob raised offline editing again. Still out of scope: it is the one thing OT
  genuinely cannot do well, and the honest answer is "collaborative while
  connected" rather than a half-working merge.

- Next week: decide the snapshot worker question from the roadmap doc.')
ON CONFLICT (document_id, version) DO NOTHING;
