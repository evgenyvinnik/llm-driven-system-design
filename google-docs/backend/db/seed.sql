-- Seed data for development/testing
-- Google Docs sample data

INSERT INTO users (id, email, name, password_hash, avatar_color, role) VALUES
('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice Johnson', '$2b$10$rQZ6LM5dv.e/O.G9yLW3ZOqDJCcNX.G9HwD7nHD5Z3yKr8X9aQx8O', '#EF4444', 'user'),
('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob Smith', '$2b$10$rQZ6LM5dv.e/O.G9yLW3ZOqDJCcNX.G9HwD7nHD5Z3yKr8X9aQx8O', '#22C55E', 'user'),
('33333333-3333-3333-3333-333333333333', 'admin@example.com', 'Admin User', '$2b$10$rQZ6LM5dv.e/O.G9yLW3ZOqDJCcNX.G9HwD7nHD5Z3yKr8X9aQx8O', '#8B5CF6', 'admin');

-- Sample documents
INSERT INTO documents (id, title, owner_id, content) VALUES
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Welcome to Google Docs Clone', '11111111-1111-1111-1111-111111111111',
'{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Welcome to Google Docs Clone!"}]},{"type":"paragraph","content":[{"type":"text","text":"This is a collaborative document editor built with:"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Real-time collaboration"},{"type":"text","text":" using Operational Transformation"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Rich text editing"},{"type":"text","text":" with formatting support"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Comments and suggestions"},{"type":"text","text":" for feedback"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Version history"},{"type":"text","text":" to track changes"}]}]}]}]}'),
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Project Planning Document', '22222222-2222-2222-2222-222222222222',
'{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Project Planning"}]},{"type":"paragraph","content":[{"type":"text","text":"Start planning your project here..."}]}]}');

-- Share first document with Bob
INSERT INTO document_permissions (document_id, user_id, permission_level) VALUES
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'edit');
