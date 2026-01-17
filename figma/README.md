# Figma - Collaborative Design and Prototyping Platform

A real-time collaborative design tool with vector graphics editing, inspired by Figma.

## Features

- **Real-time Collaboration**: Multiple users can edit the same design simultaneously
- **Multiplayer Cursors**: See collaborators' cursors and selections in real-time
- **Vector Graphics**: Create rectangles, ellipses, and text objects
- **Layers Panel**: Manage object visibility, locking, and z-order
- **Properties Panel**: Edit object properties including position, size, colors, and opacity
- **Version History**: Save and restore design versions
- **File Management**: Create, browse, and delete design files

## Architecture

The application consists of:

- **Frontend**: React 19 + TypeScript + Vite + Zustand + Tailwind CSS
- **Backend**: Node.js + Express + WebSocket (ws)
- **Database**: PostgreSQL for persistence
- **Cache/Pub-Sub**: Redis for presence updates and real-time coordination

See [architecture.md](./architecture.md) and [system-design-answer.md](./system-design-answer.md) for detailed system design documentation.

## Prerequisites

- Node.js 20+
- Docker and Docker Compose (for running PostgreSQL and Redis)
- Or: PostgreSQL 16+ and Redis 7+ installed locally

## Quick Start with Docker

1. **Start the infrastructure services**:

   ```bash
   docker-compose up -d
   ```

   This starts PostgreSQL (port 5432) and Redis (port 6379).

2. **Install backend dependencies**:

   ```bash
   cd backend
   npm install
   ```

3. **Start the backend server**:

   ```bash
   npm run dev
   ```

   The server runs on http://localhost:3000.

4. **Install frontend dependencies** (in a new terminal):

   ```bash
   cd frontend
   npm install
   ```

5. **Start the frontend**:

   ```bash
   npm run dev
   ```

   The frontend runs on http://localhost:5173.

6. **Open your browser** to http://localhost:5173

## Running with Native Services

If you prefer to run PostgreSQL and Redis natively:

### macOS (with Homebrew)

```bash
# Install services
brew install postgresql@16 redis

# Start services
brew services start postgresql@16
brew services start redis

# Create database and user
createuser -s figma
createdb -O figma figma_db
psql -d figma_db -c "ALTER USER figma WITH PASSWORD 'figma_password';"

# Initialize the database schema
psql -U figma -d figma_db -f backend/src/db/init.sql
```

### Linux (Ubuntu/Debian)

```bash
# Install services
sudo apt update
sudo apt install postgresql postgresql-contrib redis-server

# Start services
sudo systemctl start postgresql
sudo systemctl start redis-server

# Create database and user
sudo -u postgres createuser -s figma
sudo -u postgres createdb -O figma figma_db
sudo -u postgres psql -d figma_db -c "ALTER USER figma WITH PASSWORD 'figma_password';"

# Initialize the database schema
sudo -u postgres psql -U figma -d figma_db -f backend/src/db/init.sql
```

## Environment Variables

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `figma` | PostgreSQL user |
| `DB_PASSWORD` | `figma_password` | PostgreSQL password |
| `DB_NAME` | `figma_db` | PostgreSQL database |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `FRONTEND_URL` | `http://localhost:5173` | CORS origin |

## Running Multiple Backend Instances

For testing distributed scenarios:

```bash
# Terminal 1
cd backend
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

Note: You'll need a load balancer (like nginx) to distribute connections between instances for full distributed testing.

## Project Structure

```
figma/
├── backend/
│   ├── src/
│   │   ├── db/             # Database connections and schema
│   │   ├── routes/         # REST API routes
│   │   ├── services/       # Business logic
│   │   ├── types/          # TypeScript definitions
│   │   ├── websocket/      # WebSocket handler
│   │   └── index.ts        # Main entry point
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── hooks/          # Custom hooks
│   │   ├── services/       # API client
│   │   ├── stores/         # Zustand stores
│   │   └── types/          # TypeScript definitions
│   ├── package.json
│   └── vite.config.ts
├── docker-compose.yml
├── architecture.md
├── system-design-answer.md
├── claude.md
└── README.md
```

## API Endpoints

### REST API

- `GET /api/files` - List all files
- `POST /api/files` - Create a new file
- `GET /api/files/:id` - Get file details
- `PATCH /api/files/:id` - Update file name
- `DELETE /api/files/:id` - Delete a file
- `GET /api/files/:id/versions` - List version history
- `POST /api/files/:id/versions` - Create a named version
- `POST /api/files/:id/versions/:versionId/restore` - Restore a version

### WebSocket (ws://localhost:3000/ws)

- `subscribe` - Join a file editing session
- `unsubscribe` - Leave a file editing session
- `operation` - Send design operations
- `presence` - Send cursor/selection updates
- `sync` - Request current state

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `V` | Select tool |
| `R` | Rectangle tool |
| `O` | Ellipse tool |
| `T` | Text tool |
| `H` | Hand (pan) tool |
| `Delete` / `Backspace` | Delete selected objects |
| `Ctrl/Cmd + D` | Duplicate selected objects |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |

## Development

### Backend

```bash
cd backend
npm run dev         # Start development server
npm run build       # Build for production
npm run lint        # Run linter
npm run type-check  # TypeScript check
```

### Frontend

```bash
cd frontend
npm run dev         # Start development server
npm run build       # Build for production
npm run lint        # Run linter
npm run type-check  # TypeScript check
```

## Testing Real-time Collaboration

1. Open the application in two browser windows
2. Create or select the same file in both
3. You should see:
   - Each user's cursor in a different color
   - Objects created by one user appear for the other
   - Selection highlights visible to collaborators

## Future Enhancements

- [ ] More shape tools (lines, polygons, pen tool)
- [ ] Image upload and embedding
- [ ] Components and instances
- [ ] Prototyping and interactions
- [ ] Comments and feedback
- [ ] Export to PNG/SVG/PDF
- [ ] Offline support with sync
- [ ] Plugin system

## References

- [system-design-answer.md](./system-design-answer.md) - Full system design explanation
- [architecture.md](./architecture.md) - Architecture documentation
- [claude.md](./claude.md) - Development notes and iteration history
