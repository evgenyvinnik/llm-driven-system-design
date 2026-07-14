-- Splitwise — Shared Expense Tracking Schema
--
-- Money is stored as INTEGER cents everywhere. Never use floating point for
-- money: 0.1 + 0.2 != 0.3 in IEEE-754, and pennies drift over thousands of
-- expenses. All split math is done on integer cents with explicit remainder
-- distribution so that the sum of splits ALWAYS equals the expense total.

-- ============================================================================
-- USERS
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- GROUPS  (e.g. "Roommates", "Trip to Tahoe")
-- ============================================================================
CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  group_type VARCHAR(30) DEFAULT 'other', -- 'home', 'trip', 'couple', 'other'
  avatar_color VARCHAR(20) DEFAULT 'green',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Group membership (many-to-many). A user must be a member to see or add
-- expenses. 'role' distinguishes the group creator (admin) from members.
CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  role VARCHAR(20) DEFAULT 'member', -- 'admin', 'member'
  joined_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

-- ============================================================================
-- EXPENSES
-- ============================================================================
-- One row per expense. `paid_by` is the single member who fronted the money.
-- `amount_cents` is the total. `split_type` records HOW the total was divided
-- among participants (the per-participant amounts live in expense_splits).
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  description VARCHAR(200) NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency VARCHAR(3) DEFAULT 'USD',
  category VARCHAR(30) DEFAULT 'general',
  paid_by UUID NOT NULL REFERENCES users(id),
  split_type VARCHAR(20) NOT NULL DEFAULT 'equal', -- 'equal', 'exact', 'percentage', 'shares'
  note TEXT,
  created_by UUID REFERENCES users(id),
  idempotency_key VARCHAR(64),
  deleted_at TIMESTAMP, -- soft delete: keeps history/audit intact
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_group ON expenses(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_paid_by ON expenses(paid_by);
-- Idempotency: a retried "add expense" with the same key must not double-insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_idempotency
  ON expenses(created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Per-participant share of an expense. owed_cents is what THIS user owes the
-- payer for THIS expense. INVARIANT: SUM(owed_cents) over an expense's splits
-- equals the expense amount_cents (enforced in application code).
CREATE TABLE IF NOT EXISTS expense_splits (
  expense_id UUID REFERENCES expenses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  owed_cents INTEGER NOT NULL,           -- resolved amount this user owes
  share_units INTEGER,                    -- for split_type='shares'
  percentage NUMERIC(6,3),                -- for split_type='percentage'
  PRIMARY KEY (expense_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_expense_splits_user ON expense_splits(user_id);

-- Comments on an expense (thread of who disputes/notes what)
CREATE TABLE IF NOT EXISTS expense_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID REFERENCES expenses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expense_comments_expense ON expense_comments(expense_id, created_at);

-- ============================================================================
-- SETTLEMENTS  ("I paid you back")
-- ============================================================================
-- A settlement records that `from_user` gave money to `to_user` outside the
-- app (cash, bank transfer). It reduces the debt between the two. Splitwise
-- itself does NOT move money — it only records that money moved.
CREATE TABLE IF NOT EXISTS settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE, -- NULL = direct (non-group) settlement
  from_user UUID NOT NULL REFERENCES users(id),
  to_user UUID NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  note TEXT,
  method VARCHAR(30) DEFAULT 'cash', -- 'cash', 'bank', 'other'
  created_by UUID REFERENCES users(id),
  idempotency_key VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlements_group ON settlements(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_from ON settlements(from_user);
CREATE INDEX IF NOT EXISTS idx_settlements_to ON settlements(to_user);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_idempotency
  ON settlements(created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- ACTIVITY LOG  (feed of expenses + settlements for a group)
-- ============================================================================
CREATE TABLE IF NOT EXISTS activity_log (
  id BIGSERIAL PRIMARY KEY,
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id),
  type VARCHAR(30) NOT NULL, -- 'expense_added', 'expense_deleted', 'settlement', 'group_created', 'member_added'
  expense_id UUID REFERENCES expenses(id) ON DELETE SET NULL,
  settlement_id UUID REFERENCES settlements(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_group ON activity_log(group_id, created_at DESC);

-- ============================================================================
-- AUDIT LOG  (security / compliance trail)
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_id UUID,
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(30),
  resource_id UUID,
  ip_address INET,
  request_id VARCHAR(50),
  details JSONB,
  outcome VARCHAR(20) NOT NULL DEFAULT 'success'
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, timestamp DESC);
