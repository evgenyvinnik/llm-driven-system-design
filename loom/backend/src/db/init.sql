CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- status: uploading -> processing -> ready, or uploading -> failed.
-- 'processing' videos are already playable from the uploaded source; the worker
-- adds a seekable rendition, the probed duration and a thumbnail.
CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  duration_seconds INTEGER,
  status VARCHAR(20) DEFAULT 'uploading',
  storage_path TEXT,        -- object served for playback
  source_path TEXT,         -- original upload, kept for reprocessing
  thumbnail_path TEXT,
  file_size_bytes BIGINT,
  view_count INTEGER DEFAULT 0,
  upload_id TEXT,           -- open S3 multipart upload, cleared on completion
  upload_activity_at TIMESTAMPTZ, -- last part URL issued; the sweeper's staleness clock
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT videos_status_check CHECK (status IN ('uploading', 'processing', 'ready', 'failed'))
);

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) NOT NULL,
  content TEXT NOT NULL,
  timestamp_seconds FLOAT, -- null = general comment, non-null = time-anchored
  parent_id UUID REFERENCES comments(id) ON DELETE CASCADE, -- deleting a comment removes its replies
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE NOT NULL,
  token VARCHAR(64) UNIQUE NOT NULL,
  password_hash VARCHAR(255), -- optional password protection
  expires_at TIMESTAMPTZ,
  allow_download BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One row per playback session. The client generates the id, so heartbeats for the
-- same session upsert one row instead of appending duplicates.
CREATE TABLE IF NOT EXISTS view_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE NOT NULL,
  viewer_id UUID REFERENCES users(id),
  session_id VARCHAR(64),
  watch_duration_seconds INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL,
  name VARCHAR(255) NOT NULL,
  parent_id UUID REFERENCES folders(id) ON DELETE CASCADE, -- subfolders go with their parent
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_folders (
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, folder_id)
);

-- Background work for a video (one row per video and kind). The worker claims rows
-- with FOR UPDATE SKIP LOCKED under a lease; attempts doubles as a fencing token.
CREATE TABLE IF NOT EXISTS video_jobs (
  id BIGSERIAL PRIMARY KEY,
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL DEFAULT 'process_upload',
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT video_jobs_status_check CHECK (status IN ('queued', 'running', 'done', 'dead')),
  CONSTRAINT video_jobs_video_kind_key UNIQUE (video_id, kind)
);

-- Upgrades for databases created before the multipart upload pipeline (2026-10).
-- Every statement is a no-op when the schema above already has it.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS source_path TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS upload_id TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS upload_activity_at TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE videos ALTER COLUMN status SET DEFAULT 'uploading';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'videos_status_check') THEN
    ALTER TABLE videos ADD CONSTRAINT videos_status_check
      CHECK (status IN ('uploading', 'processing', 'ready', 'failed'));
  END IF;
  -- Older volumes created the reply FK without a cascade, so deleting a comment that
  -- had replies failed with a foreign-key violation.
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'comments_parent_id_fkey' AND confdeltype <> 'c') THEN
    ALTER TABLE comments DROP CONSTRAINT comments_parent_id_fkey;
    ALTER TABLE comments ADD CONSTRAINT comments_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE;
  END IF;
  -- Same for nested folders: deleting a folder with subfolders used to fail.
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'folders_parent_id_fkey' AND confdeltype <> 'c') THEN
    ALTER TABLE folders DROP CONSTRAINT folders_parent_id_fkey;
    ALTER TABLE folders ADD CONSTRAINT folders_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
CREATE INDEX IF NOT EXISTS idx_shares_video ON shares(video_id);
CREATE INDEX IF NOT EXISTS idx_view_events_video ON view_events(video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_view_events_viewer ON view_events(viewer_id);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_videos_uploading ON videos(upload_activity_at) WHERE status = 'uploading';
CREATE INDEX IF NOT EXISTS idx_video_jobs_runnable ON video_jobs(run_after) WHERE status IN ('queued', 'running');
