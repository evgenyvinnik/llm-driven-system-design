-- Kindle Highlights Database Schema
-- Social reading platform with offline-first sync and privacy-thresholded aggregation.
--
-- Re-runnable: every statement is guarded (IF NOT EXISTS / IF EXISTS / DO blocks), and the
-- "Upgrade" blocks migrate databases created by earlier versions of this file.

-- ============================================================================
-- USERS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL, -- scrypt:<salt>:<hash>; legacy unsalted sha256 is upgraded on login
    avatar_url VARCHAR(500),
    bio TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================================
-- BOOKS TABLE
-- ============================================================================
-- Books catalog
CREATE TABLE IF NOT EXISTS books (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(500) NOT NULL,
    author VARCHAR(200),
    isbn VARCHAR(20),
    publisher VARCHAR(200),
    description TEXT,
    cover_url VARCHAR(500),
    total_locations INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);

-- ============================================================================
-- USER_BOOKS TABLE
-- ============================================================================
-- Tracks which books a user has in their library
CREATE TABLE IF NOT EXISTS user_books (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    book_id UUID REFERENCES books(id) ON DELETE CASCADE,
    progress_location INTEGER DEFAULT 0,
    last_read_at TIMESTAMP DEFAULT NOW(),
    added_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, book_id)
);

CREATE INDEX IF NOT EXISTS idx_user_books_user ON user_books(user_id);
CREATE INDEX IF NOT EXISTS idx_user_books_book ON user_books(book_id);

-- ============================================================================
-- HIGHLIGHTS TABLE
-- ============================================================================
-- The id is minted on the device, so it doubles as the idempotency key: a retried
-- upload hits the primary key instead of creating a second highlight.
-- Deleted highlights stay behind as tombstone rows (deleted_at set, content wiped) so the
-- delete flows through the change feed to devices that were offline when it happened.
CREATE TABLE IF NOT EXISTS highlights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    location_start INTEGER NOT NULL,
    location_end INTEGER NOT NULL,
    highlighted_text TEXT NOT NULL,
    note TEXT,
    color VARCHAR(20) DEFAULT 'yellow',
    visibility VARCHAR(20) DEFAULT 'private', -- private, friends, public
    sync_seq BIGINT NOT NULL DEFAULT 0,       -- position of the latest change in the owner's feed
    field_clock JSONB NOT NULL DEFAULT '{}',  -- per-field last-writer-wins stamps {field: {ts, device}}
    deleted_at TIMESTAMPTZ,                   -- tombstone marker
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Upgrade: databases created before the sync rework had an `archived` flag, an unused
-- `synced_at` column and a separate deleted_highlights table instead of tombstone rows.
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS sync_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS field_clock JSONB NOT NULL DEFAULT '{}';
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'highlights' AND column_name = 'archived') THEN
        UPDATE highlights SET deleted_at = updated_at WHERE archived AND deleted_at IS NULL;
        ALTER TABLE highlights DROP COLUMN archived;
    END IF;
END $$;
ALTER TABLE highlights DROP COLUMN IF EXISTS synced_at;
DROP TABLE IF EXISTS deleted_highlights;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'highlights_visibility_check') THEN
        ALTER TABLE highlights ADD CONSTRAINT highlights_visibility_check
            CHECK (visibility IN ('private', 'friends', 'public'));
    END IF;
END $$;

DROP INDEX IF EXISTS idx_highlights_location;
DROP INDEX IF EXISTS idx_highlights_visibility;
CREATE INDEX IF NOT EXISTS idx_highlights_user ON highlights(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_highlights_user_seq ON highlights(user_id, sync_seq);
CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id);
CREATE INDEX IF NOT EXISTS idx_highlights_book_public ON highlights(book_id)
    WHERE visibility = 'public' AND deleted_at IS NULL;

-- ============================================================================
-- USER_SYNC_STATE TABLE
-- ============================================================================
-- One row per user holding the change-sequence counter. Every write to a user's highlights
-- locks this row, so sequence numbers are handed out in commit order: a device whose cursor
-- says "I have everything up to 41" can never miss a change that commits later as 40.
CREATE TABLE IF NOT EXISTS user_sync_state (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_seq BIGINT NOT NULL DEFAULT 0,
    purged_through_seq BIGINT NOT NULL DEFAULT 0 -- tombstones at or below this were reaped
);

-- Upgrade: rows written before the change feed existed (or by hand) have sync_seq = 0, and the
-- feed only returns sync_seq > cursor, so they would never reach a device. Number them into
-- their owner's feed after any existing sequence. Run with the services stopped.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM highlights WHERE sync_seq = 0) THEN
        WITH numbered AS (
            SELECT h.id,
                   COALESCE(s.last_seq, 0)
                     + ROW_NUMBER() OVER (PARTITION BY h.user_id ORDER BY h.updated_at, h.id) AS seq
            FROM highlights h
            LEFT JOIN user_sync_state s ON s.user_id = h.user_id
            WHERE h.sync_seq = 0
        )
        UPDATE highlights h SET sync_seq = numbered.seq FROM numbered WHERE h.id = numbered.id;

        INSERT INTO user_sync_state (user_id, last_seq)
        SELECT user_id, MAX(sync_seq) FROM highlights GROUP BY user_id
        ON CONFLICT (user_id) DO UPDATE SET last_seq = GREATEST(user_sync_state.last_seq, EXCLUDED.last_seq);
    END IF;
END $$;

-- ============================================================================
-- POPULAR_HIGHLIGHTS TABLE
-- ============================================================================
-- Published aggregate, written only by the aggregation worker. A row exists only when at
-- least POPULAR_MIN_READERS distinct consenting readers highlighted the passage, so
-- sub-threshold counts are never stored in the table the API serves from.
CREATE TABLE IF NOT EXISTS popular_highlights (
    book_id UUID REFERENCES books(id) ON DELETE CASCADE,
    passage_id VARCHAR(50), -- normalized location window, e.g. '100-300'
    passage_text TEXT,
    reader_count INTEGER DEFAULT 0, -- distinct readers, not highlights
    location_start INTEGER,
    location_end INTEGER,
    last_contribution_at TIMESTAMPTZ, -- newest contributing highlight (drives "trending")
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (book_id, passage_id)
);

-- Upgrade: the count column used to be called highlight_count and counted raw highlights.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'popular_highlights'
                 AND column_name = 'highlight_count') THEN
        ALTER TABLE popular_highlights RENAME COLUMN highlight_count TO reader_count;
    END IF;
END $$;
ALTER TABLE popular_highlights ADD COLUMN IF NOT EXISTS last_contribution_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_popular_count ON popular_highlights(book_id, reader_count DESC);
CREATE INDEX IF NOT EXISTS idx_popular_recent ON popular_highlights(last_contribution_at DESC);

-- ============================================================================
-- AGGREGATION_OUTBOX TABLE
-- ============================================================================
-- Transactional outbox: any change that can move a book's public counts inserts a row here
-- in the same transaction as the change. The aggregation worker claims rows with
-- FOR UPDATE SKIP LOCKED and recomputes the book, so no change can be lost between
-- "committed" and "counted". Append-only, so a hot book never contends on one row.
CREATE TABLE IF NOT EXISTS aggregation_outbox (
    id BIGSERIAL PRIMARY KEY,
    book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    reason VARCHAR(30) NOT NULL, -- create | visibility | delete | consent | reconcile
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aggregation_outbox_book ON aggregation_outbox(book_id);

-- ============================================================================
-- FOLLOWS TABLE
-- ============================================================================
-- Social follows (directed). "friends" visibility requires a mutual follow.
CREATE TABLE IF NOT EXISTS follows (
    follower_id UUID REFERENCES users(id) ON DELETE CASCADE,
    followee_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

-- ============================================================================
-- USER_PRIVACY_SETTINGS TABLE
-- ============================================================================
-- Privacy settings per user
CREATE TABLE IF NOT EXISTS user_privacy_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    highlight_visibility VARCHAR(20) DEFAULT 'private', -- default for new highlights
    allow_followers BOOLEAN DEFAULT true,
    include_in_aggregation BOOLEAN DEFAULT true,         -- consent to count public highlights
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- HIGHLIGHT_SHARES TABLE
-- ============================================================================
-- Share events (the share endpoint logged into this table before it existed)
CREATE TABLE IF NOT EXISTS highlight_shares (
    id BIGSERIAL PRIMARY KEY,
    highlight_id UUID NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform VARCHAR(30) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_highlight_shares_highlight ON highlight_shares(highlight_id);

-- ============================================================================
-- SESSIONS TABLE
-- ============================================================================
-- Reserved for a durable session store; the services currently keep sessions in Redis only.
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(100) PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
