-- File system: namespace, quotas and backups. Every statement is idempotent, so
-- `npm run db:migrate` is safe to rerun.

CREATE TABLE IF NOT EXISTS fs_users (
  id         TEXT PRIMARY KEY,
  capacity   BIGINT NOT NULL CHECK (capacity >= 0),
  -- Total size of the files this user owns. Changed in the same transaction as
  -- every file it counts, and the CHECK makes an over-capacity commit impossible.
  used       BIGINT NOT NULL DEFAULT 0 CHECK (used >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fs_users_used_within_capacity CHECK (used <= capacity)
);

-- One row per namespace entry. Files and directories share the primary key, so a
-- path is a file or a directory, never both, even under concurrent writes.
-- COLLATE "C" sorts by bytes, which matches the spec's code-unit order, and lets
-- the primary-key B-tree serve prefix (LIKE 'x%') scans.
CREATE TABLE IF NOT EXISTS fs_nodes (
  path       TEXT COLLATE "C" PRIMARY KEY,
  parent     TEXT COLLATE "C" NOT NULL,
  name       TEXT COLLATE "C" NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
  -- A file's size, or the total size of every file below a directory.
  size       BIGINT NOT NULL CHECK (size >= 0),
  -- 1 for a file; for a directory, the files anywhere below it. A directory row
  -- is deleted when this reaches 0: directories are implicit.
  file_count BIGINT NOT NULL DEFAULT 1 CHECK (file_count >= 0),
  owner_id   TEXT REFERENCES fs_users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fs_nodes_dirs_unowned CHECK (kind = 'file' OR owner_id IS NULL)
);

-- listDir: children of one directory, already in name order.
CREATE INDEX IF NOT EXISTS fs_nodes_parent_idx ON fs_nodes (parent, name);
-- mergeUsers, backupUser, restoreUser: one user's files.
CREATE INDEX IF NOT EXISTS fs_nodes_owner_idx ON fs_nodes (owner_id) WHERE kind = 'file';
-- largest: walk files biggest-first and stop after n matches of the prefix.
CREATE INDEX IF NOT EXISTS fs_nodes_largest_idx ON fs_nodes (size DESC, path) WHERE kind = 'file';

-- One backup per user; taking a new one replaces it.
CREATE TABLE IF NOT EXISTS fs_backups (
  user_id    TEXT PRIMARY KEY REFERENCES fs_users (id) ON DELETE CASCADE,
  file_count INTEGER NOT NULL DEFAULT 0,
  bytes      BIGINT NOT NULL DEFAULT 0,
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fs_backup_files (
  user_id TEXT NOT NULL REFERENCES fs_backups (user_id) ON DELETE CASCADE,
  path    TEXT COLLATE "C" NOT NULL,
  size    BIGINT NOT NULL,
  PRIMARY KEY (user_id, path)
);
