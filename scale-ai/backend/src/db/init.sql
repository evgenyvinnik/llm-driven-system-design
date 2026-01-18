-- init.sql
-- Consolidated database schema for Scale AI - Data Labeling & ML Training Platform
-- This file contains all tables, indexes, constraints, and seed data
--
-- Consolidated from migrations:
--   001_create_users.sql
--   002_create_shapes.sql
--   003_create_drawings.sql
--   004_create_training_jobs.sql
--   005_create_models.sql
--   006_create_admin_users.sql
--   007_add_deleted_at_to_drawings.sql
--
-- Usage: psql -h localhost -U user -d scale_ai -f init.sql

-- ============================================================================
-- EXTENSIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- TABLES
-- ============================================================================

-- Users table for session tracking (anonymous or authenticated)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    total_drawings INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Shape definitions for the drawing game
CREATE TABLE shapes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    difficulty INT DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Drawing submissions from users
CREATE TABLE drawings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    shape_id INT REFERENCES shapes(id) ON DELETE CASCADE,
    stroke_data_path VARCHAR(500) NOT NULL,  -- Path in MinIO
    metadata JSONB DEFAULT '{}',  -- canvas size, duration, stroke count, device type
    quality_score FLOAT CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 1),
    is_flagged BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL  -- Soft delete timestamp - NULL means not deleted
);

-- Training job management
CREATE TABLE training_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled')),
    config JSONB DEFAULT '{}',  -- hyperparameters, data filters, epochs
    error_message TEXT,
    progress JSONB DEFAULT '{}',  -- current_epoch, total_epochs, current_loss, phase
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    metrics JSONB,  -- accuracy, loss, confusion matrix
    model_path VARCHAR(500),  -- Path in MinIO when completed
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trained model versions
CREATE TABLE models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    training_job_id UUID REFERENCES training_jobs(id) ON DELETE CASCADE,
    version VARCHAR(50) NOT NULL,
    is_active BOOLEAN DEFAULT FALSE,
    accuracy FLOAT CHECK (accuracy IS NULL OR accuracy BETWEEN 0 AND 1),
    model_path VARCHAR(500) NOT NULL,  -- Path in MinIO
    config JSONB DEFAULT '{}',  -- Model architecture details
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Admin users with email/password authentication
CREATE TABLE admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Users indexes
CREATE INDEX idx_users_session ON users(session_id);
CREATE INDEX idx_users_role ON users(role);

-- Drawings indexes
CREATE INDEX idx_drawings_shape ON drawings(shape_id);
CREATE INDEX idx_drawings_user ON drawings(user_id);
CREATE INDEX idx_drawings_created ON drawings(created_at DESC);
CREATE INDEX idx_drawings_quality ON drawings(quality_score) WHERE quality_score IS NOT NULL;
CREATE INDEX idx_drawings_flagged ON drawings(is_flagged) WHERE is_flagged = TRUE;
CREATE INDEX idx_drawings_deleted_at ON drawings(deleted_at);

-- Training jobs indexes
CREATE INDEX idx_training_jobs_status ON training_jobs(status);
CREATE INDEX idx_training_jobs_created ON training_jobs(created_at DESC);

-- Models indexes
-- Ensure only one active model at a time
CREATE UNIQUE INDEX idx_models_active ON models(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_models_version ON models(version);
CREATE INDEX idx_models_created ON models(created_at DESC);

-- Admin users indexes
CREATE INDEX idx_admin_users_email ON admin_users(email);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE users IS 'Users table for session tracking (anonymous or authenticated)';
COMMENT ON TABLE shapes IS 'Shape definitions for the drawing game';
COMMENT ON TABLE drawings IS 'Drawing submissions from users';
COMMENT ON TABLE training_jobs IS 'Training job management';
COMMENT ON TABLE models IS 'Trained model versions';
COMMENT ON TABLE admin_users IS 'Admin users with email/password authentication';

COMMENT ON COLUMN drawings.stroke_data_path IS 'Path to stroke data JSON in MinIO object storage';
COMMENT ON COLUMN drawings.metadata IS 'Canvas size, duration, stroke count, device type';
COMMENT ON COLUMN drawings.deleted_at IS 'Soft delete timestamp - NULL means not deleted';
COMMENT ON COLUMN training_jobs.config IS 'Training hyperparameters, data filters, epochs';
COMMENT ON COLUMN training_jobs.metrics IS 'Training metrics: accuracy, loss, confusion matrix';
COMMENT ON COLUMN models.config IS 'Model architecture details';

-- Note: Run `npm run db:seed-admin` after initialization to create default admin user
-- Seed data is in seed.sql

