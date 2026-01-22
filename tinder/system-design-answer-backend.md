# Tinder - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **User Registration & Profiles**: Account creation with photos, bio, preferences
- **Geospatial Discovery**: Find potential matches within configurable radius
- **Swipe System**: Like/Pass actions with persistence and deduplication
- **Match Detection**: Real-time mutual like detection
- **Messaging**: Chat between matched users only
- **Unmatch**: Remove matches and conversation history

### Non-Functional Requirements
- **Low Latency**: Swipe processing < 50ms, discovery < 200ms
- **High Availability**: 99.9% uptime for core matching
- **Scalability**: Support millions of concurrent users
- **Data Consistency**: No duplicate matches, no lost swipes
- **Privacy**: Location never exposed, only relative distance

### Scale Estimation
- 50M daily active users
- 1.5B swipes per day (~17K/second)
- 30M matches per day
- 500M messages per day

---

## 2. High-Level Design (5 minutes)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Mobile    │────▶│ API Gateway  │────▶│ Authentication  │
│    Apps     │     │ (Rate Limit) │     │    Service      │
└─────────────┘     └──────────────┘     └─────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
│   Discovery     │ │   Swipe     │ │    Messaging    │
│    Service      │ │  Service    │ │     Service     │
└────────┬────────┘ └──────┬──────┘ └────────┬────────┘
         │                 │                 │
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
│  Elasticsearch  │ │ Redis Sets  │ │ Redis Pub/Sub   │
│  (Geo Search)   │ │ (Swipes)    │ │ (Real-time)     │
└─────────────────┘ └─────────────┘ └─────────────────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           ▼
                  ┌─────────────────┐
                  │   PostgreSQL    │
                  │   + PostGIS     │
                  └─────────────────┘
```

---

## 3. Data Model Design (7 minutes)

### PostgreSQL Schema with PostGIS

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- Users with geospatial location
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    phone           VARCHAR(20) UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,

    -- Profile data
    name            VARCHAR(100) NOT NULL,
    birth_date      DATE NOT NULL,
    gender          VARCHAR(20) NOT NULL,
    bio             TEXT,

    -- Geospatial location (PostGIS geography type)
    location        GEOGRAPHY(Point, 4326),
    location_updated_at TIMESTAMP WITH TIME ZONE,

    -- Discovery preferences
    show_me         VARCHAR(20)[] DEFAULT ARRAY['women', 'men'],
    age_min         INTEGER DEFAULT 18,
    age_max         INTEGER DEFAULT 100,
    distance_km     INTEGER DEFAULT 50,

    -- Account status
    is_active       BOOLEAN DEFAULT true,
    is_verified     BOOLEAN DEFAULT false,
    last_active     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- GIST index for efficient geo queries
CREATE INDEX idx_users_location ON users USING GIST (location);
CREATE INDEX idx_users_active ON users (is_active, last_active DESC);
CREATE INDEX idx_users_gender ON users (gender);

-- Swipes table for persistence
CREATE TABLE swipes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    swiper_id       UUID NOT NULL REFERENCES users(id),
    swiped_id       UUID NOT NULL REFERENCES users(id),
    direction       VARCHAR(10) NOT NULL CHECK (direction IN ('like', 'pass', 'super_like')),
    idempotency_key VARCHAR(100) UNIQUE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(swiper_id, swiped_id)
);

CREATE INDEX idx_swipes_swiper ON swipes (swiper_id, created_at DESC);
CREATE INDEX idx_swipes_swiped_liked ON swipes (swiped_id)
    WHERE direction IN ('like', 'super_like');

-- Matches table
CREATE TABLE matches (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user1_id        UUID NOT NULL REFERENCES users(id),
    user2_id        UUID NOT NULL REFERENCES users(id),
    matched_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    unmatched_at    TIMESTAMP WITH TIME ZONE,
    unmatched_by    UUID REFERENCES users(id),

    CONSTRAINT ordered_users CHECK (user1_id < user2_id),
    UNIQUE(user1_id, user2_id)
);

CREATE INDEX idx_matches_user1 ON matches (user1_id) WHERE unmatched_at IS NULL;
CREATE INDEX idx_matches_user2 ON matches (user2_id) WHERE unmatched_at IS NULL;

-- Messages table
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id        UUID NOT NULL REFERENCES matches(id),
    sender_id       UUID NOT NULL REFERENCES users(id),
    content         TEXT NOT NULL,
    read_at         TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_messages_match ON messages (match_id, created_at DESC);
```

### Redis Data Structures

```
# Swipe tracking with 24-hour TTL
swipes:{user_id}:liked    -> SET of user IDs (likes)
swipes:{user_id}:passed   -> SET of user IDs (passes)
swipes:{user_id}:seen     -> SET of all seen user IDs

# Likes received (for "See Who Likes You" feature)
likes:received:{user_id}  -> SORTED SET (user_id -> timestamp)
                             TTL: 7 days

# Location cache
user:{user_id}:location   -> HASH {lat, lon, updated_at}
                             TTL: 1 hour

# Rate limiting
ratelimit:swipes:{user_id} -> Counter with 15-minute window
```

### Elasticsearch Index

```json
{
  "mappings": {
    "properties": {
      "user_id": { "type": "keyword" },
      "location": { "type": "geo_point" },
      "gender": { "type": "keyword" },
      "age": { "type": "integer" },
      "show_me": { "type": "keyword" },
      "is_active": { "type": "boolean" },
      "last_active": { "type": "date" },
      "profile_score": { "type": "float" }
    }
  }
}
```

---

## 4. API Design (5 minutes)

### Discovery API

```typescript
// GET /api/discovery/deck
interface DiscoveryRequest {
  latitude: number;
  longitude: number;
  limit?: number;  // default 10
}

interface DiscoveryResponse {
  profiles: ProfileCard[];
  remaining_swipes: number;
  next_refresh_at: string;  // ISO timestamp
}

interface ProfileCard {
  id: string;
  name: string;
  age: number;
  bio: string;
  photos: PhotoUrl[];
  distance_text: string;  // "5 miles away" - never exact
  common_interests: string[];
}
```

### Swipe API

```typescript
// POST /api/swipes
interface SwipeRequest {
  target_user_id: string;
  direction: 'like' | 'pass' | 'super_like';
  idempotency_key: string;  // Client-generated UUID
}

interface SwipeResponse {
  success: boolean;
  match?: {
    match_id: string;
    matched_user: ProfileCard;
    matched_at: string;
  };
  remaining_swipes: number;
}
```

### Match API

```typescript
// GET /api/matches
interface MatchesResponse {
  matches: Match[];
  total: number;
}

interface Match {
  id: string;
  user: ProfileCard;
  matched_at: string;
  last_message?: {
    content: string;
    sent_at: string;
    is_read: boolean;
  };
}

// DELETE /api/matches/:matchId
interface UnmatchResponse {
  success: boolean;
}
```

---

## 5. Deep Dive: Geospatial Discovery (10 minutes)

### Elasticsearch Geo Query Implementation

```typescript
class DiscoveryService {
  async findCandidates(
    userId: string,
    location: { lat: number; lon: number },
    preferences: UserPreferences
  ): Promise<ProfileCard[]> {
    // Get users already seen
    const seenUserIds = await this.redis.smembers(`swipes:${userId}:seen`);

    // Build Elasticsearch query
    const query = {
      bool: {
        must: [
          // Gender filter based on preferences
          { terms: { gender: preferences.showMe } },

          // Age range
          { range: { age: { gte: preferences.ageMin, lte: preferences.ageMax } } },

          // Active users only
          { term: { is_active: true } },

          // Recently active (within 7 days)
          { range: { last_active: { gte: 'now-7d' } } },

          // Mutual interest (they want to see user's gender)
          { terms: { show_me: [preferences.myGender] } }
        ],
        must_not: [
          // Exclude self
          { term: { user_id: userId } },

          // Exclude already seen
          { terms: { user_id: seenUserIds } }
        ],
        filter: {
          // Geo distance filter
          geo_distance: {
            distance: `${preferences.distanceKm}km`,
            location: { lat: location.lat, lon: location.lon }
          }
        }
      }
    };

    const results = await this.elasticsearch.search({
      index: 'users',
      body: {
        query,
        sort: [
          // Sort by distance first
          {
            _geo_distance: {
              location: { lat: location.lat, lon: location.lon },
              order: 'asc',
              unit: 'km'
            }
          },
          // Then by profile quality score
          { profile_score: 'desc' },
          // Then by recent activity
          { last_active: 'desc' }
        ],
        size: 50  // Fetch more than needed for client-side randomization
      }
    });

    return this.mapToProfileCards(results.hits.hits, location);
  }

  private mapToProfileCards(
    hits: SearchHit[],
    userLocation: { lat: number; lon: number }
  ): ProfileCard[] {
    return hits.map(hit => ({
      id: hit._source.user_id,
      name: hit._source.name,
      age: hit._source.age,
      bio: hit._source.bio,
      photos: hit._source.photos,
      // Fuzzy distance display for privacy
      distance_text: this.formatDistance(hit.sort[0] as number),
      common_interests: hit._source.interests
    }));
  }

  private formatDistance(km: number): string {
    // Round to provide privacy
    if (km < 1) return 'Less than 1 mile away';
    if (km < 5) return 'About 2 miles away';
    if (km < 10) return 'About 5 miles away';
    if (km < 25) return 'About 15 miles away';
    if (km < 50) return 'About 30 miles away';
    return 'More than 50 miles away';
  }
}
```

### PostGIS Fallback Query

```sql
-- When Elasticsearch is unavailable
WITH user_prefs AS (
    SELECT
        location,
        show_me,
        age_min,
        age_max,
        distance_km,
        gender
    FROM users
    WHERE id = $1
),
candidates AS (
    SELECT
        u.id,
        u.name,
        EXTRACT(YEAR FROM AGE(u.birth_date)) AS age,
        u.bio,
        ST_Distance(u.location, up.location) / 1000 AS distance_km
    FROM users u, user_prefs up
    WHERE u.id != $1
      AND u.is_active = true
      AND u.gender = ANY(up.show_me)
      AND up.gender = ANY(u.show_me)
      AND EXTRACT(YEAR FROM AGE(u.birth_date)) BETWEEN up.age_min AND up.age_max
      AND ST_DWithin(u.location, up.location, up.distance_km * 1000)
      AND u.id NOT IN (
          SELECT swiped_id FROM swipes WHERE swiper_id = $1
      )
    ORDER BY ST_Distance(u.location, up.location)
    LIMIT 50
)
SELECT * FROM candidates;
```

### Location Update with Fuzzing

```typescript
class LocationService {
  async updateLocation(
    userId: string,
    lat: number,
    lon: number
  ): Promise<void> {
    // Add random offset for privacy (up to 1km)
    const fuzzedLocation = this.fuzzLocation(lat, lon, 1000);

    // Update in PostgreSQL
    await this.pool.query(
      `UPDATE users
       SET location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           location_updated_at = NOW()
       WHERE id = $3`,
      [fuzzedLocation.lon, fuzzedLocation.lat, userId]
    );

    // Update in Redis cache
    await this.redis.hset(`user:${userId}:location`, {
      lat: fuzzedLocation.lat,
      lon: fuzzedLocation.lon,
      updated_at: Date.now()
    });
    await this.redis.expire(`user:${userId}:location`, 3600);

    // Update in Elasticsearch
    await this.elasticsearch.update({
      index: 'users',
      id: userId,
      body: {
        doc: {
          location: { lat: fuzzedLocation.lat, lon: fuzzedLocation.lon }
        }
      }
    });
  }

  private fuzzLocation(
    lat: number,
    lon: number,
    maxOffsetMeters: number
  ): { lat: number; lon: number } {
    // Random angle and distance
    const angle = Math.random() * 2 * Math.PI;
    const distance = Math.random() * maxOffsetMeters;

    // Convert to lat/lon offset
    const latOffset = (distance * Math.cos(angle)) / 111111;
    const lonOffset = (distance * Math.sin(angle)) / (111111 * Math.cos(lat * Math.PI / 180));

    return {
      lat: lat + latOffset,
      lon: lon + lonOffset
    };
  }
}
```

---

## 6. Deep Dive: Swipe Processing & Match Detection (8 minutes)

### Swipe Service with Idempotency

```typescript
class SwipeService {
  private readonly SWIPE_LIMIT = 50;
  private readonly RATE_LIMIT_WINDOW = 15 * 60; // 15 minutes

  async processSwipe(
    swiperId: string,
    swipedId: string,
    direction: 'like' | 'pass' | 'super_like',
    idempotencyKey: string
  ): Promise<SwipeResult> {
    // Check idempotency
    const existingResult = await this.checkIdempotency(idempotencyKey);
    if (existingResult) {
      return existingResult;
    }

    // Check rate limit
    const remainingSwipes = await this.checkRateLimit(swiperId);
    if (remainingSwipes <= 0) {
      throw new RateLimitError('Swipe limit reached. Try again later.');
    }

    // Process swipe atomically
    return await this.executeSwipe(swiperId, swipedId, direction, idempotencyKey);
  }

  private async executeSwipe(
    swiperId: string,
    swipedId: string,
    direction: string,
    idempotencyKey: string
  ): Promise<SwipeResult> {
    const pipeline = this.redis.pipeline();

    // Add to seen set
    pipeline.sadd(`swipes:${swiperId}:seen`, swipedId);
    pipeline.expire(`swipes:${swiperId}:seen`, 86400); // 24 hours

    if (direction === 'like' || direction === 'super_like') {
      // Add to liked set
      pipeline.sadd(`swipes:${swiperId}:liked`, swipedId);
      pipeline.expire(`swipes:${swiperId}:liked`, 86400);

      // Add to their "likes received"
      pipeline.zadd(`likes:received:${swipedId}`, Date.now(), swiperId);
      pipeline.expire(`likes:received:${swipedId}`, 7 * 86400);

      // Check for mutual like (potential match)
      pipeline.sismember(`swipes:${swipedId}:liked`, swiperId);
    } else {
      // Add to passed set
      pipeline.sadd(`swipes:${swiperId}:passed`, swipedId);
      pipeline.expire(`swipes:${swiperId}:passed`, 86400);
    }

    // Increment rate limit counter
    pipeline.incr(`ratelimit:swipes:${swiperId}`);
    pipeline.expire(`ratelimit:swipes:${swiperId}`, this.RATE_LIMIT_WINDOW);

    const results = await pipeline.exec();

    // Persist to PostgreSQL asynchronously
    this.persistSwipe(swiperId, swipedId, direction, idempotencyKey);

    // Check if mutual like (match!)
    const isMutualLike = direction !== 'pass' && results[results.length - 3][1] === 1;

    if (isMutualLike) {
      return await this.createMatch(swiperId, swipedId);
    }

    return {
      success: true,
      match: null,
      remaining_swipes: this.SWIPE_LIMIT - (results[results.length - 2][1] as number)
    };
  }

  private async createMatch(
    user1Id: string,
    user2Id: string
  ): Promise<SwipeResult> {
    // Ensure consistent ordering for unique constraint
    const [smaller, larger] = user1Id < user2Id
      ? [user1Id, user2Id]
      : [user2Id, user1Id];

    // Create match in PostgreSQL
    const result = await this.pool.query(
      `INSERT INTO matches (user1_id, user2_id, matched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user1_id, user2_id) DO NOTHING
       RETURNING id, matched_at`,
      [smaller, larger]
    );

    if (result.rows.length === 0) {
      // Match already exists (idempotent)
      return { success: true, match: null, remaining_swipes: await this.getRemainingSwipes(user1Id) };
    }

    const match = result.rows[0];

    // Notify both users via WebSocket
    await this.notifyMatch(user1Id, user2Id, match.id);

    // Get matched user profile for response
    const matchedUser = await this.getProfileCard(user2Id);

    return {
      success: true,
      match: {
        match_id: match.id,
        matched_user: matchedUser,
        matched_at: match.matched_at
      },
      remaining_swipes: await this.getRemainingSwipes(user1Id)
    };
  }

  private async notifyMatch(
    user1Id: string,
    user2Id: string,
    matchId: string
  ): Promise<void> {
    const matchEvent = {
      type: 'match',
      match_id: matchId,
      matched_at: new Date().toISOString()
    };

    // Publish to Redis for WebSocket servers
    await Promise.all([
      this.redis.publish(`user:${user1Id}:events`, JSON.stringify({
        ...matchEvent,
        matched_user_id: user2Id
      })),
      this.redis.publish(`user:${user2Id}:events`, JSON.stringify({
        ...matchEvent,
        matched_user_id: user1Id
      }))
    ]);
  }
}
```

### Bloom Filter for Space-Efficient Seen Tracking

```typescript
class BloomFilterSwipeTracker {
  private readonly BLOOM_SIZE = 10000;  // Bits per user
  private readonly HASH_COUNT = 7;

  async hasSeenUser(userId: string, targetId: string): Promise<boolean> {
    const key = `bloom:seen:${userId}`;
    const indices = this.getHashIndices(targetId);

    // Check all bits
    const pipeline = this.redis.pipeline();
    for (const index of indices) {
      pipeline.getbit(key, index);
    }

    const results = await pipeline.exec();
    return results.every(([_, bit]) => bit === 1);
  }

  async markAsSeen(userId: string, targetId: string): Promise<void> {
    const key = `bloom:seen:${userId}`;
    const indices = this.getHashIndices(targetId);

    const pipeline = this.redis.pipeline();
    for (const index of indices) {
      pipeline.setbit(key, index, 1);
    }
    pipeline.expire(key, 7 * 86400); // 7 days

    await pipeline.exec();
  }

  private getHashIndices(value: string): number[] {
    const indices: number[] = [];
    for (let i = 0; i < this.HASH_COUNT; i++) {
      const hash = this.murmurHash(`${value}:${i}`);
      indices.push(hash % this.BLOOM_SIZE);
    }
    return indices;
  }
}
```

---

## 7. Deep Dive: Real-Time Messaging (5 minutes)

### WebSocket Gateway with Redis Pub/Sub

```typescript
class MessagingGateway {
  private connections: Map<string, WebSocket> = new Map();
  private subscriber: Redis;

  async initialize(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    await this.subscriber.psubscribe('user:*:events');

    this.subscriber.on('pmessage', (pattern, channel, message) => {
      const userId = channel.split(':')[1];
      this.deliverToUser(userId, JSON.parse(message));
    });
  }

  handleConnection(ws: WebSocket, userId: string): void {
    this.connections.set(userId, ws);

    // Update last active
    this.redis.hset(`user:${userId}:presence`, {
      status: 'online',
      server_id: this.serverId,
      connected_at: Date.now()
    });

    ws.on('message', (data) => this.handleMessage(userId, data));
    ws.on('close', () => this.handleDisconnect(userId));
  }

  private async handleMessage(userId: string, data: Buffer): Promise<void> {
    const message = JSON.parse(data.toString());

    switch (message.type) {
      case 'chat_message':
        await this.handleChatMessage(userId, message);
        break;
      case 'typing':
        await this.handleTypingIndicator(userId, message);
        break;
      case 'read_receipt':
        await this.handleReadReceipt(userId, message);
        break;
    }
  }

  private async handleChatMessage(
    senderId: string,
    message: ChatMessage
  ): Promise<void> {
    // Verify match exists and is active
    const match = await this.verifyMatch(senderId, message.match_id);
    if (!match) {
      throw new UnauthorizedError('Not matched with this user');
    }

    const recipientId = match.user1_id === senderId
      ? match.user2_id
      : match.user1_id;

    // Store message in PostgreSQL
    const stored = await this.pool.query(
      `INSERT INTO messages (match_id, sender_id, content, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, created_at`,
      [message.match_id, senderId, message.content]
    );

    // Deliver via Redis Pub/Sub
    await this.redis.publish(`user:${recipientId}:events`, JSON.stringify({
      type: 'new_message',
      message: {
        id: stored.rows[0].id,
        match_id: message.match_id,
        sender_id: senderId,
        content: message.content,
        created_at: stored.rows[0].created_at
      }
    }));
  }

  private deliverToUser(userId: string, event: any): void {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }
}
```

### Message Service with Pagination

```typescript
class MessageService {
  async getMessages(
    userId: string,
    matchId: string,
    cursor?: string,
    limit: number = 50
  ): Promise<{ messages: Message[]; next_cursor?: string }> {
    // Verify user is part of match
    const match = await this.verifyMatchMembership(userId, matchId);
    if (!match) {
      throw new UnauthorizedError('Not part of this match');
    }

    let query = `
      SELECT id, sender_id, content, read_at, created_at
      FROM messages
      WHERE match_id = $1
    `;
    const params: any[] = [matchId];

    if (cursor) {
      query += ` AND created_at < $2`;
      params.push(new Date(cursor));
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit + 1);

    const result = await this.pool.query(query, params);

    const hasMore = result.rows.length > limit;
    const messages = result.rows.slice(0, limit);

    return {
      messages: messages.reverse(),
      next_cursor: hasMore ? messages[0].created_at.toISOString() : undefined
    };
  }
}
```

---

## 8. Reliability & Scaling (5 minutes)

### Rate Limiting

```typescript
class RateLimiter {
  private readonly limits = {
    swipes: { count: 50, window: 15 * 60 },    // 50 per 15 min
    superLikes: { count: 5, window: 86400 },    // 5 per day
    messages: { count: 100, window: 60 }         // 100 per minute
  };

  async checkLimit(
    userId: string,
    action: keyof typeof this.limits
  ): Promise<{ allowed: boolean; remaining: number; reset_at: number }> {
    const config = this.limits[action];
    const key = `ratelimit:${action}:${userId}`;

    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.ttl(key);

    const [[, count], [, ttl]] = await pipeline.exec();

    if (ttl === -1) {
      await this.redis.expire(key, config.window);
    }

    return {
      allowed: count <= config.count,
      remaining: Math.max(0, config.count - count),
      reset_at: Date.now() + (ttl > 0 ? ttl * 1000 : config.window * 1000)
    };
  }
}
```

### Data Retention Policy

```typescript
class DataRetentionService {
  async enforceRetention(): Promise<void> {
    // Delete old swipes (30 days)
    await this.pool.query(
      `DELETE FROM swipes
       WHERE created_at < NOW() - INTERVAL '30 days'`
    );

    // Delete messages from unmatched conversations (365 days after unmatch)
    await this.pool.query(
      `DELETE FROM messages
       WHERE match_id IN (
         SELECT id FROM matches
         WHERE unmatched_at IS NOT NULL
         AND unmatched_at < NOW() - INTERVAL '365 days'
       )`
    );

    // Delete old unmatched matches
    await this.pool.query(
      `DELETE FROM matches
       WHERE unmatched_at IS NOT NULL
       AND unmatched_at < NOW() - INTERVAL '365 days'`
    );

    // Clean up inactive users from Elasticsearch
    await this.elasticsearch.deleteByQuery({
      index: 'users',
      body: {
        query: {
          bool: {
            should: [
              { term: { is_active: false } },
              { range: { last_active: { lt: 'now-90d' } } }
            ]
          }
        }
      }
    });
  }
}
```

### Horizontal Scaling

```
┌─────────────────────────────────────────────────────────┐
│                    Load Balancer                        │
│              (Geographic + Session Sticky)              │
└────────────────────────┬────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │  API 1  │    │  API 2  │    │  API 3  │
    │ (US-W)  │    │ (US-E)  │    │  (EU)   │
    └────┬────┘    └────┬────┘    └────┬────┘
         │              │              │
         ▼              ▼              ▼
    ┌─────────────────────────────────────┐
    │         Redis Cluster               │
    │    (Pub/Sub across regions)         │
    └─────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │   ES    │    │   ES    │    │   ES    │
    │ (US-W)  │    │ (US-E)  │    │  (EU)   │
    └─────────┘    └─────────┘    └─────────┘
         │              │              │
         └──────────────┼──────────────┘
                        ▼
              ┌─────────────────┐
              │   PostgreSQL    │
              │  Primary + Read │
              │    Replicas     │
              └─────────────────┘
```

---

## 9. Trade-offs and Alternatives (2 minutes)

| Decision | Choice | Trade-off |
|----------|--------|-----------|
| Geo Search | Elasticsearch primary | Better performance, but added complexity |
| Swipe Storage | Redis Sets with TTL | Fast O(1) lookup, but eventual consistency with DB |
| Match Detection | Synchronous on swipe | Immediate feedback, but adds latency |
| Location Privacy | 1km fuzzing | Privacy protection, but less accurate distances |
| Message Storage | PostgreSQL | ACID guarantees, but scales less than NoSQL |

### Alternative Approaches

1. **Cassandra for Messages**: Better write throughput but harder queries
2. **Graph Database for Social**: Better for friend-of-friend features
3. **Redis Streams for Events**: Better replay capability than Pub/Sub
4. **S3 for Photo Storage**: CDN integration for global delivery

---

## 10. Summary

This backend architecture handles Tinder's core requirements:

1. **Geospatial Discovery**: Elasticsearch with PostGIS fallback for finding nearby users
2. **Fast Swipe Processing**: Redis Sets for O(1) seen/liked checks with 24h TTL
3. **Real-Time Matching**: Immediate detection on every like with Redis
4. **Scalable Messaging**: WebSocket with Redis Pub/Sub for cross-server delivery
5. **Privacy First**: Location fuzzing and distance abstraction
6. **Reliability**: Idempotency keys, rate limiting, and data retention policies

The system scales horizontally with geographic load balancing and maintains consistency through PostgreSQL as the source of truth with Redis for hot data.
