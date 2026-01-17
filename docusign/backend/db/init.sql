-- DocuSign Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(200) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(30) DEFAULT 'user', -- 'user', 'admin'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Sessions table
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Envelopes (signing packages)
CREATE TABLE envelopes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id UUID REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  status VARCHAR(30) DEFAULT 'draft', -- 'draft', 'sent', 'delivered', 'signed', 'declined', 'voided', 'completed'
  authentication_level VARCHAR(30) DEFAULT 'email', -- 'email', 'sms', 'knowledge', 'id_verification'
  message TEXT,
  expiration_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Recipients
CREATE TABLE recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  envelope_id UUID REFERENCES envelopes(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) NOT NULL,
  role VARCHAR(50) DEFAULT 'signer', -- 'signer', 'cc', 'in_person'
  routing_order INTEGER DEFAULT 1,
  status VARCHAR(30) DEFAULT 'pending', -- 'pending', 'sent', 'delivered', 'completed', 'declined'
  access_token VARCHAR(255) UNIQUE,
  access_code VARCHAR(100),
  phone VARCHAR(50),
  ip_address VARCHAR(50),
  user_agent TEXT,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Documents
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  envelope_id UUID REFERENCES envelopes(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  page_count INTEGER,
  s3_key VARCHAR(500) NOT NULL,
  status VARCHAR(30) DEFAULT 'processing', -- 'processing', 'ready', 'error'
  file_size INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Document Fields
CREATE TABLE document_fields (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL, -- 'signature', 'initial', 'date', 'text', 'checkbox'
  page_number INTEGER NOT NULL,
  x DECIMAL NOT NULL,
  y DECIMAL NOT NULL,
  width DECIMAL NOT NULL,
  height DECIMAL NOT NULL,
  required BOOLEAN DEFAULT TRUE,
  completed BOOLEAN DEFAULT FALSE,
  value TEXT,
  signature_id UUID,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Signatures
CREATE TABLE signatures (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
  field_id UUID REFERENCES document_fields(id) ON DELETE CASCADE,
  s3_key VARCHAR(500) NOT NULL,
  type VARCHAR(30) NOT NULL, -- 'draw', 'typed', 'upload'
  ip_address VARCHAR(50),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Add foreign key for signature_id in document_fields
ALTER TABLE document_fields
ADD CONSTRAINT fk_signature
FOREIGN KEY (signature_id) REFERENCES signatures(id);

-- Audit Events (append-only)
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  envelope_id UUID REFERENCES envelopes(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  data JSONB,
  timestamp TIMESTAMP NOT NULL,
  actor VARCHAR(100),
  previous_hash VARCHAR(64) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Email notifications (simulated)
CREATE TABLE email_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
  envelope_id UUID REFERENCES envelopes(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- 'signing_request', 'reminder', 'completed', 'declined', 'voided'
  subject VARCHAR(255),
  body TEXT,
  status VARCHAR(30) DEFAULT 'pending', -- 'pending', 'sent', 'failed'
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Templates
CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id UUID REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  document_s3_key VARCHAR(500),
  fields JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_envelopes_sender ON envelopes(sender_id);
CREATE INDEX idx_envelopes_status ON envelopes(status);
CREATE INDEX idx_recipients_envelope ON recipients(envelope_id);
CREATE INDEX idx_recipients_email ON recipients(email);
CREATE INDEX idx_recipients_token ON recipients(access_token);
CREATE INDEX idx_documents_envelope ON documents(envelope_id);
CREATE INDEX idx_fields_document ON document_fields(document_id);
CREATE INDEX idx_fields_recipient ON document_fields(recipient_id);
CREATE INDEX idx_audit_envelope ON audit_events(envelope_id, timestamp);
CREATE INDEX idx_audit_type ON audit_events(event_type);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Create default admin user (password: admin123)
INSERT INTO users (email, name, password_hash, role) VALUES
('admin@docusign.local', 'Admin User', '$2b$10$rQZ5C7E6f2FwHKxkJ8VZ5eQz5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5', 'admin');

-- Create test users (password: test123)
INSERT INTO users (email, name, password_hash, role) VALUES
('alice@example.com', 'Alice Johnson', '$2b$10$rQZ5C7E6f2FwHKxkJ8VZ5eQz5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5', 'user'),
('bob@example.com', 'Bob Smith', '$2b$10$rQZ5C7E6f2FwHKxkJ8VZ5eQz5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5', 'user'),
('carol@example.com', 'Carol Williams', '$2b$10$rQZ5C7E6f2FwHKxkJ8VZ5eQz5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5', 'user');
