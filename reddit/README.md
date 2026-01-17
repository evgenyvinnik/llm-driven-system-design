# Design Reddit - Community-Driven Content Platform

## Overview

A simplified Reddit-like platform demonstrating voting systems, nested comments, subreddit isolation, and content ranking algorithms. This educational project focuses on building a community-driven content aggregation system with real-time voting and discussion features.

## Key Features

### 1. Subreddit Management
- Create and manage communities (subreddits)
- Subreddit-specific rules and moderation
- Public, private, and restricted community types
- Subscription and membership tracking

### 2. Post & Voting System
- Submit text posts, links, and media
- Upvote/downvote with score aggregation
- Karma calculation per user
- Vote fraud prevention (rate limiting, detection)

### 3. Nested Comments
- Threaded comment trees with arbitrary depth
- Comment voting and sorting (best, top, new, controversial)
- Collapsed threads and "load more" pagination
- Parent-child relationship management

### 4. Content Ranking Algorithms
- Hot: Time-decay weighted by votes
- Top: Highest score within time range
- New: Chronological ordering
- Controversial: High engagement, balanced votes
- Rising: Rapid vote acceleration

### 5. Moderation Tools
- Remove/approve posts and comments
- Ban users from subreddits
- Automod rules (keyword filtering, spam detection)
- Mod queue and action logs

## Implementation Status

- [ ] Initial architecture design
- [ ] Database schema (users, subreddits, posts, comments, votes)
- [ ] Voting system with score aggregation
- [ ] Nested comment tree implementation
- [ ] Ranking algorithm implementations
- [ ] Subreddit creation and management
- [ ] Basic moderation features
- [ ] Local multi-instance testing
- [ ] Documentation

## Getting Started

*Instructions will be added as the implementation progresses*

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (for PostgreSQL, Valkey)
- Modern web browser

### Installation

```bash
cd reddit
npm install
docker-compose up -d  # Start PostgreSQL, Valkey
npm run db:migrate    # Initialize database schema
```

### Running the Service

```bash
# Run single instance (development)
npm run dev

# Run multiple instances (simulates distribution)
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003
```

## Key Technical Challenges

1. **Vote Counting at Scale**: How to aggregate millions of votes efficiently without locking?
2. **Nested Comment Trees**: How to fetch and render deeply nested threads efficiently?
3. **Hot Algorithm**: Implementing time-decay ranking that balances freshness with quality
4. **Vote Manipulation**: Detecting and preventing coordinated voting attacks
5. **Subreddit Isolation**: Keeping communities separate while enabling cross-posting

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## Example Ranking Algorithms

**Hot Score (simplified Reddit formula):**
```javascript
function hotScore(ups, downs, createdAt) {
  const score = ups - downs
  const order = Math.log10(Math.max(Math.abs(score), 1))
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0
  const seconds = (createdAt - epoch) / 1000
  return sign * order + seconds / 45000
}
```

**Controversial Score:**
```javascript
function controversialScore(ups, downs) {
  const total = ups + downs
  if (total === 0) return 0
  const balance = Math.min(ups, downs) / Math.max(ups, downs)
  return total * balance
}
```

## Future Enhancements

- [ ] User profiles and post history
- [ ] Awards and premium features
- [ ] Real-time notifications
- [ ] Search within subreddits
- [ ] Cross-posting between communities
- [ ] Flair system for posts and users
