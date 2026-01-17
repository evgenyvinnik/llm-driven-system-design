-- Add archival support columns to posts and comments
-- These columns support the data lifecycle management system

-- Add archived_at to track when content was archived
ALTER TABLE posts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;

-- Add is_archived flag for faster filtering
ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;

-- Index for filtering out archived content
CREATE INDEX IF NOT EXISTS idx_posts_not_archived ON posts(subreddit_id, hot_score DESC)
  WHERE is_archived = FALSE;

CREATE INDEX IF NOT EXISTS idx_comments_not_archived ON comments(post_id)
  WHERE is_archived = FALSE;
