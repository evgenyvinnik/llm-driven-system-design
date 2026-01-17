# Design iCloud Sync - File and Photo Synchronization

## Overview

A simplified iCloud-like platform demonstrating file synchronization, conflict resolution, and cross-device consistency. This educational project focuses on building a sync service that handles photos, documents, and app data across devices.

## Key Features

### 1. File Synchronization
- Bidirectional sync with version vectors
- Delta sync (only upload/download changed chunks)
- Chunk-based file transfer with deduplication
- Real-time sync notifications via WebSocket

### 2. Conflict Resolution
- Version vector-based conflict detection
- Automatic merge when possible
- Conflict copies for manual resolution
- Full version history

### 3. Photo Library
- Full-resolution cloud storage
- Automatic thumbnail and preview generation
- Optimized device storage
- Album management

### 4. Multi-Device Support
- Device registration and management
- Per-device sync state tracking
- Cross-device real-time notifications
- Sync history per device

### 5. Admin Dashboard
- System-wide statistics
- User management
- Sync operation monitoring
- Storage optimization tools

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Cache:** Redis
- **Object Storage:** MinIO (S3-compatible)
- **Real-time:** WebSocket

## Implementation Status

- [x] Initial architecture design
- [x] File metadata sync
- [x] Chunk-based upload/download
- [x] Conflict detection with version vectors
- [x] Photo library sync with derivatives
- [x] Multi-device state management
- [x] Admin dashboard
- [x] Documentation

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose

### 1. Start Infrastructure

```bash
cd icloud
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- MinIO on ports 9000 (API) and 9001 (Console)

MinIO Console: http://localhost:9001 (admin: minioadmin / minioadmin123)

### 2. Start Backend

```bash
cd backend
npm install
npm run dev
```

Backend runs on http://localhost:3001

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on http://localhost:5173

### Demo Accounts

- **Admin:** admin@icloud.local / admin123
- **User:** user@icloud.local / user123

## Project Structure

```
icloud/
├── docker-compose.yml     # PostgreSQL, Redis, MinIO
├── backend/
│   ├── package.json
│   ├── db/
│   │   └── init.sql       # Database schema
│   └── src/
│       ├── index.js       # Express server
│       ├── db.js          # Database connections
│       ├── middleware/
│       │   └── auth.js    # Session authentication
│       ├── routes/
│       │   ├── auth.js    # Login/register/logout
│       │   ├── files.js   # File CRUD operations
│       │   ├── sync.js    # Sync protocol endpoints
│       │   ├── photos.js  # Photo management
│       │   ├── devices.js # Device management
│       │   └── admin.js   # Admin operations
│       └── services/
│           ├── chunks.js  # Chunk storage service
│           ├── sync.js    # Sync logic with version vectors
│           └── websocket.js # Real-time notifications
└── frontend/
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── router.tsx     # Tanstack Router setup
        ├── components/
        │   ├── FileBrowser.tsx
        │   ├── PhotoGallery.tsx
        │   ├── AdminDashboard.tsx
        │   └── Icons.tsx
        ├── routes/
        │   ├── LoginPage.tsx
        │   ├── RegisterPage.tsx
        │   ├── DrivePage.tsx
        │   ├── PhotosPage.tsx
        │   └── AdminPage.tsx
        ├── stores/
        │   ├── authStore.ts
        │   ├── fileStore.ts
        │   └── photoStore.ts
        ├── services/
        │   ├── api.ts
        │   └── websocket.ts
        └── types/
            └── index.ts
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Create account
- `POST /api/v1/auth/login` - Sign in
- `POST /api/v1/auth/logout` - Sign out
- `GET /api/v1/auth/me` - Get current user

### Files
- `GET /api/v1/files` - List files in folder
- `GET /api/v1/files/:id` - Get file metadata
- `POST /api/v1/files/folder` - Create folder
- `POST /api/v1/files/upload` - Upload file
- `GET /api/v1/files/:id/download` - Download file
- `PATCH /api/v1/files/:id` - Rename/move file
- `DELETE /api/v1/files/:id` - Delete file
- `GET /api/v1/files/:id/versions` - Get version history

### Sync
- `GET /api/v1/sync/state` - Get device sync state
- `GET /api/v1/sync/changes` - Get changes since last sync
- `POST /api/v1/sync/push` - Push local changes
- `GET /api/v1/sync/conflicts` - Get unresolved conflicts
- `POST /api/v1/sync/resolve-conflict` - Resolve conflict
- `POST /api/v1/sync/delta` - Get delta for file
- `GET /api/v1/sync/chunk/:hash` - Download chunk

### Photos
- `GET /api/v1/photos` - List photos
- `POST /api/v1/photos/upload` - Upload photo
- `GET /api/v1/photos/:id/thumbnail` - Get thumbnail
- `GET /api/v1/photos/:id/preview` - Get preview
- `GET /api/v1/photos/:id/full` - Get full resolution
- `POST /api/v1/photos/:id/favorite` - Toggle favorite
- `DELETE /api/v1/photos/:id` - Delete photo
- `GET /api/v1/photos/albums` - List albums
- `POST /api/v1/photos/albums` - Create album

### Devices
- `GET /api/v1/devices` - List devices
- `POST /api/v1/devices` - Register device
- `DELETE /api/v1/devices/:id` - Remove device
- `GET /api/v1/devices/:id/sync-history` - Get sync history

### Admin
- `GET /api/v1/admin/stats` - System statistics
- `GET /api/v1/admin/users` - List users
- `PATCH /api/v1/admin/users/:id` - Update user
- `GET /api/v1/admin/sync-operations` - Recent operations
- `GET /api/v1/admin/conflicts` - All conflicts
- `POST /api/v1/admin/cleanup-chunks` - Cleanup orphaned chunks
- `POST /api/v1/admin/purge-deleted` - Purge deleted files

## Key Design Decisions

### Version Vectors for Conflict Detection
Each file maintains a version vector `{deviceId: sequenceNumber}` that tracks modifications from each device. When syncing, we compare vectors to detect:
- **Local newer:** Local has higher sequence for some device
- **Server newer:** Server has higher sequence for some device
- **Conflict:** Both have changes not seen by the other

### Chunk-Based Storage
Files are split into 4MB chunks identified by SHA-256 hash. This enables:
- **Deduplication:** Same chunk stored once across all files
- **Delta sync:** Only download/upload changed chunks
- **Resumable transfers:** Resume interrupted uploads/downloads

### Photo Derivatives
Photos are stored in multiple resolutions:
- **Full resolution:** Original quality in MinIO
- **Preview (1024px):** For viewing in app
- **Thumbnail (200px):** For grid display

Devices can choose to store only thumbnails locally and download full resolution on demand.

## Running Multiple Backend Instances

For testing distributed scenarios:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
