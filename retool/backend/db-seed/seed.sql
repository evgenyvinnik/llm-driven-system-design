-- Seed data for Retool development
-- Users: alice/password123, bob/password123
-- Passwords hashed with bcrypt (10 rounds)

INSERT INTO users (id, username, email, password_hash, display_name, role) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Builder', 'admin'),
  ('b2222222-2222-2222-2222-222222222222', 'bob', 'bob@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Developer', 'user')
ON CONFLICT (username) DO NOTHING;

-- Data source pointing to the target-postgres sample database
INSERT INTO data_sources (id, name, type, config, owner_id) VALUES
  ('d1111111-1111-1111-1111-111111111111', 'Sample E-Commerce DB', 'postgresql',
   '{"host": "localhost", "port": 5433, "database": "sample_db", "user": "sample", "password": "sample123"}',
   'a1111111-1111-1111-1111-111111111111')
ON CONFLICT DO NOTHING;

-- Sample app: Customer Dashboard
-- NOTE: bindings resolve against a query's NAME, not its id. Both QueryPanel
-- and PreviewRenderer store results under `query.name` (see
-- frontend/src/stores/dataStore.ts), so the table below binds to
-- `getCustomers.data`. It previously referenced `query1` — the query's *id* —
-- which resolved to nothing, and the table rendered "No data" in both the
-- editor and preview even though the query itself returned five rows.
INSERT INTO apps (id, name, description, owner_id, components, layout, queries, status) VALUES
  ('e1111111-1111-1111-1111-111111111111',
   'Customer Dashboard',
   'View and search customers from the sample e-commerce database',
   'a1111111-1111-1111-1111-111111111111',
   '[
     {
       "id": "table1",
       "type": "table",
       "props": {
         "data": "{{ getCustomers.data }}",
         "columns": [
           {"key": "id", "label": "ID"},
           {"key": "name", "label": "Name"},
           {"key": "email", "label": "Email"},
           {"key": "phone", "label": "Phone"},
           {"key": "address", "label": "Address"}
         ],
         "pageSize": 10,
         "searchable": true
       },
       "position": {"x": 0, "y": 2, "w": 12, "h": 8},
       "bindings": {"data": "getCustomers.data"}
     },
     {
       "id": "text1",
       "type": "text",
       "props": {
         "value": "Customer Dashboard",
         "fontSize": 24,
         "fontWeight": "bold",
         "color": "#1C1C1E"
       },
       "position": {"x": 0, "y": 0, "w": 12, "h": 2},
       "bindings": {}
     }
   ]',
   '{"columns": 12, "rowHeight": 40}',
   '[
     {
       "id": "query1",
       "name": "getCustomers",
       "dataSourceId": "d1111111-1111-1111-1111-111111111111",
       "queryText": "SELECT * FROM customers ORDER BY id",
       "trigger": "on_load"
     }
   ]',
   'draft')
ON CONFLICT DO NOTHING;
