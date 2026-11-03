-- AI chat schema. Every statement is idempotent so `npm run db:migrate` can be rerun.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per chat. current_leaf_id is the message the user last looked at;
-- the visible thread is the path from the root to that leaf.
CREATE TABLE IF NOT EXISTS conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title           text NOT NULL DEFAULT 'New chat',
  model           text NOT NULL,
  current_leaf_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

-- The sidebar: a user's chats, most recently active first (keyset pagination on updated_at, id).
CREATE INDEX IF NOT EXISTS conversations_user_recent
  ON conversations (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;

-- Messages form a tree. A user message's parent is the assistant message it
-- answers (NULL for the first message); an assistant message's parent is the
-- user message it answers. Editing a user message adds a sibling under the
-- same parent; regenerating adds an assistant sibling under the same user message.
-- created_at uses clock_timestamp() so a user message and its assistant reply
-- inserted in one transaction still sort in creation order.
CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES messages (id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  -- For assistant messages this is written once, when the generation ends.
  -- While it runs, the partial output lives in generations.output.
  content         text NOT NULL DEFAULT '',
  depth           int  NOT NULL CHECK (depth >= 0),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Children of a node (branch navigation, latest-leaf lookup).
CREATE INDEX IF NOT EXISTS messages_children ON messages (conversation_id, parent_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_current_leaf_fk') THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_current_leaf_fk
      FOREIGN KEY (current_leaf_id) REFERENCES messages (id) ON DELETE SET NULL;
  END IF;
END $$;

-- One attempt at producing one assistant message. The generation outlives the
-- HTTP request that created it: an executor owns it through a lease, live
-- tokens go to a Valkey stream, and output is checkpointed here.
CREATE TABLE IF NOT EXISTS generations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_message_id      uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  assistant_message_id uuid NOT NULL UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('message', 'edit', 'regenerate')),
  model                text NOT NULL,
  status               text NOT NULL DEFAULT 'accepted'
                       CHECK (status IN ('accepted', 'running', 'completed', 'cancelled', 'failed')),
  -- Client-supplied, one per user action. A retried POST with the same key
  -- returns this generation instead of asking the model for a new answer.
  idempotency_key      text NOT NULL,
  request_hash         text NOT NULL,
  -- Incremented by each executor claim; every executor write is fenced on it.
  attempt              int  NOT NULL DEFAULT 0,
  lease_owner          text,
  lease_expires_at     timestamptz,
  -- Partial output as of checkpoint_event_id (a Valkey stream entry ID), then the final output.
  output               text NOT NULL DEFAULT '',
  checkpoint_event_id  text,
  checkpointed_at      timestamptz,
  output_truncated     boolean NOT NULL DEFAULT false,
  finish_reason        text,
  error_code           text,
  error_message        text,
  input_tokens         int,
  output_tokens        int,
  context_messages     int,
  context_dropped      int,
  created_at           timestamptz NOT NULL DEFAULT now(),
  enqueued_at          timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  first_token_at       timestamptz,
  finished_at          timestamptz,
  cancel_requested_at  timestamptz,
  UNIQUE (user_id, idempotency_key)
);

-- At most one in-flight generation per conversation: two devices submitting at
-- once get one generation and one 409 that points at it. The API checks first
-- under a row lock; this index is the backstop.
CREATE UNIQUE INDEX IF NOT EXISTS generations_one_active_per_conversation
  ON generations (conversation_id) WHERE status IN ('accepted', 'running');

-- Sweeper and per-user active caps.
CREATE INDEX IF NOT EXISTS generations_active ON generations (status, lease_expires_at)
  WHERE status IN ('accepted', 'running');
CREATE INDEX IF NOT EXISTS generations_user_active ON generations (user_id)
  WHERE status IN ('accepted', 'running');
CREATE INDEX IF NOT EXISTS generations_recent ON generations (created_at DESC);
