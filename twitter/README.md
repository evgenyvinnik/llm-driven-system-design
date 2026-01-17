# Design Twitter/X - Real-Time Social Platform

## Overview

A simplified Twitter-like platform demonstrating timeline fanout, real-time updates, trend detection, and social graph management. This educational project focuses on building a high-throughput microblogging system with real-time content delivery.

## Key Features

### 1. Tweet Publishing
- Post short-form content (280 characters)
- Attach media (images, videos, links)
- Mention users with @username
- Hashtag support for topic discovery

### 2. Timeline Generation
- Home timeline (posts from followed users)
- User profile timeline (user's own posts)
- Fanout strategies (push vs pull)
- Algorithmic vs chronological ordering

### 3. Social Graph
- Follow/unfollow users
- Follower/following counts
- Mutual followers detection
- Follow recommendations

### 4. Real-Time Features
- Live timeline updates
- Notifications (mentions, likes, retweets)
- Typing indicators (for DMs)
- Live engagement counts

### 5. Trending Topics
- Hashtag frequency tracking
- Geographic trend detection
- Time-windowed analysis
- Trend velocity calculation

## Implementation Status

- [ ] Initial architecture design
- [ ] Database schema (users, tweets, follows, likes)
- [ ] Tweet creation and storage
- [ ] Timeline fanout implementation
- [ ] Follow graph management
- [ ] Trend detection system
- [ ] Real-time notifications
- [ ] Local multi-instance testing
- [ ] Documentation

## Getting Started

*Instructions will be added as the implementation progresses*

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (for PostgreSQL, Valkey, Kafka)
- Modern web browser

### Installation

```bash
cd twitter
npm install
docker-compose up -d  # Start PostgreSQL, Valkey, Kafka
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

# Run fanout workers
npm run dev:fanout
```

## Key Technical Challenges

1. **Fanout at Scale**: How to deliver tweets to millions of followers efficiently?
2. **Celebrity Problem**: Users with 50M followers vs users with 50 followers
3. **Timeline Consistency**: Ensuring users see tweets in correct order
4. **Trend Detection**: Real-time analysis of hashtag velocity
5. **Graph Queries**: Efficient follower/following lookups

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## Fanout Strategies

**Push (Fanout on Write):**
```javascript
// When user tweets, write to all follower timelines
async function tweet(userId, content) {
  const tweetId = await db.createTweet(userId, content)
  const followers = await db.getFollowers(userId)

  for (const followerId of followers) {
    await cache.lpush(`timeline:${followerId}`, tweetId)
  }
}
```

**Pull (Fanout on Read):**
```javascript
// When user views timeline, fetch from followed users
async function getTimeline(userId) {
  const following = await db.getFollowing(userId)
  const tweets = await db.getTweetsByUsers(following, { limit: 100 })
  return tweets.sort((a, b) => b.createdAt - a.createdAt)
}
```

**Hybrid (Twitter's Approach):**
- Push for normal users (< 1000 followers)
- Pull for celebrities (> 1M followers)
- Merge at read time

## Future Enhancements

- [ ] Retweets and quote tweets
- [ ] Direct messages
- [ ] Lists and bookmarks
- [ ] Advanced search
- [ ] Algorithmic timeline ranking
- [ ] Spaces (audio rooms)
