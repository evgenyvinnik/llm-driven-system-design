# Design LinkedIn - Professional Social Network

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,378 |
| Source Files | 48 |
| .ts | 2,898 |
| .tsx | 2,376 |
| .md | 703 |
| .sql | 171 |
| .json | 118 |

## Overview

A simplified LinkedIn-like platform demonstrating professional social graphs, connection recommendations, feed ranking, and job matching algorithms. This educational project focuses on building a professional networking system with sophisticated recommendation engines.

## Key Features

### 1. Professional Profiles
- Work history and education
- Skills and endorsements
- Profile completeness scoring

### 2. Connection Graph
- First, second, third-degree connections
- Connection requests and acceptance
- Mutual connections display
- "People You May Know" (PYMK) recommendations

### 3. Feed & Content
- Professional posts with rich content
- Engagement (likes, comments)
- Feed ranking algorithm based on engagement, recency, and relationship

### 4. Job Matching
- Job listings with requirements and salary ranges
- Candidate-job matching score based on skills, experience, location
- Application tracking
- Recommended jobs for users

### 5. Company Pages
- Company profiles with industry and size
- Job postings per company

## Tech Stack

- **Frontend:** TypeScript + Vite + React 19 + TanStack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL
- **Cache:** Redis
- **Search:** Elasticsearch
- **Containerization:** Docker Compose

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
# Start PostgreSQL, Redis, and Elasticsearch
docker-compose up -d

# Wait for services to be healthy (about 30 seconds)
docker-compose ps
```

### 2. Setup Backend

```bash
cd backend

# Install dependencies
npm install

# Seed the database with test data
npm run seed

# Start the development server
npm run dev
```

The backend will be available at http://localhost:3001

### 3. Setup Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start the development server
npm run dev
```

The frontend will be available at http://localhost:5173

## Demo Accounts

All demo accounts use the password: `password123`

| Email | Role | Description |
|-------|------|-------------|
| alice@example.com | Admin | Senior Software Engineer at TechCorp |
| bob@example.com | User | Product Manager at DataFlow |
| carol@example.com | User | Data Scientist at CloudScale |
| david@example.com | User | Engineering Lead at TechCorp |
| emma@example.com | User | Frontend Developer at StartupXYZ |
| frank@example.com | User | Backend Engineer at CloudScale |
| grace@example.com | User | DevOps Engineer at DataFlow |
| henry@example.com | User | Solutions Architect at GlobalBank |

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Users/Profiles
- `GET /api/users/:id` - Get user profile with experience, education, skills
- `PATCH /api/users/me` - Update own profile
- `GET /api/users?q=query` - Search users
- `POST /api/users/me/experiences` - Add experience
- `POST /api/users/me/education` - Add education
- `POST /api/users/me/skills` - Add skill
- `POST /api/users/:id/skills/:skillId/endorse` - Endorse a skill

### Connections
- `GET /api/connections` - Get my connections
- `GET /api/connections/requests` - Get pending requests
- `POST /api/connections/request` - Send connection request
- `POST /api/connections/requests/:id/accept` - Accept request
- `POST /api/connections/requests/:id/reject` - Reject request
- `DELETE /api/connections/:userId` - Remove connection
- `GET /api/connections/degree/:userId` - Get connection degree
- `GET /api/connections/mutual/:userId` - Get mutual connections
- `GET /api/connections/second-degree` - Get 2nd degree connections
- `GET /api/connections/pymk` - Get People You May Know recommendations

### Feed
- `GET /api/feed` - Get feed (posts from connections)
- `POST /api/feed` - Create post
- `GET /api/feed/:id` - Get single post
- `DELETE /api/feed/:id` - Delete post
- `POST /api/feed/:id/like` - Like post
- `DELETE /api/feed/:id/like` - Unlike post
- `GET /api/feed/:id/comments` - Get comments
- `POST /api/feed/:id/comments` - Add comment
- `GET /api/feed/user/:userId` - Get user's posts

### Jobs
- `GET /api/jobs` - List/search jobs
- `GET /api/jobs/recommended` - Get recommended jobs
- `GET /api/jobs/:id` - Get job details
- `POST /api/jobs/:id/apply` - Apply for job
- `GET /api/jobs/my/applications` - Get my applications
- `GET /api/jobs/companies` - List companies
- `POST /api/jobs` - Create job (admin only)
- `POST /api/jobs/companies` - Create company (admin only)

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

### Running Multiple Backend Instances

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

### Environment Variables

Create a `.env` file in the backend directory:

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=linkedin
DB_USER=linkedin
DB_PASSWORD=linkedin_password

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Elasticsearch
ELASTICSEARCH_URL=http://localhost:9200

# Session
SESSION_SECRET=your-secret-key

# Frontend URL (for CORS)
FRONTEND_URL=http://localhost:5173
```

## Key Technical Challenges

1. **Connection Degrees**: Efficiently computing 2nd and 3rd degree connections using recursive CTEs
2. **People You May Know**: Multi-factor scoring based on mutual connections, shared companies, schools, skills, and location
3. **Feed Ranking**: Balancing recency, relevance (connection degree), and engagement signals
4. **Job Matching**: Multi-factor scoring based on skill match, experience level, location, and company connections

## Development Insights

See [claude.md](./claude.md) for development insights and design decisions.

## References & Inspiration

- [LinkedIn Engineering Blog](https://engineering.linkedin.com/blog) - Official engineering blog with deep dives into LinkedIn's infrastructure
- [Building the LinkedIn Economic Graph](https://engineering.linkedin.com/blog/2016/10/building-the-linkedin-economic-graph) - How LinkedIn models the global economy as a graph
- [People You May Know: A Social Network Friend Recommendation System](https://dl.acm.org/doi/10.1145/1772690.1772698) - ACM paper on friend recommendation algorithms used at LinkedIn
- [Whom to Follow on Twitter](https://dl.acm.org/doi/10.1145/2433396.2433405) - Research paper on recommendation systems applicable to professional networks
- [LinkedIn's Real-time Graph Partitioning](https://engineering.linkedin.com/blog/2020/graph-interest-cohort) - Scaling graph processing for billions of connections
- [Feed Ranking at LinkedIn](https://engineering.linkedin.com/blog/2021/feed-curation-infrastructure) - How LinkedIn curates and ranks feed content
- [Galene: LinkedIn's Search Architecture](https://engineering.linkedin.com/search/galene-linkedins-search-architecture) - LinkedIn's approach to search across the economic graph
