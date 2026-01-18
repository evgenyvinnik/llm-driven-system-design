# Tinder - Matching Platform - System Design Interview Answer

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a location-based matching platform like Tinder. This involves geospatial queries, recommendation algorithms, real-time matching, and messaging. Let me clarify the requirements."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Profile Browsing** - View potential matches based on location and preferences
2. **Swiping Mechanism** - Like (right swipe) or pass (left swipe) on profiles
3. **Match Detection** - Detect and notify when two users mutually like each other
4. **Messaging** - Chat between matched users
5. **Discovery Preferences** - Age range, distance radius, gender preferences

### Non-Functional Requirements

- **Low Latency** - Card deck loading under 200ms
- **Real-time** - Match notifications within seconds
- **Scalability** - Millions of concurrent users
- **Privacy** - Location should not be precisely exposed

### Out of Scope

"For this discussion, I'll set aside: video chat, paid features (Super Likes, Boosts), photo verification, and safety features (reporting/blocking details)."

---

## 2. Scale Estimation (3 minutes)

### Assumptions
- 75 million monthly active users
- 15 million DAU
- Average user swipes 100 times per day
- 50% gender split, matching opposite gender primarily
- Average user has 5 active conversations

### Traffic Estimates
- **Swipes**: 15M users x 100 swipes = 1.5 billion swipes/day = 17,000/second
- **Profile loads**: 1.5 billion/day (each swipe loads a profile)
- **Messages**: 15M users x 5 conversations x 10 messages = 750M messages/day

### Storage Estimates
- User profiles: 75M x 10 KB = 750 GB
- Photos: 75M users x 6 photos x 500 KB = 225 TB
- Swipes: 1.5B/day x 50 bytes = 75 GB/day
- Messages: 750M/day x 200 bytes = 150 GB/day

---

## 3. High-Level Architecture (8 minutes)

```
┌──────────────┐     ┌─────────────────┐     ┌────────────────────────────────┐
│   Mobile     │────▶│   API Gateway   │────▶│     Load Balancer              │
│    App       │     │  (Auth, Rate    │     │     (Geographic routing)       │
└──────────────┘     │   Limiting)     │     └──────────────┬─────────────────┘
                     └─────────────────┘                    │
                                                            │
                     ┌──────────────────────────────────────┼──────────────────┐
                     │                                      │                  │
              ┌──────▼──────┐                       ┌───────▼──────┐    ┌──────▼───────┐
              │   Profile   │                       │  Discovery   │    │   Matching   │
              │   Service   │                       │   Service    │    │   Service    │
              └──────┬──────┘                       └───────┬──────┘    └──────┬───────┘
                     │                                      │                  │
                     │                              ┌───────▼──────┐           │
                     │                              │ Recommendation│           │
                     │                              │    Engine     │           │
                     │                              └───────────────┘           │
                     │                                                         │
┌────────────────────┼─────────────────────────────────────────────────────────┤
│                    │                                                         │
│  ┌─────────────────▼─────────────────┐                              ┌────────▼────────┐
│  │          PostgreSQL               │                              │     Redis       │
│  │  (Users, Matches, Messages)       │                              │  (Cache, Swipes)│
│  └───────────────────────────────────┘                              └─────────────────┘
│                                                                                        │
│  ┌──────────────────────┐                       ┌───────────────────────────────────┐ │
│  │    Elasticsearch     │                       │    S3 / Object Storage            │ │
│  │   (Geo + Search)     │                       │        (Photos)                   │ │
│  └──────────────────────┘                       └───────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘

                     ┌─────────────────┐
                     │   WebSocket     │
                     │    Gateway      │◀────── Real-time matches & messages
                     └─────────────────┘
```

### Core Components

1. **Profile Service** - User profiles, photos, preferences
2. **Discovery Service** - Generates card deck of potential matches
3. **Recommendation Engine** - Ranking algorithm for profile ordering
4. **Matching Service** - Detects mutual likes, creates matches
5. **Messaging Service** - Chat between matched users
6. **WebSocket Gateway** - Real-time notifications

---

## 4. Data Model (5 minutes)

### Core Entities

```sql
-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY,
    phone_hash      VARCHAR(64) UNIQUE,    -- Hashed for privacy
    name            VARCHAR(100) NOT NULL,
    birthdate       DATE NOT NULL,
    gender          VARCHAR(20) NOT NULL,
    bio             TEXT,
    job_title       VARCHAR(100),
    company         VARCHAR(100),
    school          VARCHAR(100),
    location        GEOGRAPHY(Point, 4326),
    last_active     TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Discovery preferences
CREATE TABLE user_preferences (
    user_id         UUID PRIMARY KEY,
    interested_in   VARCHAR(20)[],         -- Array of genders
    age_min         INTEGER DEFAULT 18,
    age_max         INTEGER DEFAULT 100,
    distance_km     INTEGER DEFAULT 50,
    show_me         BOOLEAN DEFAULT true   -- Appear in discovery
);

-- Photos
CREATE TABLE photos (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL,
    url             VARCHAR(512) NOT NULL,
    position        INTEGER NOT NULL,      -- Order in profile
    is_verified     BOOLEAN DEFAULT false,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Swipes (high volume - consider separate store)
CREATE TABLE swipes (
    id              UUID PRIMARY KEY,
    swiper_id       UUID NOT NULL,
    swiped_id       UUID NOT NULL,
    direction       VARCHAR(10) NOT NULL,  -- 'like' or 'pass'
    created_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(swiper_id, swiped_id)
);

-- Matches
CREATE TABLE matches (
    id              UUID PRIMARY KEY,
    user1_id        UUID NOT NULL,
    user2_id        UUID NOT NULL,
    matched_at      TIMESTAMP DEFAULT NOW(),
    last_message_at TIMESTAMP,
    UNIQUE(user1_id, user2_id)
);

-- Messages (stored in PostgreSQL for simplicity)
CREATE TABLE messages (
    id              UUID PRIMARY KEY,
    match_id        UUID NOT NULL REFERENCES matches(id),
    sender_id       UUID NOT NULL REFERENCES users(id),
    content         TEXT NOT NULL,
    sent_at         TIMESTAMP DEFAULT NOW(),
    read_at         TIMESTAMP
);
```

> **Implementation Note:** This simplified implementation uses PostgreSQL for message storage. In a production system at scale, you might consider a dedicated message store like Cassandra or ScyllaDB for better write throughput and time-series access patterns, or a document database like MongoDB for flexible schema evolution.

### Geospatial Index

```sql
-- For fast location-based queries
CREATE INDEX idx_users_location ON users USING GIST (location);

-- With Elasticsearch for more complex geo queries
PUT /users
{
  "mappings": {
    "properties": {
      "location": { "type": "geo_point" },
      "age": { "type": "integer" },
      "gender": { "type": "keyword" },
      "last_active": { "type": "date" }
    }
  }
}
```

### Swipe Data in Redis

```
# Track who user has swiped on (to not show again)
swipes:{user_id}:liked -> Set of user_ids
swipes:{user_id}:passed -> Set of user_ids

# Or use bloom filter for space efficiency
swipes_bloom:{user_id} -> Bloom filter of seen user_ids
```

---

## 5. Deep Dive: Discovery / Card Deck Generation (10 minutes)

"The discovery system is the heart of the app. Let me explain how we generate the card deck."

### Discovery Algorithm

```python
async def get_discovery_deck(user_id, limit=20):
    user = await get_user(user_id)
    prefs = await get_preferences(user_id)

    # 1. Get candidates from geo search
    candidates = await geo_search(
        center=user.location,
        radius_km=prefs.distance_km,
        gender_filter=prefs.interested_in,
        age_min=prefs.age_min,
        age_max=prefs.age_max,
        limit=500  # Get more than needed for filtering/ranking
    )

    # 2. Filter out already swiped
    already_seen = await get_seen_users(user_id)
    candidates = [c for c in candidates if c.id not in already_seen]

    # 3. Filter out users who passed on this user (optional optimization)
    passed_on_me = await get_who_passed_on(user_id)
    candidates = [c for c in candidates if c.id not in passed_on_me]

    # 4. Score and rank candidates
    scored_candidates = await rank_candidates(user, candidates)

    # 5. Take top N
    deck = scored_candidates[:limit]

    # 6. Prefetch photos for smooth UX
    await prefetch_photos(deck)

    return deck
```

### Geo Search with Elasticsearch

```python
async def geo_search(center, radius_km, gender_filter, age_min, age_max, limit):
    query = {
        "bool": {
            "must": [
                {"terms": {"gender": gender_filter}},
                {"range": {"age": {"gte": age_min, "lte": age_max}}},
                {"term": {"show_me": True}},
                {"range": {"last_active": {"gte": "now-7d"}}}  # Active recently
            ],
            "filter": {
                "geo_distance": {
                    "distance": f"{radius_km}km",
                    "location": {
                        "lat": center.latitude,
                        "lon": center.longitude
                    }
                }
            }
        }
    }

    # Sort by distance and activity
    sort = [
        {"_geo_distance": {"location": center, "order": "asc"}},
        {"last_active": {"order": "desc"}}
    ]

    results = await elasticsearch.search(
        index="users",
        query=query,
        sort=sort,
        size=limit
    )

    return [hit["_source"] for hit in results["hits"]["hits"]]
```

### Recommendation Scoring

```python
async def rank_candidates(user, candidates):
    """
    Score candidates based on multiple factors.
    Higher score = shown earlier in deck.
    """
    scored = []

    for candidate in candidates:
        score = 0.0

        # Factor 1: Distance (closer = better)
        distance = calculate_distance(user.location, candidate.location)
        score += max(0, 100 - distance)  # 100 points for 0 km, 0 for 100+ km

        # Factor 2: Activity (recently active = better)
        hours_since_active = (now() - candidate.last_active).total_hours()
        score += max(0, 50 - hours_since_active)  # 50 points for just active

        # Factor 3: Profile completeness
        completeness = calculate_profile_completeness(candidate)
        score += completeness * 30  # Up to 30 points

        # Factor 4: They liked me (show mutual interest opportunities first)
        if await did_user_like_me(candidate.id, user.id):
            score += 200  # Big boost for potential matches

        # Factor 5: Similar interests (if we have data)
        interest_overlap = calculate_interest_overlap(user, candidate)
        score += interest_overlap * 20

        scored.append((candidate, score))

    # Sort by score descending
    scored.sort(key=lambda x: x[1], reverse=True)

    return [c for c, s in scored]
```

### Handling "Likes You" Priority

```python
async def did_user_like_me(their_id, my_id):
    """Check if they swiped right on me."""
    # Check Redis first (fast path)
    liked = await redis.sismember(f"swipes:{their_id}:liked", my_id)
    if liked:
        return True

    # Fallback to database
    return await db.exists(
        "SELECT 1 FROM swipes WHERE swiper_id = :them AND swiped_id = :me AND direction = 'like'",
        them=their_id, me=my_id
    )
```

---

## 6. Deep Dive: Matching System (5 minutes)

### Swipe Processing

```python
async def process_swipe(swiper_id, swiped_id, direction):
    # 1. Record the swipe
    await record_swipe(swiper_id, swiped_id, direction)

    # 2. Add to seen set (never show again)
    await redis.sadd(f"swipes:{swiper_id}:seen", swiped_id)

    if direction == 'like':
        await redis.sadd(f"swipes:{swiper_id}:liked", swiped_id)

        # 3. Check for mutual like (match!)
        mutual = await redis.sismember(f"swipes:{swiped_id}:liked", swiper_id)

        if mutual:
            return await create_match(swiper_id, swiped_id)

    return None

async def create_match(user1_id, user2_id):
    # Ensure consistent ordering
    if user1_id > user2_id:
        user1_id, user2_id = user2_id, user1_id

    # Create match record
    match = await db.insert_match(user1_id, user2_id)

    # Notify both users in real-time
    await notify_match(user1_id, user2_id, match)

    return match

async def notify_match(user1_id, user2_id, match):
    # Get profiles for notification
    user1 = await get_user_summary(user1_id)
    user2 = await get_user_summary(user2_id)

    # Send via WebSocket
    await websocket_gateway.send(user1_id, {
        'type': 'new_match',
        'match': match,
        'user': user2
    })

    await websocket_gateway.send(user2_id, {
        'type': 'new_match',
        'match': match,
        'user': user1
    })

    # Also send push notification
    await push_notification_service.send([user1_id, user2_id],
        title="It's a Match!",
        body="You and {name} liked each other"
    )
```

### Optimized Match Detection with Bloom Filters

```python
class SwipeStore:
    """
    Use bloom filters to efficiently check "have I seen this user?"
    with minimal memory footprint.
    """
    def __init__(self):
        self.filters = {}  # user_id -> BloomFilter

    async def get_or_create_filter(self, user_id):
        if user_id not in self.filters:
            # Load from Redis or create new
            serialized = await redis.get(f"swipe_bloom:{user_id}")
            if serialized:
                self.filters[user_id] = BloomFilter.deserialize(serialized)
            else:
                # 0.1% false positive rate, 10K expected items
                self.filters[user_id] = BloomFilter(capacity=10000, error_rate=0.001)

        return self.filters[user_id]

    async def has_seen(self, user_id, other_id):
        bf = await self.get_or_create_filter(user_id)
        return other_id in bf  # Might have false positives

    async def mark_seen(self, user_id, other_id):
        bf = await self.get_or_create_filter(user_id)
        bf.add(other_id)

        # Periodically persist to Redis
        if should_persist(user_id):
            await redis.set(f"swipe_bloom:{user_id}", bf.serialize())
```

---

## 7. Messaging System (4 minutes)

> **Implementation Note:** This implementation uses PostgreSQL for message storage, which is suitable for moderate scale and simplifies the infrastructure. For high-volume messaging at scale, consider dedicated solutions like Cassandra (for time-series access patterns) or a purpose-built chat infrastructure.

### Message Storage (PostgreSQL)

```sql
-- Messages table
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id        UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    sent_at         TIMESTAMP DEFAULT NOW(),
    read_at         TIMESTAMP  -- NULL until recipient reads the message
);

-- Index for fetching conversation messages
CREATE INDEX idx_messages_match ON messages(match_id);
CREATE INDEX idx_messages_sent ON messages(sent_at);

-- Denormalized last_message_at in matches table for sorting
UPDATE matches SET last_message_at = NOW() WHERE id = :match_id;
```

### Real-Time Messaging

```python
class MessageService:
    async def send_message(self, match_id, sender_id, content):
        # Verify sender is part of match
        match = await get_match(match_id)
        if sender_id not in [match.user1_id, match.user2_id]:
            raise UnauthorizedError()

        recipient_id = match.user1_id if sender_id == match.user2_id else match.user2_id

        # Store message in PostgreSQL
        message = await db.query("""
            INSERT INTO messages (match_id, sender_id, content, sent_at)
            VALUES (:match_id, :sender_id, :content, NOW())
            RETURNING id, match_id, sender_id, content, sent_at
        """, match_id=match_id, sender_id=sender_id, content=content)

        # Update match with last message timestamp
        await db.query("""
            UPDATE matches
            SET last_message_at = NOW()
            WHERE id = :match_id
        """, match_id=match_id)

        # Send via WebSocket
        await websocket_gateway.send(recipient_id, {
            'type': 'new_message',
            'match_id': match_id,
            'message': message
        })

        return message

    async def get_conversation(self, match_id, limit=50, before=None):
        """Fetch messages for a conversation with pagination."""
        query = """
            SELECT id, match_id, sender_id, content, sent_at, read_at
            FROM messages
            WHERE match_id = :match_id
        """
        if before:
            query += " AND sent_at < :before"
        query += " ORDER BY sent_at DESC LIMIT :limit"

        return await db.query(query, match_id=match_id, before=before, limit=limit)
```

### WebSocket Connection Management

```python
class WebSocketGateway:
    def __init__(self):
        self.connections = {}  # user_id -> websocket
        self.redis_pubsub = redis.pubsub()

    async def handle_connection(self, websocket, user_id):
        self.connections[user_id] = websocket

        try:
            # Subscribe to user's channel
            await self.redis_pubsub.subscribe(f"user:{user_id}")

            async for message in websocket:
                await self.handle_message(user_id, message)
        finally:
            del self.connections[user_id]

    async def send(self, user_id, payload):
        if user_id in self.connections:
            # Direct send if connected to this server
            await self.connections[user_id].send(json.dumps(payload))
        else:
            # Publish to Redis for other servers
            await redis.publish(f"user:{user_id}", json.dumps(payload))
```

---

## 8. Location Privacy (3 minutes)

### Fuzzy Location

```python
def fuzz_location(precise_location, fuzz_radius_km=1):
    """
    Add random offset to location for privacy.
    User sees "2 miles away" not exact coordinates.
    """
    # Random angle
    angle = random.uniform(0, 2 * math.pi)

    # Random distance up to fuzz_radius
    distance = random.uniform(0, fuzz_radius_km)

    # Calculate offset
    lat_offset = distance * math.cos(angle) / 111  # ~111 km per degree latitude
    lng_offset = distance * math.sin(angle) / (111 * math.cos(math.radians(precise_location.lat)))

    return Location(
        lat=precise_location.lat + lat_offset,
        lng=precise_location.lng + lng_offset
    )

async def get_display_distance(user1, user2):
    """Return approximate distance, not exact."""
    distance = calculate_distance(user1.location, user2.location)

    if distance < 1:
        return "Less than a mile away"
    elif distance < 5:
        return f"{int(distance)} miles away"
    else:
        # Round to nearest 5 miles
        return f"{int(distance / 5) * 5} miles away"
```

---

## 9. Trade-offs and Alternatives (3 minutes)

### Trade-off 1: Pre-computed vs. Real-time Deck

**Chose**: Real-time generation with caching
**Trade-off**: More compute, but fresher results
**Alternative**: Pre-compute decks hourly (stale but faster)

### Trade-off 2: Swipe Storage

**Chose**: Redis Sets + Bloom Filters
**Trade-off**: Bloom filters have false positives (might not show someone twice)
**Alternative**: Full swipe history in database (slower, more storage)

### Trade-off 3: Match Detection

**Chose**: Check on every like swipe
**Trade-off**: Real-time matching requires more lookups
**Alternative**: Batch process matches periodically (delayed notifications)

### Trade-off 4: Message Storage

**Chose**: PostgreSQL for simplified implementation
**Trade-off**: Limited write throughput compared to dedicated message stores
**Alternative**: Use Cassandra/ScyllaDB for time-series optimized storage, or MongoDB for flexible document storage at higher scale

---

## 10. Scalability Considerations (2 minutes)

### Geographic Sharding

```
US-East    US-West    Europe    Asia
   │          │         │         │
   ▼          ▼         ▼         ▼
┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐
│Elastic│  │Elastic│  │Elastic│  │Elastic│
│ NYC   │  │  LA   │  │London │  │Tokyo │
└──────┘  └──────┘  └──────┘  └──────┘
```

Users are routed to nearest regional cluster. Cross-region matching is rare (distance filter) so we can handle it as edge case.

### Hot Spot Handling

Popular users (many incoming swipes) can cause hot spots:

```python
# Rate limit how often a user appears in decks
async def should_show_user(user_id):
    appearances = await redis.incr(f"appearances:{user_id}:{current_hour()}")
    if appearances > MAX_HOURLY_APPEARANCES:
        return False
    return True
```

---

## Summary

"To summarize, I've designed a matching platform with:

1. **Geospatial discovery** using Elasticsearch for efficient location-based filtering
2. **Multi-factor ranking** prioritizing distance, activity, and mutual interest
3. **Real-time match detection** with Redis-backed swipe tracking
4. **WebSocket messaging** with Redis Pub/Sub for cross-server delivery
5. **Privacy-preserving location** with fuzzing and approximate distances

The key insight is separating the high-read discovery path (Elasticsearch + caching) from the high-write swipe path (Redis + async persistence), while keeping match detection fast enough for real-time notifications."

---

## Questions I'd Expect

**Q: How do you handle users who swipe through all nearby profiles?**
A: We expand the radius progressively, show users who were slightly outside preferences, or surface less active users. We also have a daily swipe limit for free users.

**Q: What about same-gender matching and gender preferences?**
A: The discovery query filters by the intersection of: what the viewing user wants AND what the candidate user wants to be shown to. It's a bidirectional preference system.

**Q: How do you handle fake profiles and catfishing?**
A: Photo verification (take a selfie matching a pose), ML-based fake photo detection, reporting system with manual review, and account age/behavior scoring.

**Q: Why PostgreSQL instead of a dedicated message store?**
A: For this implementation, PostgreSQL simplifies the infrastructure while providing sufficient performance for moderate scale. The ACID guarantees and familiar SQL interface make development easier. At higher scale, we would consider Cassandra for write-heavy time-series data or a dedicated chat infrastructure.
