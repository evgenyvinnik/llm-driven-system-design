CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  industry VARCHAR(100),
  website VARCHAR(255),
  phone VARCHAR(50),
  address_street TEXT,
  address_city VARCHAR(100),
  address_state VARCHAR(100),
  address_country VARCHAR(100),
  annual_revenue_cents BIGINT,
  employee_count INTEGER,
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  title VARCHAR(100),
  department VARCHAR(100),
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  amount_cents BIGINT,
  stage VARCHAR(50) DEFAULT 'Prospecting',
  probability INTEGER DEFAULT 10,
  close_date DATE,
  description TEXT,
  owner_id UUID REFERENCES users(id),
  -- Stamped by the API on entering Closed Won/Lost, cleared on reopening.
  -- Revenue is booked by this, not updated_at (which moves on any edit).
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT opportunities_stage_check CHECK (stage IN (
    'Prospecting', 'Qualification', 'Needs Analysis', 'Proposal',
    'Negotiation', 'Closed Won', 'Closed Lost')),
  CONSTRAINT opportunities_probability_check CHECK (probability BETWEEN 0 AND 100),
  CONSTRAINT opportunities_amount_check CHECK (amount_cents >= 0)
);

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  company VARCHAR(255),
  title VARCHAR(100),
  source VARCHAR(50),
  status VARCHAR(30) DEFAULT 'New',
  -- SET NULL: deleting an account/contact/opportunity created by a conversion
  -- must not be blocked by the lead that produced it (it used to fail with an
  -- FK violation, a 500, for every converted record).
  converted_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  converted_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  converted_opportunity_id UUID REFERENCES opportunities(id) ON DELETE SET NULL,
  converted_at TIMESTAMPTZ,
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT leads_status_check CHECK (status IN ('New', 'Contacted', 'Qualified', 'Unqualified', 'Converted')),
  -- 'Converted' and converted_at go together: only the conversion transaction sets either.
  CONSTRAINT leads_converted_check CHECK ((status = 'Converted') = (converted_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(20) NOT NULL, -- 'call', 'email', 'meeting', 'note'
  subject VARCHAR(255) NOT NULL,
  description TEXT,
  due_date TIMESTAMPTZ,
  completed BOOLEAN DEFAULT false,
  related_type VARCHAR(20), -- 'account', 'contact', 'opportunity', 'lead'
  related_id UUID,
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(30) NOT NULL, -- 'account', 'contact', 'opportunity', 'lead'
  field_name VARCHAR(100) NOT NULL,
  field_type VARCHAR(20) NOT NULL, -- 'text', 'number', 'date', 'boolean', 'select'
  options JSONB, -- for select type
  is_required BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(entity_type, field_name)
);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID REFERENCES custom_fields(id) ON DELETE CASCADE NOT NULL,
  entity_id UUID NOT NULL,
  value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(field_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_account ON opportunities(account_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage ON opportunities(stage);
CREATE INDEX IF NOT EXISTS idx_opportunities_owner ON opportunities(owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_activities_related ON activities(related_type, related_id);
CREATE INDEX IF NOT EXISTS idx_activities_owner ON activities(owner_id, due_date);
CREATE INDEX IF NOT EXISTS idx_custom_field_values_entity ON custom_field_values(entity_id);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_id);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id);

-- ---------------------------------------------------------------------------
-- Upgrades for databases created from an earlier version of this file.
-- CREATE TABLE IF NOT EXISTS skips existing tables, so new columns and
-- constraints are added here, idempotently. CHECKs are added NOT VALID: they
-- apply to every new write without failing the migration on old rows.
-- ---------------------------------------------------------------------------
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
UPDATE opportunities SET closed_at = updated_at
  WHERE closed_at IS NULL AND stage IN ('Closed Won', 'Closed Lost');
-- After the ADD COLUMN: on an upgraded database the column doesn't exist above.
CREATE INDEX IF NOT EXISTS idx_opportunities_closed ON opportunities(stage, closed_at);

DO $$
DECLARE
  fk RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunities_stage_check') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_stage_check CHECK (stage IN (
      'Prospecting', 'Qualification', 'Needs Analysis', 'Proposal',
      'Negotiation', 'Closed Won', 'Closed Lost')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunities_probability_check') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_probability_check
      CHECK (probability BETWEEN 0 AND 100) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunities_amount_check') THEN
    ALTER TABLE opportunities ADD CONSTRAINT opportunities_amount_check CHECK (amount_cents >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_status_check') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_status_check
      CHECK (status IN ('New', 'Contacted', 'Qualified', 'Unqualified', 'Converted')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_converted_check') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_converted_check
      CHECK ((status = 'Converted') = (converted_at IS NOT NULL)) NOT VALID;
  END IF;

  -- Re-create the converted_* foreign keys with ON DELETE SET NULL where an
  -- older schema created them with the default (NO ACTION).
  FOR fk IN
    SELECT c.conname, a.attname AS col, cl.relname AS target
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_class cl ON cl.oid = c.confrelid
    WHERE c.conrelid = 'leads'::regclass AND c.contype = 'f'
      AND a.attname IN ('converted_account_id', 'converted_contact_id', 'converted_opportunity_id')
      AND c.confdeltype <> 'n'
  LOOP
    EXECUTE format('ALTER TABLE leads DROP CONSTRAINT %I', fk.conname);
    EXECUTE format(
      'ALTER TABLE leads ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE SET NULL',
      fk.conname, fk.col, fk.target);
  END LOOP;
END $$;
