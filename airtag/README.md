# Design AirTag - Item Tracking System

## Overview

A simplified AirTag-like platform demonstrating Bluetooth item tracking, crowd-sourced location, and the Find My network. This educational project focuses on building a privacy-preserving tracking system using billions of Apple devices as location reporters.

## Key Features

### 1. Item Tracking
- Register and manage multiple devices (AirTags, iPhones, MacBooks, etc.)
- View last known location on interactive map
- Location history with timeline visualization
- Play sound on device (simulated)

### 2. Find My Network (Simulated)
- Privacy-preserving location reports with encryption
- Crowd-sourced location updates
- Key rotation for identity privacy
- Encrypted location storage

### 3. Privacy Protection
- End-to-end encrypted location data
- Rotating identifiers (15-minute rotation)
- Only device owner can decrypt locations
- Server cannot see actual locations

### 4. Lost Mode
- Enable lost mode for missing devices
- Set contact information and custom message
- Get notified when device is found
- NFC tap for info (conceptual)

### 5. Anti-Stalking Protection
- Detect unknown trackers traveling with you
- Alert when suspicious patterns detected
- View sighting history for unknown trackers

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + Zustand + Tailwind CSS + Leaflet
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL (data storage) + Redis (sessions)

## Project Structure

```
airtag/
├── backend/
│   ├── src/
│   │   ├── db/           # Database connections and schema
│   │   ├── middleware/   # Express middleware (auth)
│   │   ├── routes/       # API route handlers
│   │   ├── services/     # Business logic
│   │   ├── types/        # TypeScript definitions
│   │   ├── utils/        # Crypto utilities
│   │   └── index.ts      # Express app entry point
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── services/     # API client
│   │   ├── stores/       # Zustand state
│   │   ├── types/        # TypeScript definitions
│   │   ├── App.tsx       # Main app component
│   │   └── main.tsx      # Entry point
│   ├── package.json
│   └── vite.config.ts
├── docker-compose.yml    # PostgreSQL + Redis
├── architecture.md       # System design documentation
├── CLAUDE.md             # Development notes
└── README.md             # This file
```

## Quick Start

### Option 1: Docker Setup (Recommended)

1. **Start the infrastructure:**
   ```bash
   cd airtag
   docker-compose up -d
   ```
   This starts PostgreSQL (port 5432) and Redis (port 6379).

2. **Install and start the backend:**
   ```bash
   cd backend
   npm install
   npm run dev
   ```
   Backend runs on http://localhost:3000

3. **Install and start the frontend:**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   Frontend runs on http://localhost:5173

### Option 2: Native Services

If you prefer running PostgreSQL and Redis natively:

1. **PostgreSQL:**
   ```bash
   # macOS with Homebrew
   brew install postgresql@16
   brew services start postgresql@16

   # Create database
   createdb findmy
   psql findmy -c "CREATE USER findmy WITH PASSWORD 'findmy_secret';"
   psql findmy -c "GRANT ALL PRIVILEGES ON DATABASE findmy TO findmy;"

   # Initialize schema
   psql -U findmy -d findmy -f backend/src/db/init.sql
   ```

2. **Redis:**
   ```bash
   # macOS with Homebrew
   brew install redis
   brew services start redis
   ```

3. **Start backend and frontend as above.**

## Usage

### Getting Started

1. Open http://localhost:5173 in your browser
2. Create a new account or sign in
3. Add your first device (AirTag, iPhone, etc.)
4. Click on the map to simulate location reports
5. Enable Lost Mode to get notifications when found

### Simulating Locations

Since this is a demo without actual Bluetooth hardware:
- Click anywhere on the map to simulate a location report from the Find My network
- The location will be encrypted and stored, then decrypted for display
- Multiple clicks create a location history trail

### Admin Features

If you sign in as an admin (role: 'admin'):
- Access the Admin Dashboard tab
- View system statistics
- Monitor lost devices
- Track anti-stalking alerts

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create new account
- `POST /api/auth/login` - Sign in
- `POST /api/auth/logout` - Sign out
- `GET /api/auth/me` - Get current user

### Devices
- `GET /api/devices` - List user's devices
- `POST /api/devices` - Register new device
- `GET /api/devices/:id` - Get device details
- `PATCH /api/devices/:id` - Update device
- `DELETE /api/devices/:id` - Remove device
- `POST /api/devices/:id/play-sound` - Play sound (simulated)

### Locations
- `GET /api/locations/:deviceId` - Get location history
- `GET /api/locations/:deviceId/latest` - Get latest location
- `POST /api/locations/:deviceId/simulate` - Simulate location report
- `POST /api/locations/report` - Submit encrypted location report

### Lost Mode
- `GET /api/lost-mode/:deviceId` - Get lost mode settings
- `PUT /api/lost-mode/:deviceId` - Update lost mode
- `POST /api/lost-mode/:deviceId/enable` - Quick enable
- `POST /api/lost-mode/:deviceId/disable` - Disable

### Notifications
- `GET /api/notifications` - Get notifications
- `GET /api/notifications/unread-count` - Get unread count
- `POST /api/notifications/:id/read` - Mark as read
- `POST /api/notifications/read-all` - Mark all read

### Anti-Stalking
- `POST /api/anti-stalking/sighting` - Record tracker sighting
- `GET /api/anti-stalking/unknown-trackers` - Get detected trackers
- `GET /api/anti-stalking/sightings/:hash` - Get sighting history

### Admin (requires admin role)
- `GET /api/admin/stats` - System statistics
- `GET /api/admin/users` - All users
- `GET /api/admin/devices` - All devices
- `GET /api/admin/lost-devices` - Devices in lost mode

## Key Technical Concepts

### Privacy-Preserving Location

The system demonstrates how Apple's Find My network maintains privacy:

1. **Rotating Keys:** Device keys rotate every 15 minutes
2. **Encrypted Reports:** Locations are encrypted with device's public key
3. **Server Blindness:** Server stores encrypted blobs it cannot decrypt
4. **Owner Decryption:** Only the owner (with master secret) can decrypt

### Anti-Stalking Detection

The system detects potential stalking by:

1. Recording sightings of unknown trackers
2. Analyzing patterns (distance traveled, time span)
3. Alerting when thresholds exceeded (3+ sightings, >500m travel)
4. Providing sighting history and disabling instructions

## Development

### Running Multiple Backend Instances

For testing distributed scenarios:
```bash
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

### Environment Variables

Backend:
- `PORT` - Server port (default: 3000)
- `POSTGRES_HOST` - PostgreSQL host (default: localhost)
- `POSTGRES_PORT` - PostgreSQL port (default: 5432)
- `POSTGRES_DB` - Database name (default: findmy)
- `POSTGRES_USER` - Database user (default: findmy)
- `POSTGRES_PASSWORD` - Database password (default: findmy_secret)
- `REDIS_HOST` - Redis host (default: localhost)
- `REDIS_PORT` - Redis port (default: 6379)
- `SESSION_SECRET` - Session secret (change in production)
- `CORS_ORIGIN` - Allowed CORS origin (default: http://localhost:5173)

## Implementation Status

- [x] Device registration and management
- [x] Location encryption and decryption
- [x] Map visualization with Leaflet
- [x] Location history and timeline
- [x] Lost mode with notifications
- [x] Anti-stalking detection
- [x] Admin dashboard
- [x] Session-based authentication
- [ ] Real Bluetooth beacon support
- [ ] UWB precision finding
- [ ] Push notifications

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [CLAUDE.md](./CLAUDE.md) for development insights and design decisions.
