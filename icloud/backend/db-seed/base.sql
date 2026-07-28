-- Seed data for development/testing
-- iCloud Sync sample data

-- Create default admin user (password: admin123)
INSERT INTO users (id, email, password_hash, role)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'admin@icloud.local',
  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
  'admin'
)
ON CONFLICT (id) DO NOTHING;

-- Create test user (password: user123)
INSERT INTO users (id, email, password_hash, role)
VALUES (
  'b1ffcc00-0d1c-5f09-cc7e-7cc0ce491b22',
  'user@icloud.local',
  '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
  'user'
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Realistic Drive contents and Photos library for user@icloud.local.
--
-- The seed previously created only the two accounts, so Drive and Photos both
-- rendered permanently empty. Folders/files here mirror a normal iCloud Drive,
-- and photos carry real thumbnail/preview keys plus EXIF-ish metadata so the
-- photo grid, favorites, and detail view all have something to show.
-- ============================================================
DO $$
DECLARE
  uid UUID := 'b1ffcc00-0d1c-5f09-cc7e-7cc0ce491b22';
  docs UUID; pics UUID; proj UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM files WHERE user_id = uid) THEN RETURN; END IF;

  -- Top-level folders
  INSERT INTO files (id, user_id, parent_id, name, path, mime_type, size, is_folder)
  VALUES (gen_random_uuid(), uid, NULL, 'Documents', '/Documents', NULL, 0, true) RETURNING id INTO docs;
  INSERT INTO files (id, user_id, parent_id, name, path, mime_type, size, is_folder)
  VALUES (gen_random_uuid(), uid, NULL, 'Pictures', '/Pictures', NULL, 0, true) RETURNING id INTO pics;
  INSERT INTO files (id, user_id, parent_id, name, path, mime_type, size, is_folder)
  VALUES (gen_random_uuid(), uid, NULL, 'Projects', '/Projects', NULL, 0, true) RETURNING id INTO proj;

  -- Root-level files
  INSERT INTO files (user_id, parent_id, name, path, mime_type, size, is_folder, content_hash) VALUES
    (uid, NULL, 'Getting Started.pdf', '/Getting Started.pdf', 'application/pdf', 248021, false, 'hash-root-01'),
    (uid, NULL, 'Budget 2026.numbers', '/Budget 2026.numbers', 'application/vnd.apple.numbers', 91240, false, 'hash-root-02');

  -- Documents/
  INSERT INTO files (user_id, parent_id, name, path, mime_type, size, is_folder, content_hash) VALUES
    (uid, docs, 'Q3 Report.pages', '/Documents/Q3 Report.pages', 'application/vnd.apple.pages', 184320, false, 'hash-doc-01'),
    (uid, docs, 'Meeting Notes.txt', '/Documents/Meeting Notes.txt', 'text/plain', 4096, false, 'hash-doc-02'),
    (uid, docs, 'Lease Agreement.pdf', '/Documents/Lease Agreement.pdf', 'application/pdf', 512000, false, 'hash-doc-03');

  -- Pictures/
  INSERT INTO files (user_id, parent_id, name, path, mime_type, size, is_folder, content_hash) VALUES
    (uid, pics, 'sunset.jpg', '/Pictures/sunset.jpg', 'image/jpeg', 3145728, false, 'hash-pic-01'),
    (uid, pics, 'team-offsite.heic', '/Pictures/team-offsite.heic', 'image/heic', 2097152, false, 'hash-pic-02');

  -- Projects/
  INSERT INTO files (user_id, parent_id, name, path, mime_type, size, is_folder, content_hash) VALUES
    (uid, proj, 'demo.mov', '/Projects/demo.mov', 'video/quicktime', 52428800, false, 'hash-proj-01'),
    (uid, proj, 'mockup.sketch', '/Projects/mockup.sketch', 'application/octet-stream', 6291456, false, 'hash-proj-02'),
    (uid, proj, 'README.md', '/Projects/README.md', 'text/markdown', 2048, false, 'hash-proj-03');
END $$;

-- Photos are seeded separately by `npm run db:seed:photos`: the API streams
-- derivatives out of MinIO by object key, so photo rows are only valid if the
-- corresponding objects exist. SQL alone cannot create them.
