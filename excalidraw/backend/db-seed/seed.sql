-- Seed data for Excalidraw collaborative whiteboard
-- Demo users: alice/password123, bob/password123

-- Password hash for 'password123' (bcrypt, 12 rounds)
-- Generated with: bcryptjs.hashSync('password123', 12)
-- Using a pre-computed hash to avoid runtime dependency
INSERT INTO users (id, username, email, password_hash, display_name) VALUES
  ('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'alice', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Designer'),
  ('b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', 'bob', 'bob@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Artist');

-- Alice's drawings
INSERT INTO drawings (id, title, owner_id, elements, is_public) VALUES
  (
    'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f',
    'System Architecture',
    'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    '[
      {"id":"el-1","type":"rectangle","x":100,"y":100,"width":200,"height":100,"strokeColor":"#1e1e1e","fillColor":"#a5d8ff","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000000},
      {"id":"el-2","type":"text","x":140,"y":135,"width":120,"height":30,"text":"API Gateway","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000001},
      {"id":"el-3","type":"rectangle","x":100,"y":300,"width":200,"height":100,"strokeColor":"#1e1e1e","fillColor":"#b2f2bb","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000002},
      {"id":"el-4","type":"text","x":150,"y":335,"width":100,"height":30,"text":"Database","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000003},
      {"id":"el-5","type":"arrow","x":200,"y":200,"width":0,"height":100,"points":[{"x":0,"y":0},{"x":0,"y":100}],"strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000004}
    ]'::jsonb,
    true
  ),
  (
    'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a',
    'Wireframe Sketch',
    'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    '[
      {"id":"el-10","type":"rectangle","x":50,"y":50,"width":400,"height":600,"strokeColor":"#868e96","fillColor":"#f8f9fa","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000001000},
      {"id":"el-11","type":"rectangle","x":70,"y":70,"width":360,"height":50,"strokeColor":"#868e96","fillColor":"#dee2e6","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000001001},
      {"id":"el-12","type":"text","x":200,"y":80,"width":80,"height":30,"text":"Header","strokeColor":"#495057","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000001002}
    ]'::jsonb,
    false
  );

-- Bob's drawings
INSERT INTO drawings (id, title, owner_id, elements, is_public) VALUES
  (
    'e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b',
    'Network Diagram',
    'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    '[
      {"id":"el-20","type":"ellipse","x":200,"y":200,"width":100,"height":100,"strokeColor":"#1e1e1e","fillColor":"#ffc9c9","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002000},
      {"id":"el-21","type":"text","x":220,"y":240,"width":60,"height":20,"text":"Server","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":14,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002001},
      {"id":"el-22","type":"diamond","x":400,"y":200,"width":100,"height":100,"strokeColor":"#1e1e1e","fillColor":"#ffec99","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002002},
      {"id":"el-23","type":"line","x":300,"y":250,"width":100,"height":0,"points":[{"x":0,"y":0},{"x":100,"y":0}],"strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002003}
    ]'::jsonb,
    true
  ),
  (
    'f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8a9b0c',
    'Brainstorm Notes',
    'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    '[
      {"id":"el-30","type":"text","x":100,"y":100,"width":200,"height":40,"text":"Main Ideas","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":24,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000003000},
      {"id":"el-31","type":"rectangle","x":80,"y":160,"width":240,"height":80,"strokeColor":"#1971c2","fillColor":"#d0ebff","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000003001}
    ]'::jsonb,
    false
  );

-- Bob is a collaborator on Alice's System Architecture drawing
INSERT INTO drawing_collaborators (drawing_id, user_id, permission) VALUES
  ('c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', 'edit');

-- Alice is a collaborator on Bob's Network Diagram
INSERT INTO drawing_collaborators (drawing_id, user_id, permission) VALUES
  ('e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'edit');
