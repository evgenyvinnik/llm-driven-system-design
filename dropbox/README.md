# Dropbox - Cloud Storage

## Overview

A cloud file storage and synchronization service with file chunking, deduplication, versioning, and sharing capabilities.

## Key Features

- File upload/download with chunking support
- Folder hierarchy and navigation
- File versioning with restore capability
- Share files via public links (with password, expiration, download limits)
- Share folders with specific users (view/edit permissions)
- Sync status tracking
- Admin dashboard with system stats and deduplication metrics
- Real-time sync notifications via WebSocket

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer (PostgreSQL + MinIO)
- [x] API endpoints
- [x] Frontend file browser
- [ ] Testing
- [ ] Performance optimization
- [ ] Desktop sync client

## Tech Stack

**Backend:**
- Node.js + Express + TypeScript
- PostgreSQL for metadata
- MinIO (S3-compatible) for file chunks
- Redis for sessions and caching

**Frontend:**
- React 19 + TypeScript
- Vite
- TanStack Router
- Zustand for state management
- Tailwind CSS

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### Option 1: Using Docker (Recommended)

Start all infrastructure services:

```bash
# Start PostgreSQL, Redis, and MinIO
docker-compose up -d

# Wait for services to be ready (about 30 seconds)
```

MinIO Console will be available at http://localhost:9001 (login: minioadmin / minioadmin123)

### Option 2: Native Services

If you prefer running services natively:

**PostgreSQL:**
```bash
# Install PostgreSQL 16
brew install postgresql@16  # macOS
# or use your system's package manager

# Create database
createdb dropbox
psql dropbox < backend/init.sql
```

**Redis:**
```bash
# Install Redis
brew install redis  # macOS
redis-server
```

**MinIO:**
```bash
# Install MinIO
brew install minio/stable/minio  # macOS

# Run MinIO
minio server ~/minio-data --console-address ":9001"

# Create bucket using mc client
mc alias set myminio http://localhost:9000 minioadmin minioadmin123
mc mb myminio/dropbox-chunks
```

### Installation

```bash
# Install backend dependencies
cd backend
cp .env.example .env  # Configure if needed
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### Running the Service

**Start the backend:**
```bash
cd backend
npm run dev          # Single instance on port 3000
# Or run multiple instances:
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

**Start the frontend:**
```bash
cd frontend
npm run dev  # Runs on http://localhost:5173
```

### Demo Accounts

After starting the services, you can log in with:

- **Admin:** admin@dropbox.local / admin123
- **User:** demo@dropbox.local / demo123

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Files
- `GET /api/files/folder` - Get root folder contents
- `GET /api/files/folder/:folderId` - Get folder contents
- `POST /api/files/folder` - Create folder
- `POST /api/files/upload` - Upload file (simple)
- `POST /api/files/upload/init` - Initialize chunked upload
- `POST /api/files/upload/chunk` - Upload chunk
- `POST /api/files/upload/complete` - Complete upload
- `GET /api/files/file/:fileId` - Get file info
- `GET /api/files/file/:fileId/download` - Download file
- `PATCH /api/files/file/:fileId/rename` - Rename file/folder
- `PATCH /api/files/file/:fileId/move` - Move file/folder
- `DELETE /api/files/file/:fileId` - Delete file/folder
- `GET /api/files/file/:fileId/versions` - Get version history
- `POST /api/files/file/:fileId/versions/:versionId/restore` - Restore version

### Sharing
- `POST /api/share/link` - Create share link
- `GET /api/share/links` - Get user's share links
- `DELETE /api/share/link/:linkId` - Delete share link
- `GET /api/share/:token` - Access shared file
- `GET /api/share/:token/download` - Download shared file
- `POST /api/share/folder` - Share folder with user
- `GET /api/share/shared-with-me` - Get folders shared with me
- `GET /api/share/folder/:folderId` - Get folder shares
- `DELETE /api/share/folder/:folderId/:userId` - Remove folder share

### Admin
- `GET /api/admin/stats` - Get system statistics
- `GET /api/admin/users` - Get all users
- `GET /api/admin/users/:userId` - Get user details
- `PATCH /api/admin/users/:userId/quota` - Update user quota
- `DELETE /api/admin/users/:userId` - Delete user
- `GET /api/admin/activity` - Get recent activity
- `GET /api/admin/storage/breakdown` - Get storage by file type
- `POST /api/admin/maintenance/cleanup` - Clean orphaned chunks

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

### Key Design Decisions

1. **File Chunking:** Files are split into 4MB chunks for:
   - Resume interrupted uploads
   - Deduplication across users
   - Delta sync (only upload changed chunks)
   - Parallel upload/download

2. **Deduplication:** Chunks are identified by SHA-256 hash. Same content = same chunk stored once, saving storage.

3. **Versioning:** Each file edit creates a new version. Old versions are preserved with their chunk references.

4. **Storage Separation:**
   - Metadata in PostgreSQL (fast queries, ACID)
   - File chunks in MinIO (scalable object storage)
   - Sessions in Redis (fast lookups, TTL)

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Future Enhancements

- [ ] Desktop sync client with file system watcher
- [ ] Content-defined chunking (Rabin fingerprinting)
- [ ] End-to-end encryption option
- [ ] File previews (images, PDFs, documents)
- [ ] Search functionality
- [ ] Trash/recycle bin
- [ ] Team workspaces
- [ ] Activity logs and audit trail
- [ ] Bandwidth throttling
- [ ] Conflict resolution for collaborative editing
