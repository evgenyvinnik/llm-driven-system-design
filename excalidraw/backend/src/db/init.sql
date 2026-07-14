-- Excalidraw Collaborative Whiteboard Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    avatar_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drawings table
CREATE TABLE IF NOT EXISTS drawings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL DEFAULT 'Untitled',
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    elements JSONB DEFAULT '[]'::jsonb,
    app_state JSONB DEFAULT '{}'::jsonb,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drawing collaborators
CREATE TABLE IF NOT EXISTS drawing_collaborators (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(10) NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'edit')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(drawing_id, user_id)
);

-- Drawing versions (snapshots for undo/history)
CREATE TABLE IF NOT EXISTS drawing_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    elements JSONB NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Operations log (for CRDT merge and conflict resolution)
CREATE TABLE IF NOT EXISTS operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_type VARCHAR(10) NOT NULL CHECK (operation_type IN ('add', 'update', 'delete', 'move')),
    element_id VARCHAR(255) NOT NULL,
    element_data JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_drawings_owner_id ON drawings(owner_id);
CREATE INDEX IF NOT EXISTS idx_drawings_is_public ON drawings(is_public);
CREATE INDEX IF NOT EXISTS idx_drawing_collaborators_drawing_id ON drawing_collaborators(drawing_id);
CREATE INDEX IF NOT EXISTS idx_drawing_collaborators_user_id ON drawing_collaborators(user_id);
CREATE INDEX IF NOT EXISTS idx_drawing_versions_drawing_id ON drawing_versions(drawing_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_operations_drawing_id ON operations(drawing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operations_element_id ON operations(drawing_id, element_id);
