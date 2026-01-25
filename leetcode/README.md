# LeetCode - Online Judge

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,694 |
| Source Files | 48 |
| .js | 2,916 |
| .md | 1,577 |
| .tsx | 1,406 |
| .ts | 431 |
| .css | 109 |

## Overview

An online coding practice and evaluation platform where users can solve programming challenges, submit code solutions, and track their progress.

## Key Features

- Problem catalog with descriptions, examples, and constraints
- Code editor with syntax highlighting (Python and JavaScript)
- Sandboxed code execution using Docker containers
- Test case validation with real-time results
- User progress tracking and submission history
- Admin dashboard with system statistics
- Leaderboards

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer (PostgreSQL + Redis)
- [x] API endpoints
- [x] Code execution sandbox
- [x] Rate limiting and abuse prevention
- [x] Circuit breaker for resilience
- [x] Metrics and observability
- [x] Idempotency for submissions
- [x] Virtualized problem list
- [x] Documentation
- [x] Testing (vitest)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- PostgreSQL 16 (via Docker)
- Redis 7 (via Docker)

### Option 1: Docker Setup (Recommended)

1. **Start infrastructure services:**

```bash
cd leetcode
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379

2. **Install backend dependencies:**

```bash
cd backend
npm install
```

3. **Seed the database:**

```bash
npm run seed
```

This creates:
- Admin user: `admin` / `admin123`
- Demo user: `demo` / `user123`
- 15 sample problems across easy, medium, and hard difficulties

4. **Start the backend:**

```bash
npm run dev
```

Backend runs on http://localhost:3001

5. **Install frontend dependencies (new terminal):**

```bash
cd frontend
npm install
```

6. **Start the frontend:**

```bash
npm run dev
```

Frontend runs on http://localhost:5173

### Option 2: Native PostgreSQL/Redis

If you have PostgreSQL and Redis installed locally:

1. Create a database:

```sql
CREATE DATABASE leetcode;
CREATE USER leetcode WITH PASSWORD 'leetcode_pass';
GRANT ALL PRIVILEGES ON DATABASE leetcode TO leetcode;
```

2. Run the init script:

```bash
psql -U leetcode -d leetcode -f backend/src/db/init.sql
```

3. Start Redis:

```bash
redis-server
```

4. Follow steps 2-6 from Docker setup above.

## Project Structure

```
leetcode/
├── backend/
│   ├── src/
│   │   ├── db/           # Database pool, redis, init.sql, seed
│   │   ├── routes/       # API routes (auth, problems, submissions, etc.)
│   │   ├── services/     # Code executor service
│   │   ├── middleware/   # Auth middleware
│   │   └── index.js      # Express server entry point
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/   # Reusable UI components
│   │   ├── pages/        # Page components
│   │   ├── stores/       # Zustand state stores
│   │   ├── services/     # API client
│   │   └── types/        # TypeScript definitions
│   └── package.json
├── sandbox/              # Docker sandbox for code execution
├── docker-compose.yml    # Infrastructure services
└── README.md
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

### Problems
- `GET /api/v1/problems` - List all problems
- `GET /api/v1/problems/:slug` - Get problem details
- `GET /api/v1/problems/:slug/submissions` - Get user's submissions for a problem

### Submissions
- `POST /api/v1/submissions` - Submit code
- `POST /api/v1/submissions/run` - Run code against sample tests
- `GET /api/v1/submissions/:id` - Get submission details
- `GET /api/v1/submissions/:id/status` - Poll submission status

### Users
- `GET /api/v1/users/:id/profile` - Get user profile
- `GET /api/v1/users/:id/submissions` - Get user's submission history
- `GET /api/v1/users/me/progress` - Get current user's progress

### Admin
- `GET /api/v1/admin/stats` - Get system statistics
- `GET /api/v1/admin/users` - List all users
- `GET /api/v1/admin/leaderboard` - Get leaderboard

## Running Multiple Backend Instances

For distributed testing:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Code Execution

The code execution sandbox uses Docker to safely run user-submitted code:

- **Security:** Containers run with dropped capabilities, no network access, read-only filesystem
- **Resource limits:** Memory (256MB), CPU (50%), PIDs (50), time limits
- **Languages:** Python 3.11, JavaScript (Node 20)

To enable code execution, ensure Docker is running and the user has Docker socket access.

## Technology Stack

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS, Zustand, React Router, CodeMirror
- **Backend:** Node.js, Express
- **Database:** PostgreSQL 16
- **Cache/Sessions:** Redis 7
- **Code Execution:** Docker with security restrictions

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and iteration history.

## Implemented Features

- **Rate Limiting**: Protects execution resources
  - 10 submissions/minute per user
  - 30 code runs/minute per user
  - Brute force protection on auth endpoints
- **Circuit Breaker**: Graceful degradation when Docker is unavailable
- **Idempotency**: Prevents duplicate submissions on retry
- **Metrics**: Prometheus-compatible observability
- **Virtualized Lists**: Efficient rendering for large problem catalogs

## Future Enhancements

- Contests with real-time leaderboards
- More language support (C++, Java, Go)
- Code similarity detection for plagiarism
- WebSocket for real-time submission updates
- Queue-based execution for production scale

## References & Inspiration

- [Codeforces Architecture](https://codeforces.com/blog/entry/70) - Mike Mirzayanov on building competitive programming platforms
- [Docker Security Best Practices](https://docs.docker.com/engine/security/) - Container isolation for code execution
- [gVisor: Container Runtime Sandbox](https://gvisor.dev/) - Google's application kernel for sandboxing
- [Firecracker MicroVMs](https://firecracker-microvm.github.io/) - AWS's lightweight virtualization for serverless
- [MOSS (Measure of Software Similarity)](https://theory.stanford.edu/~aiken/moss/) - Stanford's plagiarism detection system
- [Judge0 - Open Source Online Judge](https://github.com/judge0/judge0) - Production-ready code execution system
- [HackerRank Engineering Blog](https://www.hackerrank.com/blog/engineering/) - Insights on online assessment platforms
- [Seccomp and Linux Security Modules](https://man7.org/linux/man-pages/man2/seccomp.2.html) - System call filtering for sandboxing
- [Building a Code Execution Engine](https://blog.remoteinterview.io/how-we-built-a-remote-code-execution-engine/) - Real-world implementation insights
- [Competitive Programming Handbook](https://cses.fi/book/book.pdf) - Understanding competitive programming problem design
