# Tinder - Matching Platform - Architecture Design

## System Overview

A location-based matching and recommendation system that enables users to discover potential matches based on location and preferences, swipe to express interest, and chat when mutually matched.

## Requirements

### Functional Requirements

- **Profile Browsing** - View potential matches based on location and preferences
- **Swiping Mechanism** - Like (right swipe) or pass (left swipe) on profiles
- **Match Detection** - Detect and notify when two users mutually like each other
- **Messaging** - Chat between matched users
- **Discovery Preferences** - Age range, distance radius, gender preferences

### Non-Functional Requirements

- **Low Latency** - Card deck loading under 200ms
- **Real-time** - Match notifications within seconds
- **Scalability** - Support for multiple server instances
- **Privacy** - Location should not be precisely exposed

## Capacity Estimation

### Local Development Scale
- 10-100 test users
- 10-50 swipes per session
- 1-5 active conversations

### Production Scale (Reference)
- Daily Active Users: 15M
- Swipes per day: 1.5 billion
- Messages per day: 750 million

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                     │
│               (React + TypeScript + Tanstack Router)                      │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          API Gateway                                      │
│                    (Express + WebSocket)                                  │
└────────────┬──────────────┬───────────────┬──────────────────────────────┘
             │              │               │
     ┌───────▼──────┐ ┌─────▼─────┐ ┌───────▼───────┐
     │   Profile    │ │ Discovery │ │   Matching    │
     │   Service    │ │  Service  │ │   Service     │
     └───────┬──────┘ └─────┬─────┘ └───────┬───────┘
             │              │               │
             │      ┌───────▼───────┐       │
             │      │  Message      │       │
             │      │  Service      │       │
             │      └───────┬───────┘       │
             │              │               │
┌────────────▼──────────────▼───────────────▼──────────────────────────────┐
│                         Data Layer                                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────────┐   │
│  │ PostgreSQL  │  │    Redis    │  │        Elasticsearch            │   │
│  │ + PostGIS   │  │  (Cache/    │  │        (Geo Search)             │   │
│  │ (Primary)   │  │   Pub/Sub)  │  │                                 │   │
│  └─────────────┘  └─────────────┘  └─────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **Profile Service** - User profiles, photos, preferences management
2. **Discovery Service** - Geo-based candidate search and ranking
3. **Matching Service** - Swipe processing and match detection
4. **Message Service** - Real-time chat between matches
5. **WebSocket Gateway** - Real-time notifications for matches and messages

## Data Model

### Database Schema

```sql
-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    name            VARCHAR(100) NOT NULL,
    birthdate       DATE NOT NULL,
    gender          VARCHAR(20) NOT NULL,
    bio             TEXT,
    job_title       VARCHAR(100),
    company         VARCHAR(100),
    school          VARCHAR(100),
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    location        GEOGRAPHY(Point, 4326),
    last_active     TIMESTAMP,
    is_admin        BOOLEAN DEFAULT false
);

-- Discovery preferences
CREATE TABLE user_preferences (
    user_id         UUID PRIMARY KEY,
    interested_in   TEXT[],
    age_min         INTEGER DEFAULT 18,
    age_max         INTEGER DEFAULT 100,
    distance_km     INTEGER DEFAULT 50,
    show_me         BOOLEAN DEFAULT true
);

-- Photos
CREATE TABLE photos (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL,
    url             VARCHAR(512) NOT NULL,
    position        INTEGER NOT NULL,
    is_primary      BOOLEAN DEFAULT false
);

-- Swipes
CREATE TABLE swipes (
    id              UUID PRIMARY KEY,
    swiper_id       UUID NOT NULL,
    swiped_id       UUID NOT NULL,
    direction       VARCHAR(10) NOT NULL,
    UNIQUE(swiper_id, swiped_id)
);

-- Matches
CREATE TABLE matches (
    id              UUID PRIMARY KEY,
    user1_id        UUID NOT NULL,
    user2_id        UUID NOT NULL,
    matched_at      TIMESTAMP,
    last_message_at TIMESTAMP,
    UNIQUE(user1_id, user2_id)
);

-- Messages
CREATE TABLE messages (
    id              UUID PRIMARY KEY,
    match_id        UUID NOT NULL,
    sender_id       UUID NOT NULL,
    content         TEXT NOT NULL,
    sent_at         TIMESTAMP,
    read_at         TIMESTAMP
);
```

### Elasticsearch Index

```json
{
  "mappings": {
    "properties": {
      "id": { "type": "keyword" },
      "name": { "type": "text" },
      "gender": { "type": "keyword" },
      "age": { "type": "integer" },
      "location": { "type": "geo_point" },
      "last_active": { "type": "date" },
      "show_me": { "type": "boolean" },
      "interested_in": { "type": "keyword" }
    }
  }
}
```

### Redis Data Structures

```
# Swipe tracking
swipes:{user_id}:liked    -> Set of user IDs liked
swipes:{user_id}:passed   -> Set of user IDs passed

# Likes received (for "likes you" feature)
likes:received:{user_id}  -> Set of user IDs who liked this user

# User location cache
user:{user_id}:location   -> JSON { latitude, longitude }
```

## API Design

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### User Management
- `GET /api/users/profile` - Get profile
- `PUT /api/users/profile` - Update profile
- `PUT /api/users/location` - Update location
- `GET /api/users/preferences` - Get preferences
- `PUT /api/users/preferences` - Update preferences
- `GET/POST/DELETE /api/users/photos` - Manage photos

### Discovery
- `GET /api/discovery/deck` - Get discovery deck
- `POST /api/discovery/swipe` - Swipe on user
- `GET /api/discovery/likes` - Get users who liked you

### Matches & Messaging
- `GET /api/matches` - Get all matches
- `GET /api/matches/:id/messages` - Get messages
- `POST /api/matches/:id/messages` - Send message
- `DELETE /api/matches/:id` - Unmatch

### WebSocket Events
- `auth` - Authenticate connection
- `new_match` - Match notification
- `new_message` - Message notification
- `typing` - Typing indicator

## Key Design Decisions

### Geo-based Matching

**Approach:** Elasticsearch with geo_distance filter + distance sorting

**Why Elasticsearch over PostGIS alone:**
- Better performance for complex multi-field queries
- Built-in relevance scoring
- Easy horizontal scaling
- PostGIS serves as fallback

### Swipe Storage

**Approach:** Redis Sets with PostgreSQL persistence

**Trade-offs:**
- O(1) lookup for "have I seen this user"
- Fast mutual like detection
- 24-hour TTL to manage memory
- Eventual consistency acceptable for swipes

### Match Detection

**Approach:** Real-time check on every like swipe

**Process:**
1. Record swipe in Redis and PostgreSQL
2. Check if target has liked current user
3. If mutual, create match and notify both users
4. Notification via WebSocket, fallback to polling

### Real-time Messaging

**Approach:** WebSocket with Redis Pub/Sub

**Features:**
- Direct delivery if recipient connected to same server
- Redis Pub/Sub for cross-server message routing
- Message persistence in PostgreSQL
- Read receipts

## Technology Stack

- **Frontend:** React 19 + TypeScript + Vite + Tanstack Router + Zustand + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Primary Database:** PostgreSQL with PostGIS
- **Cache/Sessions:** Redis
- **Search:** Elasticsearch
- **Real-time:** WebSocket with Redis Pub/Sub

## Scalability Considerations

### Horizontal Scaling
- Stateless API servers behind load balancer
- Redis for session management (not in-memory)
- Elasticsearch for read-heavy discovery queries
- PostgreSQL read replicas for matches/messages

### Regional Deployment
- Users primarily match within their region
- Deploy Elasticsearch clusters per region
- Cross-region matching handled as edge case

### Hot Spot Handling
- Rate limit appearances in discovery deck
- Cap swipes per hour for free users
- Queue popular users for batch processing

## Trade-offs and Alternatives

| Decision | Trade-off | Alternative |
|----------|-----------|-------------|
| Elasticsearch for geo | Operational complexity | PostGIS-only (simpler, slower) |
| Redis for swipes | Memory cost | Database-only (slower checks) |
| Real-time match check | More lookups per swipe | Batch matching (delayed) |
| WebSocket for messaging | Connection management | Long polling (simpler) |

## Monitoring and Observability

- **Metrics:** API response times, swipe rates, match rates
- **Logs:** Structured logging with correlation IDs
- **Alerts:** High latency, error rates, queue depths
- **Dashboards:** Real-time user activity, system health

## Security Considerations

- Password hashing with bcrypt
- Session-based authentication with HttpOnly cookies
- Location fuzzing for privacy
- Input validation on all endpoints
- Rate limiting per user
- CORS configuration

## Future Optimizations

- Bloom filters for swipe history (memory reduction)
- Machine learning for match recommendations
- Photo CDN with resizing
- Push notifications
- Video chat integration
- Premium features (Super Likes, Boosts)
