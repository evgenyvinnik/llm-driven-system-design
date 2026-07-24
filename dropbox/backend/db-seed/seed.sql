-- Seed data for development/testing

-- Insert default admin user (password: admin123)
INSERT INTO users (email, password_hash, name, role, quota_bytes)
VALUES ('admin@dropbox.local', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Admin User', 'admin', 10737418240);

-- Insert demo user (password: demo123)
INSERT INTO users (email, password_hash, name, role, quota_bytes)
VALUES ('demo@dropbox.local', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Demo User', 'user', 2147483648);

-- ============================================================
-- SAMPLE FILE TREE for admin@dropbox.local so the file browser,
-- shared view, and admin storage stats show a real hierarchy.
-- Folders + file metadata only (no chunk bytes) — enough for the
-- listing UI; downloads would need chunks, which the UI doesn't hit.
-- ============================================================
DO $$
DECLARE
  uid UUID;
  docs UUID; photos UUID; projects UUID;
BEGIN
  SELECT id INTO uid FROM users WHERE email = 'admin@dropbox.local';
  IF uid IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM files WHERE user_id = uid) THEN RETURN; END IF;

  -- Top-level folders
  INSERT INTO files (id, user_id, parent_id, name, is_folder, size, mime_type)
  VALUES (uuid_generate_v4(), uid, NULL, 'Documents', true, 0, NULL) RETURNING id INTO docs;
  INSERT INTO files (id, user_id, parent_id, name, is_folder, size, mime_type)
  VALUES (uuid_generate_v4(), uid, NULL, 'Photos', true, 0, NULL) RETURNING id INTO photos;
  INSERT INTO files (id, user_id, parent_id, name, is_folder, size, mime_type)
  VALUES (uuid_generate_v4(), uid, NULL, 'Projects', true, 0, NULL) RETURNING id INTO projects;

  -- Root-level files
  INSERT INTO files (user_id, parent_id, name, is_folder, size, mime_type, content_hash) VALUES
    (uid, NULL, 'Getting Started.pdf', false, 248021, 'application/pdf', 'seed-hash-0001'),
    (uid, NULL, 'Budget 2026.xlsx', false, 51242, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'seed-hash-0002');

  -- Documents/
  INSERT INTO files (user_id, parent_id, name, is_folder, size, mime_type, content_hash) VALUES
    (uid, docs, 'Q3 Report.docx', false, 184320, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'seed-hash-0003'),
    (uid, docs, 'Meeting Notes.md', false, 4096, 'text/markdown', 'seed-hash-0004'),
    (uid, docs, 'Contract.pdf', false, 512000, 'application/pdf', 'seed-hash-0005');

  -- Photos/
  INSERT INTO files (user_id, parent_id, name, is_folder, size, mime_type, content_hash) VALUES
    (uid, photos, 'sunset.jpg', false, 3145728, 'image/jpeg', 'seed-hash-0006'),
    (uid, photos, 'team-offsite.png', false, 2097152, 'image/png', 'seed-hash-0007'),
    (uid, photos, 'diagram.png', false, 819200, 'image/png', 'seed-hash-0008');

  -- Projects/
  INSERT INTO files (user_id, parent_id, name, is_folder, size, mime_type, content_hash) VALUES
    (uid, projects, 'design-mockup.fig', false, 6291456, 'application/octet-stream', 'seed-hash-0009'),
    (uid, projects, 'demo.mp4', false, 52428800, 'video/mp4', 'seed-hash-0010'),
    (uid, projects, 'README.md', false, 2048, 'text/markdown', 'seed-hash-0011');

  -- Keep the user's storage meter honest with the files just seeded.
  UPDATE users
  SET used_bytes = (SELECT COALESCE(SUM(size), 0) FROM files WHERE user_id = uid AND NOT is_folder)
  WHERE id = uid;
END $$;
