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
      {"id":"el-1","type":"rectangle","x":560,"y":140,"width":220,"height":90,"strokeColor":"#1971c2","fillColor":"#a5d8ff","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000000},
      {"id":"el-2","type":"text","x":600,"y":175,"width":140,"height":30,"text":"Client (Browser)","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000001},
      {"id":"el-3","type":"arrow","x":670,"y":230,"width":0,"height":80,"points":[{"x":0,"y":0},{"x":0,"y":80}],"strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000002},
      {"id":"el-4","type":"rectangle","x":560,"y":310,"width":220,"height":90,"strokeColor":"#e8590c","fillColor":"#ffd8a8","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000003},
      {"id":"el-5","type":"text","x":610,"y":345,"width":120,"height":30,"text":"API Gateway","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000004},
      {"id":"el-6","type":"arrow","x":670,"y":400,"width":0,"height":80,"points":[{"x":0,"y":0},{"x":0,"y":80}],"strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000005},
      {"id":"el-7","type":"rectangle","x":420,"y":480,"width":200,"height":90,"strokeColor":"#2f9e44","fillColor":"#b2f2bb","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000006},
      {"id":"el-8","type":"text","x":470,"y":515,"width":110,"height":30,"text":"Auth Service","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000007},
      {"id":"el-9","type":"rectangle","x":720,"y":480,"width":200,"height":90,"strokeColor":"#2f9e44","fillColor":"#b2f2bb","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000008},
      {"id":"el-10","type":"text","x":760,"y":515,"width":120,"height":30,"text":"Order Service","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000009},
      {"id":"el-11","type":"ellipse","x":740,"y":630,"width":160,"height":90,"strokeColor":"#5f3dc4","fillColor":"#d0bfff","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000010},
      {"id":"el-12","type":"text","x":780,"y":665,"width":90,"height":30,"text":"Postgres","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000011},
      {"id":"el-13","type":"arrow","x":820,"y":570,"width":0,"height":60,"points":[{"x":0,"y":0},{"x":0,"y":60}],"strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000000012}
    ]'::jsonb,
    true
  ),
  (
    'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a',
    'Wireframe Sketch',
    'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    '[
      {"id":"el-20","type":"rectangle","x":520,"y":120,"width":360,"height":560,"strokeColor":"#868e96","fillColor":"#f8f9fa","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000001000},
      {"id":"el-21","type":"rectangle","x":540,"y":140,"width":320,"height":50,"strokeColor":"#868e96","fillColor":"#dee2e6","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000001001},
      {"id":"el-22","type":"text","x":660,"y":152,"width":80,"height":30,"text":"Header","strokeColor":"#495057","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000001002},
      {"id":"el-23","type":"rectangle","x":540,"y":210,"width":320,"height":180,"strokeColor":"#868e96","fillColor":"#e7f5ff","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000001003},
      {"id":"el-24","type":"text","x":650,"y":290,"width":100,"height":30,"text":"Hero Image","strokeColor":"#495057","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000001004},
      {"id":"el-25","type":"rectangle","x":540,"y":410,"width":150,"height":100,"strokeColor":"#868e96","fillColor":"#dee2e6","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000001005},
      {"id":"el-26","type":"rectangle","x":710,"y":410,"width":150,"height":100,"strokeColor":"#868e96","fillColor":"#dee2e6","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","updatedAt":1700000001006}
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
      {"id":"el-30","type":"ellipse","x":560,"y":160,"width":150,"height":90,"strokeColor":"#c92a2a","fillColor":"#ffc9c9","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002000},
      {"id":"el-31","type":"text","x":600,"y":195,"width":70,"height":20,"text":"Client","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002001},
      {"id":"el-32","type":"line","x":710,"y":205,"width":180,"height":0,"points":[{"x":0,"y":0},{"x":180,"y":0}],"strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002002},
      {"id":"el-33","type":"diamond","x":890,"y":150,"width":150,"height":110,"strokeColor":"#e67700","fillColor":"#ffec99","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002003},
      {"id":"el-34","type":"text","x":920,"y":195,"width":90,"height":20,"text":"Load Bal.","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002004},
      {"id":"el-35","type":"line","x":965,"y":260,"width":-180,"height":140,"points":[{"x":0,"y":0},{"x":-180,"y":140}],"strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002005},
      {"id":"el-36","type":"line","x":965,"y":260,"width":180,"height":140,"points":[{"x":0,"y":0},{"x":180,"y":140}],"strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002006},
      {"id":"el-37","type":"rectangle","x":700,"y":400,"width":160,"height":80,"strokeColor":"#1971c2","fillColor":"#a5d8ff","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002007},
      {"id":"el-38","type":"text","x":740,"y":430,"width":80,"height":20,"text":"Node A","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002008},
      {"id":"el-39","type":"rectangle","x":1060,"y":400,"width":160,"height":80,"strokeColor":"#1971c2","fillColor":"#a5d8ff","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002009},
      {"id":"el-40","type":"text","x":1100,"y":430,"width":80,"height":20,"text":"Node B","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000002010}
    ]'::jsonb,
    true
  ),
  (
    'f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8a9b0c',
    'Brainstorm Notes',
    'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    '[
      {"id":"el-50","type":"text","x":560,"y":140,"width":220,"height":40,"text":"Main Ideas","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":28,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000003000},
      {"id":"el-51","type":"rectangle","x":540,"y":210,"width":240,"height":90,"strokeColor":"#1971c2","fillColor":"#d0ebff","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000003001},
      {"id":"el-52","type":"text","x":580,"y":245,"width":160,"height":20,"text":"Real-time sync","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000003002},
      {"id":"el-53","type":"rectangle","x":820,"y":210,"width":240,"height":90,"strokeColor":"#2f9e44","fillColor":"#b2f2bb","strokeWidth":2,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000003003},
      {"id":"el-54","type":"text","x":860,"y":245,"width":160,"height":20,"text":"Offline support","strokeColor":"#1e1e1e","fillColor":"transparent","strokeWidth":1,"opacity":1,"fontSize":16,"version":1,"isDeleted":false,"createdBy":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","updatedAt":1700000003004}
    ]'::jsonb,
    false
  );

-- Bob is a collaborator on Alice's System Architecture drawing
INSERT INTO drawing_collaborators (drawing_id, user_id, permission) VALUES
  ('c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', 'edit');

-- Alice is a collaborator on Bob's Network Diagram
INSERT INTO drawing_collaborators (drawing_id, user_id, permission) VALUES
  ('e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'edit');
