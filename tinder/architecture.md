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

### Entity-Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              TINDER DATABASE SCHEMA                              │
│                              Entity Relationships                                │
└─────────────────────────────────────────────────────────────────────────────────┘

                                    ┌─────────────────┐
                                    │    sessions     │
                                    │─────────────────│
                                    │ sid (PK)        │
                                    │ sess            │
                                    │ expire          │
                                    └─────────────────┘
                                    (standalone - no FK)

┌────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│                              ┌─────────────────┐                                │
│                              │     users       │                                │
│                              │─────────────────│                                │
│                              │ id (PK)         │◄─────────────────────────────┐ │
│                              │ email           │                              │ │
│                              │ password_hash   │                              │ │
│                              │ name            │                              │ │
│                              │ birthdate       │                              │ │
│                              │ gender          │                              │ │
│                              │ bio             │                              │ │
│                              │ job_title       │                              │ │
│                              │ company         │                              │ │
│                              │ school          │                              │ │
│                              │ latitude        │                              │ │
│                              │ longitude       │                              │ │
│                              │ location        │                              │ │
│                              │ last_active     │                              │ │
│                              │ created_at      │                              │ │
│                              │ is_admin        │                              │ │
│                              └────────┬────────┘                              │ │
│                                       │                                        │ │
│           ┌───────────────────────────┼───────────────────────────┐           │ │
│           │                           │                           │           │ │
│           ▼ 1:1                       ▼ 1:N                       ▼ 1:N       │ │
│  ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐  │ │
│  │user_preferences │         │     photos      │         │     swipes      │  │ │
│  │─────────────────│         │─────────────────│         │─────────────────│  │ │
│  │ user_id (PK,FK) │         │ id (PK)         │         │ id (PK)         │  │ │
│  │ interested_in   │         │ user_id (FK)────┼─────────│ swiper_id (FK)──┼──┘ │
│  │ age_min         │         │ url             │         │ swiped_id (FK)──┼────┤
│  │ age_max         │         │ position        │         │ direction       │    │
│  │ distance_km     │         │ is_primary      │         │ idempotency_key │    │
│  │ show_me         │         │ created_at      │         │ created_at      │    │
│  └─────────────────┘         └─────────────────┘         │ updated_at      │    │
│                                                          └─────────────────┘    │
│                                                          UNIQUE(swiper,swiped)   │
│                                                                                  │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                            │  │
│  │    ┌─────────────────┐                      ┌─────────────────┐           │  │
│  │    │    matches      │                      │   messages      │           │  │
│  │    │─────────────────│                      │─────────────────│           │  │
│  │    │ id (PK)         │◄─────────────────────│ match_id (FK)   │           │  │
│  │    │ user1_id (FK)───┼──────────────────────│ sender_id (FK)──┼───────────┼──┤
│  │    │ user2_id (FK)───┼──────────────────────┼─────────────────┼───────────┼──┘
│  │    │ matched_at      │         1:N          │ id (PK)         │           │
│  │    │ last_message_at │                      │ content         │           │
│  │    │ unmatched_at    │                      │ sent_at         │           │
│  │    └─────────────────┘                      │ read_at         │           │
│  │    UNIQUE(user1,user2)                      └─────────────────┘           │
│  │                                                                            │
│  └───────────────────────────────────────────────────────────────────────────┘
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

LEGEND:
  ─────►  Foreign Key Reference (arrow points to referenced table)
  1:1     One-to-One relationship
  1:N     One-to-Many relationship
  (PK)    Primary Key
  (FK)    Foreign Key
```

### Complete Database Schema

```sql
-- ============================================================================
-- USERS TABLE
-- ============================================================================
-- Core user profile data including authentication, personal info, and location.
-- Location is stored both as lat/lng (for API use) and as PostGIS geography
-- (for efficient geospatial queries with GIST indexing).

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
    location        GEOGRAPHY(Point, 4326),  -- PostGIS geography for geo queries
    last_active     TIMESTAMP DEFAULT NOW(),
    created_at      TIMESTAMP DEFAULT NOW(),
    is_admin        BOOLEAN DEFAULT false
);

-- ============================================================================
-- USER PREFERENCES TABLE
-- ============================================================================
-- Discovery preferences for filtering potential matches.
-- 1:1 relationship with users table, created when user completes onboarding.

CREATE TABLE user_preferences (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    interested_in   TEXT[] DEFAULT ARRAY['male', 'female'],
    age_min         INTEGER DEFAULT 18,
    age_max         INTEGER DEFAULT 100,
    distance_km     INTEGER DEFAULT 50,
    show_me         BOOLEAN DEFAULT true
);

-- ============================================================================
-- PHOTOS TABLE
-- ============================================================================
-- User profile photos with ordering support.
-- Each user can have multiple photos; position determines display order.

CREATE TABLE photos (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url             VARCHAR(512) NOT NULL,
    position        INTEGER NOT NULL,
    is_primary      BOOLEAN DEFAULT false,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- SWIPES TABLE
-- ============================================================================
-- Records of user swipe actions (like/pass).
-- Unique constraint prevents duplicate swipes on the same user.
-- Idempotency key enables safe client retries.

CREATE TABLE swipes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    swiper_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    swiped_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    direction       VARCHAR(10) NOT NULL CHECK (direction IN ('like', 'pass')),
    idempotency_key VARCHAR(64),
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(swiper_id, swiped_id)
);

-- ============================================================================
-- MATCHES TABLE
-- ============================================================================
-- Mutual matches between two users (both liked each other).
-- user1_id and user2_id are ordered to prevent duplicate match records.

CREATE TABLE matches (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user1_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    matched_at      TIMESTAMP DEFAULT NOW(),
    last_message_at TIMESTAMP,
    unmatched_at    TIMESTAMP,  -- NULL if active; set when unmatched
    UNIQUE(user1_id, user2_id)
);

-- ============================================================================
-- MESSAGES TABLE
-- ============================================================================
-- Chat messages between matched users.
-- Messages belong to a match, ensuring only matched users can message.

CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id        UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    sent_at         TIMESTAMP DEFAULT NOW(),
    read_at         TIMESTAMP
);

-- ============================================================================
-- SESSIONS TABLE
-- ============================================================================
-- Session storage for express-session middleware.

CREATE TABLE sessions (
    sid             VARCHAR(255) PRIMARY KEY,
    sess            JSON NOT NULL,
    expire          TIMESTAMP NOT NULL
);
```

### Table Descriptions and Rationale

| Table | Purpose | Row Growth | Retention |
|-------|---------|------------|-----------|
| `users` | Core user profiles with auth and location data | Low (user signups) | Indefinite |
| `user_preferences` | Discovery filtering settings | 1:1 with users | Tied to user lifecycle |
| `photos` | Profile images with ordering | ~5 per user | Until user deletes |
| `swipes` | Swipe history for deduplication | High (main activity) | 90 days (cleanup) |
| `matches` | Mutual matches | Medium (subset of swipes) | Indefinite |
| `messages` | Chat conversations | High (active matches) | 365 days after unmatch |
| `sessions` | Login sessions | Transient | Auto-expire |

### Indexes and Performance Optimizations

```sql
-- USERS: Geospatial and filtering indexes
CREATE INDEX idx_users_location ON users USING GIST (location);
CREATE INDEX idx_users_gender ON users(gender);
CREATE INDEX idx_users_birthdate ON users(birthdate);
CREATE INDEX idx_users_last_active ON users(last_active);

-- PHOTOS: Fetch user's photos in order
CREATE INDEX idx_photos_user ON photos(user_id);
CREATE INDEX idx_photos_position ON photos(user_id, position);

-- SWIPES: Query patterns for discovery and match detection
CREATE INDEX idx_swipes_swiper ON swipes(swiper_id);
CREATE INDEX idx_swipes_swiped ON swipes(swiped_id);
CREATE INDEX idx_swipes_direction ON swipes(swiper_id, direction);
CREATE INDEX idx_swipes_idempotency_key ON swipes(idempotency_key)
    WHERE idempotency_key IS NOT NULL;  -- Partial index

-- MATCHES: Find user's matches and sort by activity
CREATE INDEX idx_matches_user1 ON matches(user1_id);
CREATE INDEX idx_matches_user2 ON matches(user2_id);
CREATE INDEX idx_matches_last_message ON matches(last_message_at);
CREATE INDEX idx_matches_unmatched_at ON matches(unmatched_at)
    WHERE unmatched_at IS NOT NULL;  -- Partial index for cleanup

-- MESSAGES: Conversation retrieval and timeline
CREATE INDEX idx_messages_match ON messages(match_id);
CREATE INDEX idx_messages_sent ON messages(sent_at);

-- SESSIONS: Cleanup expired sessions
CREATE INDEX idx_sessions_expire ON sessions(expire);
```

### Index Rationale

| Index | Query Pattern | Why Needed |
|-------|---------------|------------|
| `idx_users_location` | `ST_DWithin(location, ...)` | GIST index enables fast geo queries (find users within X km) |
| `idx_users_gender` | `WHERE gender = 'female'` | Filter candidates by gender preference |
| `idx_users_birthdate` | `WHERE calculate_age(birthdate) BETWEEN 25 AND 35` | Age range filtering in discovery |
| `idx_users_last_active` | `ORDER BY last_active DESC` | Rank active users higher in deck |
| `idx_swipes_swiper` | `WHERE swiper_id = ?` | "Who have I already swiped on?" (deck deduplication) |
| `idx_swipes_swiped` | `WHERE swiped_id = ?` | "Who has liked me?" (Likes You feature) |
| `idx_swipes_direction` | `WHERE swiper_id = ? AND direction = 'like'` | Match detection: check if target liked me back |
| `idx_swipes_idempotency_key` | `WHERE idempotency_key = ?` | Fast duplicate request detection |
| `idx_matches_user1/user2` | `WHERE user1_id = ? OR user2_id = ?` | Get all matches for a user |
| `idx_matches_last_message` | `ORDER BY last_message_at DESC` | Sort matches by recent activity |
| `idx_messages_match` | `WHERE match_id = ?` | Load conversation history |

### Foreign Key Relationships and Cascade Behaviors

| FK Constraint | Cascade Behavior | Rationale |
|---------------|------------------|-----------|
| `user_preferences.user_id -> users.id` | `ON DELETE CASCADE` | Preferences are meaningless without the user; delete together |
| `photos.user_id -> users.id` | `ON DELETE CASCADE` | Photos belong to user; no orphan photos allowed |
| `swipes.swiper_id -> users.id` | `ON DELETE CASCADE` | If user is deleted, their swipe history should be removed |
| `swipes.swiped_id -> users.id` | `ON DELETE CASCADE` | If swiped user is deleted, remove the swipe record |
| `matches.user1_id -> users.id` | `ON DELETE CASCADE` | Match invalid if either user is deleted |
| `matches.user2_id -> users.id` | `ON DELETE CASCADE` | Match invalid if either user is deleted |
| `messages.match_id -> matches.id` | `ON DELETE CASCADE` | Messages belong to match; delete conversation with match |
| `messages.sender_id -> users.id` | `ON DELETE CASCADE` | If sender is deleted, remove their messages |

**Why CASCADE for all relationships:**
- Tinder is a dating app where user deletion should completely remove their footprint
- No legal requirement to retain data after user requests deletion (GDPR compliance)
- Orphaned records (photos without users, messages without matches) serve no purpose
- Simplifies data management and prevents ghost data accumulating

**Alternative considered:** `ON DELETE SET NULL` for messages.sender_id
- Would allow keeping messages after sender deletion
- Rejected because it creates confusing UX ("message from deleted user")
- Privacy-first approach: when someone unmatches/deletes, conversation disappears

### Database Triggers and Functions

```sql
-- AUTO-SYNC LOCATION GEOGRAPHY FROM LAT/LNG
-- Ensures PostGIS geography column stays in sync when lat/lng are updated
CREATE OR REPLACE FUNCTION update_user_location()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
        NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_user_location
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_user_location();

-- CALCULATE AGE FROM BIRTHDATE
-- Utility function for age-based filtering in discovery queries
CREATE OR REPLACE FUNCTION calculate_age(birthdate DATE)
RETURNS INTEGER AS $$
BEGIN
    RETURN EXTRACT(YEAR FROM AGE(birthdate));
END;
$$ LANGUAGE plpgsql;

-- AUTO-UPDATE SWIPE TIMESTAMP
-- Tracks when swipes are modified (e.g., changing direction)
CREATE OR REPLACE FUNCTION update_swipe_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_swipe_timestamp
    BEFORE UPDATE ON swipes
    FOR EACH ROW
    EXECUTE FUNCTION update_swipe_timestamp();
```

### Data Flow for Key Operations

#### 1. User Registration Flow
```
┌─────────────┐
│ POST /auth/ │
│  register   │
└──────┬──────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ INSERT INTO users (email, password_hash, name, ...)  │
│ RETURNING id                                          │
└──────┬───────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ INSERT INTO user_preferences (user_id)                │
│ -- Creates default preferences for new user          │
└──────┬───────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ Sync to Elasticsearch (async)                         │
│ -- User becomes discoverable by others               │
└──────────────────────────────────────────────────────┘
```

#### 2. Discovery Deck Generation Flow
```
┌─────────────────┐
│ GET /discovery/ │
│      deck       │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Get user's location and preferences                               │
│    SELECT u.latitude, u.longitude, p.*                               │
│    FROM users u JOIN user_preferences p ON u.id = p.user_id         │
│    WHERE u.id = ?                                                    │
└────────┬────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Get users already swiped on (Redis cache or DB fallback)         │
│    SMEMBERS swipes:{user_id}:liked                                   │
│    SMEMBERS swipes:{user_id}:passed                                  │
│    -- OR from PostgreSQL --                                          │
│    SELECT swiped_id FROM swipes WHERE swiper_id = ?                 │
└────────┬────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Query Elasticsearch for candidates                                │
│    - geo_distance filter (within distance_km)                        │
│    - gender filter (matches interested_in)                           │
│    - age filter (between age_min and age_max)                        │
│    - exclude already swiped users                                    │
│    - exclude users with show_me = false                              │
│    - sort by: distance + last_active + likes_received               │
└────────┬────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. Fetch full profiles with photos                                   │
│    SELECT u.*, array_agg(p.*) as photos                              │
│    FROM users u LEFT JOIN photos p ON u.id = p.user_id              │
│    WHERE u.id IN (candidate_ids)                                     │
│    GROUP BY u.id                                                     │
│    ORDER BY array_position(candidate_ids, u.id)                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### 3. Swipe and Match Detection Flow
```
┌────────────────────┐
│ POST /discovery/   │
│      swipe         │
│ { userId, "like" } │
└─────────┬──────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Check rate limit (Redis)                                          │
│    INCR rate_limit:{user_id}:swipes                                  │
│    -- 429 if exceeded --                                             │
└─────────┬───────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Check idempotency (if key provided)                               │
│    SELECT * FROM swipes WHERE idempotency_key = ?                    │
│    -- Return cached result if exists --                              │
└─────────┬───────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Record swipe in PostgreSQL                                        │
│    INSERT INTO swipes (swiper_id, swiped_id, direction, ...)         │
│    ON CONFLICT (swiper_id, swiped_id) DO UPDATE                      │
│    SET direction = EXCLUDED.direction, updated_at = NOW()           │
└─────────┬───────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. Update Redis cache                                                │
│    SADD swipes:{user_id}:liked {swiped_id}                          │
│    EXPIRE swipes:{user_id}:liked 86400                               │
│    SADD likes:received:{swiped_id} {user_id}                        │
│    EXPIRE likes:received:{swiped_id} 604800                          │
└─────────┬───────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. Check for mutual match (only if direction = 'like')               │
│    SISMEMBER swipes:{swiped_id}:liked {swiper_id}                    │
│    -- OR from PostgreSQL --                                          │
│    SELECT 1 FROM swipes                                              │
│    WHERE swiper_id = ? AND swiped_id = ? AND direction = 'like'     │
└─────────┬───────────────────────────────────────────────────────────┘
          │
          ├─── No mutual like ───► Return { matched: false }
          │
          ▼ Mutual like found!
┌─────────────────────────────────────────────────────────────────────┐
│ 6. Create match record                                               │
│    INSERT INTO matches (user1_id, user2_id, matched_at)              │
│    VALUES (LEAST(a,b), GREATEST(a,b), NOW())                         │
│    -- Ordering ensures no duplicate matches --                       │
└─────────┬───────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 7. Send real-time notifications                                      │
│    PUBLISH match:{user1_id} { matchId, otherUser }                  │
│    PUBLISH match:{user2_id} { matchId, otherUser }                  │
│    -- WebSocket gateway delivers to connected users --               │
└─────────────────────────────────────────────────────────────────────┘
```

#### 4. Messaging Flow
```
┌────────────────────────┐
│ POST /matches/:id/     │
│      messages          │
│ { content: "Hey!" }    │
└───────────┬────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Verify sender is part of match                                    │
│    SELECT * FROM matches                                             │
│    WHERE id = ? AND (user1_id = ? OR user2_id = ?)                  │
│    AND unmatched_at IS NULL                                          │
└───────────┬─────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Insert message                                                    │
│    INSERT INTO messages (match_id, sender_id, content)               │
│    RETURNING id, sent_at                                             │
└───────────┬─────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Update match last_message_at (denormalized for sorting)           │
│    UPDATE matches SET last_message_at = NOW() WHERE id = ?          │
└───────────┬─────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. Notify recipient via WebSocket                                    │
│    PUBLISH message:{recipient_id} { matchId, message }              │
└─────────────────────────────────────────────────────────────────────┘
```

#### 5. Unmatch Flow
```
┌────────────────────┐
│ DELETE /matches/   │
│       :id          │
└─────────┬──────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Soft-delete match (set unmatched_at, don't hard delete)           │
│    UPDATE matches SET unmatched_at = NOW() WHERE id = ?             │
│    -- Messages retained for 365 days per retention policy --         │
└─────────┬───────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Remove from active matches cache                                  │
│    -- Match no longer appears in either user's match list --        │
└─────────┬───────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Cleanup job (runs periodically)                                   │
│    DELETE FROM messages WHERE match_id IN (                          │
│      SELECT id FROM matches                                          │
│      WHERE unmatched_at < NOW() - INTERVAL '365 days'               │
│    )                                                                 │
└─────────────────────────────────────────────────────────────────────┘
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

## Data Lifecycle Policies

### Retention and TTL Settings

#### PostgreSQL Data Retention

| Table | Retention Policy | Rationale |
|-------|-----------------|-----------|
| `users` | Indefinite (until account deletion) | Core user data |
| `user_preferences` | Indefinite | Tied to user lifecycle |
| `photos` | Indefinite (cleanup on deletion) | User-managed content |
| `swipes` | 90 days | No need to store old swipes; users rarely re-swipe |
| `matches` | Indefinite (until unmatch) | Ongoing relationships |
| `messages` | 365 days after match end | Compliance and storage optimization |

**Cleanup Script (run weekly via cron):**
```sql
-- Delete old swipes (run as scheduled job)
DELETE FROM swipes
WHERE created_at < NOW() - INTERVAL '90 days';

-- Archive messages from ended matches older than 1 year
DELETE FROM messages
WHERE match_id IN (
    SELECT id FROM matches WHERE unmatched_at < NOW() - INTERVAL '365 days'
);
```

#### Redis TTL Configuration

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `swipes:{user_id}:liked` | 24 hours | Session-level swipe deduplication |
| `swipes:{user_id}:passed` | 24 hours | Passed users reset daily |
| `likes:received:{user_id}` | 7 days | "Likes You" feature window |
| `user:{user_id}:location` | 1 hour | Location cache freshness |
| `session:{session_id}` | 24 hours | Login sessions |
| `rate_limit:{user_id}` | 1 hour | Sliding window rate limiting |

**Implementation in Redis:**
```bash
# Set TTL when writing swipes
SADD swipes:user123:liked user456
EXPIRE swipes:user123:liked 86400

# Location cache with shorter TTL
SET user:user123:location '{"lat":40.7,"lng":-74.0}' EX 3600
```

#### Elasticsearch Index Lifecycle

For local development, use simple index management:
```bash
# Create index with date suffix for rotation
PUT /users-2024-01

# Alias for seamless rotation
POST /_aliases
{
  "actions": [
    { "add": { "index": "users-2024-01", "alias": "users" } }
  ]
}
```

**Monthly rotation script:**
```bash
#!/bin/bash
CURRENT_MONTH=$(date +%Y-%m)
PREV_MONTH=$(date -d "3 months ago" +%Y-%m)

# Create new index
curl -X PUT "localhost:9200/users-${CURRENT_MONTH}"

# Reindex active users
curl -X POST "localhost:9200/_reindex" -H 'Content-Type: application/json' -d'{
  "source": {"index": "users"},
  "dest": {"index": "users-'${CURRENT_MONTH}'"}
}'

# Delete old indices (keep 3 months)
curl -X DELETE "localhost:9200/users-${PREV_MONTH}"
```

### Archival to Cold Storage

For a local learning project, "cold storage" means exporting to files:

**Archive old messages (run monthly):**
```sql
-- Export to JSON before deletion
COPY (
    SELECT json_agg(m.*)
    FROM messages m
    JOIN matches ma ON m.match_id = ma.id
    WHERE ma.unmatched_at < NOW() - INTERVAL '365 days'
) TO '/tmp/archived_messages.json';
```

**Local archival with MinIO (S3-compatible):**
```bash
# Archive script
DATE=$(date +%Y-%m)
pg_dump -t messages --where="sent_at < NOW() - INTERVAL '1 year'" \
  tinder_db | gzip > messages_archive_${DATE}.sql.gz

# Upload to MinIO cold bucket
mc cp messages_archive_${DATE}.sql.gz minio/tinder-archive/
```

### Backfill and Replay Procedures

#### Elasticsearch Reindex from PostgreSQL

When Elasticsearch data gets out of sync or index mapping changes:

```bash
# 1. Create new index with updated mapping
curl -X PUT "localhost:9200/users-v2" -H 'Content-Type: application/json' -d'
{
  "mappings": {
    "properties": {
      "id": { "type": "keyword" },
      "name": { "type": "text" },
      "gender": { "type": "keyword" },
      "age": { "type": "integer" },
      "location": { "type": "geo_point" },
      "last_active": { "type": "date" },
      "show_me": { "type": "boolean" }
    }
  }
}'

# 2. Backfill from PostgreSQL (Node.js script)
npm run backfill:elasticsearch

# 3. Swap alias atomically
curl -X POST "localhost:9200/_aliases" -d'
{
  "actions": [
    { "remove": { "index": "users-v1", "alias": "users" } },
    { "add": { "index": "users-v2", "alias": "users" } }
  ]
}'
```

**Backfill script (backend/src/scripts/backfill-es.ts):**
```typescript
import { pool } from '../shared/db';
import { esClient } from '../shared/elasticsearch';

async function backfillUsers() {
  const batchSize = 100;
  let offset = 0;

  while (true) {
    const { rows } = await pool.query(`
      SELECT u.id, u.name, u.gender, u.latitude, u.longitude, u.last_active,
             EXTRACT(YEAR FROM AGE(u.birthdate)) as age,
             p.show_me
      FROM users u
      JOIN user_preferences p ON u.id = p.user_id
      WHERE u.latitude IS NOT NULL
      ORDER BY u.id
      LIMIT $1 OFFSET $2
    `, [batchSize, offset]);

    if (rows.length === 0) break;

    const operations = rows.flatMap(user => [
      { index: { _index: 'users-v2', _id: user.id } },
      {
        id: user.id,
        name: user.name,
        gender: user.gender,
        age: user.age,
        location: { lat: user.latitude, lon: user.longitude },
        last_active: user.last_active,
        show_me: user.show_me
      }
    ]);

    await esClient.bulk({ operations });
    offset += batchSize;
    console.log(`Indexed ${offset} users`);
  }
}
```

#### Redis Cache Warmup

After Redis restart or cache flush:

```typescript
// backend/src/scripts/warm-cache.ts
async function warmSwipeCache() {
  const { rows } = await pool.query(`
    SELECT swiper_id, array_agg(swiped_id) as swiped_users, direction
    FROM swipes
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY swiper_id, direction
  `);

  for (const row of rows) {
    const key = `swipes:${row.swiper_id}:${row.direction === 'right' ? 'liked' : 'passed'}`;
    await redis.sadd(key, ...row.swiped_users);
    await redis.expire(key, 86400);
  }
}
```

---

## Deployment and Operations

### Rollout Strategy

For local development with multiple instances, practice blue-green deployments:

#### Blue-Green Deployment (Local)

```bash
# Current setup: blue on ports 3001-3003
# New version: green on ports 3011-3013

# 1. Start green instances
PORT=3011 npm run dev &
PORT=3012 npm run dev &
PORT=3013 npm run dev &

# 2. Health check green instances
for port in 3011 3012 3013; do
  curl -f http://localhost:$port/health || exit 1
done

# 3. Update nginx to route to green
sed -i 's/300[123]/301[123]/g' /usr/local/etc/nginx/nginx.conf
nginx -s reload

# 4. Drain and stop blue instances
kill $(lsof -ti:3001) $(lsof -ti:3002) $(lsof -ti:3003)
```

#### Canary Rollout (Local Simulation)

```nginx
# nginx.conf - route 10% to canary
upstream api {
    server localhost:3001 weight=9;
    server localhost:3002 weight=9;
    server localhost:3011 weight=2;  # canary instance
}
```

**Canary validation checklist:**
- [ ] Error rate < 1% for 15 minutes
- [ ] p95 latency within 10% of baseline
- [ ] No increase in 5xx responses
- [ ] Match detection still working (check Redis pub/sub)

### Schema Migrations

#### Migration File Naming

```
backend/src/db/migrations/
  001_initial_schema.sql
  002_add_swipe_timestamp.sql
  003_add_message_read_at.sql
  004_add_user_verified_column.sql
```

#### Migration Runner

```typescript
// backend/src/db/migrate.ts
import { pool } from '../shared/db';
import * as fs from 'fs';
import * as path from 'path';

async function migrate() {
  // Create migrations table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Get applied migrations
  const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  const applied = new Set(rows.map(r => r.version));

  // Apply pending migrations
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).sort();

  for (const file of files) {
    const version = parseInt(file.split('_')[0]);
    if (applied.has(version)) continue;

    console.log(`Applying migration ${file}...`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await pool.query('COMMIT');
      console.log(`Migration ${file} applied successfully`);
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
}
```

**Run migrations:**
```bash
npm run db:migrate
```

#### Safe Migration Practices

**Adding columns (non-breaking):**
```sql
-- 004_add_user_verified_column.sql
ALTER TABLE users ADD COLUMN verified BOOLEAN DEFAULT false;
CREATE INDEX CONCURRENTLY idx_users_verified ON users(verified);
```

**Renaming columns (breaking - requires coordination):**
```sql
-- Step 1: Add new column
ALTER TABLE users ADD COLUMN display_name VARCHAR(100);
UPDATE users SET display_name = name;

-- Step 2: Deploy code that reads both columns
-- Step 3: Deploy code that writes to both columns
-- Step 4: Deploy code that only uses new column
-- Step 5: Drop old column
ALTER TABLE users DROP COLUMN name;
```

### Rollback Runbooks

#### API Rollback

**Symptoms:** High error rate, increased latency, failed health checks

**Immediate actions:**
```bash
# 1. Check which version is running
curl localhost:3001/health | jq '.version'

# 2. Identify the issue
docker logs tinder-api-1 --tail 100

# 3. Rollback to previous version
git checkout HEAD~1
npm run build
pm2 restart all

# Alternative: If using Docker
docker-compose down
docker-compose -f docker-compose.rollback.yml up -d
```

#### Database Rollback

**For each migration, create a corresponding down migration:**
```sql
-- migrations/004_add_user_verified_column.down.sql
DROP INDEX IF EXISTS idx_users_verified;
ALTER TABLE users DROP COLUMN IF EXISTS verified;
```

**Rollback script:**
```bash
#!/bin/bash
VERSION=$1
psql $DATABASE_URL < migrations/${VERSION}_*.down.sql
psql $DATABASE_URL -c "DELETE FROM schema_migrations WHERE version = $VERSION"
```

#### Elasticsearch Rollback

```bash
# 1. Check current alias
curl localhost:9200/_cat/aliases?v

# 2. Identify previous index
curl localhost:9200/_cat/indices?v

# 3. Switch alias back to previous index
curl -X POST "localhost:9200/_aliases" -d'
{
  "actions": [
    { "remove": { "index": "users-v2", "alias": "users" } },
    { "add": { "index": "users-v1", "alias": "users" } }
  ]
}'
```

#### Redis Rollback

Redis is ephemeral cache - rollback means invalidation:
```bash
# Flush specific key patterns
redis-cli KEYS "swipes:*" | xargs redis-cli DEL

# Or run cache warmup script
npm run cache:warm
```

---

## Capacity and Cost Guardrails

### Alert Thresholds

Configure these alerts for local monitoring with Prometheus/Grafana:

#### Queue and Pub/Sub Lag

```yaml
# prometheus/alerts.yml
groups:
  - name: tinder_alerts
    rules:
      - alert: RedisPubSubBacklog
        expr: redis_pubsub_channels > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Redis Pub/Sub backlog growing"

      - alert: WebSocketConnectionsHigh
        expr: websocket_connections_total > 1000
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "WebSocket connections exceeding capacity"
```

**Local development thresholds:**
| Metric | Warning | Critical |
|--------|---------|----------|
| Redis memory usage | > 100MB | > 200MB |
| Pub/Sub pending messages | > 50 | > 200 |
| WebSocket connections | > 100 | > 500 |

#### Storage Growth Alerts

```yaml
# prometheus/alerts.yml (continued)
      - alert: PostgresTableBloat
        expr: pg_stat_user_tables_n_dead_tup{table="swipes"} > 100000
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "Swipes table needs vacuuming"

      - alert: ElasticsearchDiskUsage
        expr: elasticsearch_filesystem_data_used_percent > 80
        for: 30m
        labels:
          severity: critical
        annotations:
          summary: "Elasticsearch disk usage high"

      - alert: MinioStorageHigh
        expr: minio_bucket_usage_total_bytes{bucket="photos"} > 1073741824  # 1GB
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "Photo storage exceeding 1GB"
```

**Storage growth targets (local dev):**
| Resource | Target Limit | Action When Exceeded |
|----------|--------------|---------------------|
| PostgreSQL | 500MB | Run cleanup scripts, archive old data |
| Elasticsearch | 200MB | Delete old indices, reduce replica count |
| MinIO photos | 1GB | Compress images, delete test uploads |
| Redis | 100MB | Reduce TTLs, evict stale keys |

#### Cache Hit Rate Targets

```typescript
// backend/src/middleware/cache-metrics.ts
import { Counter, Gauge } from 'prom-client';

const cacheHits = new Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache_type']
});

const cacheMisses = new Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache_type']
});

const cacheHitRate = new Gauge({
  name: 'cache_hit_rate',
  help: 'Cache hit rate percentage',
  labelNames: ['cache_type']
});
```

**Target hit rates:**
| Cache Type | Target Hit Rate | Investigation Threshold |
|------------|-----------------|------------------------|
| User location | > 80% | < 60% |
| Swipe history | > 90% | < 75% |
| Session data | > 95% | < 85% |
| Discovery deck | > 70% | < 50% |

**Alert rule:**
```yaml
      - alert: LowCacheHitRate
        expr: cache_hit_rate{cache_type="swipe_history"} < 0.75
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Swipe cache hit rate below 75%"
```

### Cost Control (Local Development)

Since this is a local project, "cost" translates to resource consumption:

#### Docker Resource Limits

```yaml
# docker-compose.yml
services:
  postgres:
    mem_limit: 512m
    cpus: '0.5'

  redis:
    mem_limit: 128m
    cpus: '0.25'

  elasticsearch:
    mem_limit: 512m
    cpus: '0.5'
    environment:
      - "ES_JAVA_OPTS=-Xms256m -Xmx256m"

  minio:
    mem_limit: 256m
    cpus: '0.25'
```

#### Monitoring Dashboard Queries

**Grafana dashboard panels:**

```promql
# API request rate
rate(http_requests_total[5m])

# p95 latency by endpoint
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# Cache hit rate
sum(rate(cache_hits_total[5m])) / (sum(rate(cache_hits_total[5m])) + sum(rate(cache_misses_total[5m])))

# Active WebSocket connections
websocket_connections_active

# Redis memory usage
redis_memory_used_bytes

# PostgreSQL connections
pg_stat_activity_count
```

### Capacity Planning Checklist

Before running load tests or demos:

- [ ] PostgreSQL has at least 500MB free disk space
- [ ] Redis memory limit set to 128MB with LRU eviction
- [ ] Elasticsearch heap set to 256MB (half of container memory)
- [ ] MinIO bucket has lifecycle policy for test data cleanup
- [ ] All services have health check endpoints responding
- [ ] Prometheus scraping all targets successfully
- [ ] Grafana dashboard loaded with key metrics

---

## Future Optimizations

- Bloom filters for swipe history (memory reduction)
- Machine learning for match recommendations
- Photo CDN with resizing
- Push notifications
- Video chat integration
- Premium features (Super Likes, Boosts)

---

## Implementation Notes

This section explains the architectural decisions behind key implementation choices, focusing on WHY each pattern was chosen rather than just how it works.

### Idempotency for Swipe Actions

**Problem:** Network unreliability and user behavior can cause duplicate swipe submissions:
1. Users double-tap the swipe button before UI updates
2. Network timeouts trigger automatic retries
3. Client-side bugs submit the same swipe multiple times

**Why Idempotency Prevents Duplicate Swipes:**

Idempotency ensures that processing the same swipe action multiple times produces the same result as processing it once. This is critical for matching apps because:

1. **Match Integrity:** Without idempotency, a duplicate "like" could trigger match detection twice, potentially creating duplicate match records or sending multiple notifications.

2. **Metric Accuracy:** Duplicate swipes would inflate swipe counts and distort match rate calculations, making it impossible to optimize the matching algorithm.

3. **User Experience:** Repeated match notifications for the same person would confuse users and erode trust in the platform.

**Implementation:**
```typescript
// Client can provide an idempotency key for explicit control
POST /api/discovery/swipe
{
  "userId": "target-uuid",
  "direction": "like",
  "idempotencyKey": "client-generated-uuid"
}

// Server checks for existing swipe before processing
// If found, returns cached result without re-processing
```

The database enforces uniqueness on `(swiper_id, swiped_id)`, and optional `idempotency_key` allows clients to safely retry requests without side effects.

### Rate Limiting for Swipe Protection

**Problem:** Uncontrolled swipe volume damages the matching ecosystem:
1. Bots can mass-like users, gaming the system
2. Users who swipe rapidly on everyone reduce match quality
3. Database and cache load spikes during peak usage

**Why Rate Limiting Protects the Matching Algorithm:**

1. **Fair Visibility Distribution:** Without limits, power users could "like" thousands of profiles per hour, monopolizing the "likes received" pool and reducing visibility for normal users.

2. **Match Quality Optimization:** Rate limiting encourages thoughtful swiping. Users who consider each profile before swiping produce more meaningful matches with higher conversation rates.

3. **Bot Prevention:** Automated accounts attempting to spam likes are throttled before they can significantly impact the matching pool.

4. **Resource Protection:** Swipe processing involves Redis lookups, database writes, and match detection. Rate limiting ensures consistent performance during traffic spikes.

**Implementation:**
```typescript
// Sliding window rate limit (Redis sorted set)
// 50 swipes per 15-minute window
swipeRateLimiter(req, res, next)

// Hourly cap as secondary protection
// 100 swipes per hour
hourlySwipeLimiter(req, res, next)
```

Rate limit headers inform clients of their remaining quota:
```
X-RateLimit-Limit: 50
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 1705435200
```

### Message Retention: Balancing Experience vs. Privacy

**Problem:** Message data presents competing requirements:
- Users expect conversation history to be available
- Storage costs grow with message volume
- Privacy regulations may require deletion
- Unmatched conversations have less value

**Why Current Retention Policy (365 days after unmatch):**

1. **Active Conversations Preserved:** Messages in active matches are never deleted. Users can always scroll back through their conversation history with current matches.

2. **Privacy After Unmatch:** When users unmatch, they've decided to end the connection. Retaining messages indefinitely feels intrusive. The 365-day window allows for:
   - Dispute resolution if needed
   - Compliance with potential legal requirements
   - Gradual data minimization

3. **Storage Optimization:** Messages are the highest-volume data in a matching app. Deleting old messages from ended matches significantly reduces storage costs without impacting active users.

4. **User Expectations:** Dating app users generally expect temporary connections. Unlike email, users don't expect to retrieve messages from years-old unmatched conversations.

**Configuration:**
```typescript
// Configurable via environment variables
SWIPE_RETENTION_DAYS=90     // Old swipes (no need to track forever)
MESSAGE_RETENTION_DAYS=365  // Messages after unmatch
```

### Metrics for Matching Algorithm Optimization

**Problem:** Matching algorithm quality is hard to measure without observability:
1. How do we know if recommended profiles are relevant?
2. What's the conversion rate from deck view to match?
3. Are some user segments underserved?

**Why Prometheus Metrics Enable Algorithm Optimization:**

1. **Funnel Visibility:**
   ```
   discovery_deck_requests_total  -> How many decks generated
   swipes_total{direction="like"} -> How many likes
   matches_total                   -> How many mutual matches
   messages_total                  -> How many conversations started
   ```
   This funnel reveals where users drop off. Low like rates may indicate poor candidate selection. Low match rates after likes suggests preference misalignment.

2. **Latency Tracking:**
   ```
   discovery_deck_duration_seconds -> Time to generate candidates
   swipe_processing_duration_seconds -> Time to process swipe
   ```
   Slow deck generation causes users to close the app. These metrics help identify bottlenecks.

3. **Cache Effectiveness:**
   ```
   cache_hits_total{cache_type="swipe_history"}
   cache_misses_total{cache_type="swipe_history"}
   ```
   High cache miss rates indicate the Redis TTL may be too short, or users are swiping on profiles outside their recent activity window.

4. **Rate Limiting Insights:**
   ```
   rate_limited_requests_total{endpoint="swipe"}
   ```
   Tracking rate-limited requests reveals how many users hit limits. If many legitimate users are throttled, limits may be too aggressive.

5. **Algorithm A/B Testing:**
   By labeling metrics with candidate source (e.g., `source="elasticsearch"` vs `source="ml_ranked"`), we can compare conversion rates between algorithm variants.

**Dashboard Queries:**
```promql
# Match rate (percentage of likes that become matches)
sum(rate(matches_total[1h])) / sum(rate(swipes_total{direction="like"}[1h]))

# Swipe velocity per user
rate(swipes_total[15m]) / count(distinct user_id)

# Cache hit rate for swipe lookups
sum(rate(cache_hits_total{cache_type="swipe_history"}[5m])) /
(sum(rate(cache_hits_total{cache_type="swipe_history"}[5m])) +
 sum(rate(cache_misses_total{cache_type="swipe_history"}[5m])))
```

### Summary: How These Patterns Work Together

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Swipe Request Flow                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  [Client]                                                             │
│     │                                                                 │
│     ▼                                                                 │
│  [Rate Limiter] ─── Exceeded? ───► 429 Too Many Requests             │
│     │                                                                 │
│     ▼ Allowed                                                         │
│  [Idempotency Check] ─── Duplicate? ───► Return cached result        │
│     │                                                                 │
│     ▼ New request                                                     │
│  [Process Swipe]                                                      │
│     │                                                                 │
│     ├── Record in PostgreSQL (with idempotency_key)                  │
│     ├── Update Redis cache (with configurable TTL)                   │
│     ├── Check for mutual match                                       │
│     └── Record metrics (swipes_total, duration, match)               │
│     │                                                                 │
│     ▼                                                                 │
│  [Return Result]                                                      │
│     │                                                                 │
│     └── metrics: http_requests_total, http_request_duration          │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

**The Observability Loop:**
1. Metrics reveal swipe patterns and match rates
2. Analysis identifies optimization opportunities
3. Algorithm changes are deployed
4. Metrics validate improvements
5. Repeat

This data-driven approach transforms matching from "hope it works" to "measure and optimize."

---

## Frontend Architecture

### Technology Stack

- **React 19** - UI framework with hooks and concurrent features
- **TypeScript** - Type safety across the entire frontend
- **Vite** - Fast development server and optimized builds
- **Tanstack Router** - File-based routing with type-safe navigation
- **Zustand** - Lightweight state management
- **Tailwind CSS** - Utility-first styling

### Component Organization

```
frontend/src/
├── components/                    # Reusable UI components
│   ├── ReignsAvatar/             # Procedural avatar generation (modular)
│   │   ├── index.ts              # Barrel exports
│   │   ├── ReignsAvatar.tsx      # Main component (140 lines)
│   │   ├── constants.ts          # Color palettes and configuration
│   │   ├── types.ts              # TypeScript interfaces
│   │   ├── utils.ts              # Seeded random and feature generation
│   │   ├── AvatarDefs.tsx        # SVG filters and gradients
│   │   ├── Hair.tsx              # Back and top hair rendering
│   │   ├── Face.tsx              # Face shape, neck, cheekbones, beard
│   │   ├── FacialFeatures.tsx    # Eyes, eyebrows, nose, lips
│   │   ├── Accessories.tsx       # Crown, earrings, necklace
│   │   └── Clothing.tsx          # Shoulders, frame, background
│   ├── BottomNav.tsx             # Navigation bar
│   ├── MatchModal.tsx            # Match celebration modal
│   ├── SwipeCard.tsx             # Draggable profile card
│   └── ReignsAvatar.tsx          # Re-export for backward compatibility
├── routes/                        # File-based routing
│   ├── __root.tsx                # Root layout
│   ├── index.tsx                 # Discovery/swiping (home)
│   ├── login.tsx                 # Authentication
│   ├── register.tsx              # User registration
│   ├── profile.tsx               # User profile management
│   ├── preferences.tsx           # Discovery preferences
│   ├── matches.tsx               # Match list
│   ├── chat.$matchId.tsx         # Conversation view
│   └── admin/                    # Admin routes
│       └── users.tsx             # User management
├── types/                        # Shared TypeScript types
└── main.tsx                      # Application entry point
```

### ReignsAvatar Component System

The ReignsAvatar is a procedural avatar generator inspired by the "Reigns: Her Majesty" art style. It generates deterministic, medieval-portrait-styled avatars from a seed string, providing unique profile pictures for users without uploaded photos.

#### Design Principles

1. **Deterministic Generation**: Same seed always produces same avatar
2. **Modular Rendering**: Each avatar element (hair, face, eyes, etc.) is a separate component
3. **Render Context Pattern**: Shared context object passed to all sub-components
4. **Painterly Aesthetic**: SVG filters create artistic brush-stroke effects

#### Component Breakdown

| Component | Lines | Responsibility |
|-----------|-------|----------------|
| `ReignsAvatar.tsx` | ~140 | Main orchestrator, creates render context |
| `constants.ts` | ~100 | Color palettes (skin, hair, clothing, accessories) |
| `types.ts` | ~70 | TypeScript interfaces for features and context |
| `utils.ts` | ~130 | Seeded random generator, feature generation, face shapes |
| `AvatarDefs.tsx` | ~80 | SVG filter and gradient definitions |
| `Hair.tsx` | ~130 | Back hair and top hair with style variations |
| `Face.tsx` | ~110 | Neck, face shape, cheekbones, beard |
| `FacialFeatures.tsx` | ~170 | Eyes (with eyelashes), eyebrows, nose, lips |
| `Accessories.tsx` | ~110 | Crown, earrings, necklace |
| `Clothing.tsx` | ~90 | Shoulders, collar, decorative frame |

#### Usage Example

```tsx
import ReignsAvatar from './components/ReignsAvatar';

// Basic usage - generates deterministic avatar
<ReignsAvatar seed="user-123" />

// Custom size
<ReignsAvatar seed="user-123" size={200} />

// With styling
<ReignsAvatar
  seed={`${user.id}-${user.name}`}
  size={128}
  className="rounded-full shadow-lg"
/>
```

#### Feature Generation

Features are generated deterministically from the seed:

- **Gender** (masculine/feminine) - affects hair styles, makeup, accessories
- **Skin Palette** - 6 diverse skin tones with shadow/highlight
- **Hair Color** - 8 options from black to silver
- **Hair Style** - short, medium, long, wavy, braided, bald
- **Eye Color** - 8 natural variations
- **Face Shape** - oval, round, angular, square
- **Accessories** - crown (30%), necklace (50%), earrings (60% feminine)
- **Facial Features** - variable eye size, nose size, lip size, brow thickness

### Component Guidelines

Following the project's coding standards:

1. **Size Limit**: Components under 200 lines (complex components split into sub-components)
2. **SVG Icons**: Never inline SVG code; create separate icon components
3. **JSDoc Comments**: All public components and functions documented
4. **TypeScript**: Strict typing with interfaces for all props
5. **Barrel Exports**: Use `index.ts` for clean imports

### Styling Approach

- **Tailwind CSS** for layout and common styling
- **Inline styles** for dynamic SVG attributes (colors, transforms)
- **CSS classes** in `index.css` for animations (`animate-match-pop`, etc.)
- **Gradient classes** for branded elements (`bg-tinder-gradient`)
