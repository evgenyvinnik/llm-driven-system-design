# Bitly (URL Shortener) - System Design Interview Answer

## Introduction

"Today I'll design a URL shortening service like Bitly. The core problem seems simple - convert long URLs to short ones - but at scale, it involves interesting challenges around ID generation, high read throughput, and analytics. Let me walk through my approach."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm what we're building:

1. **URL Shortening**: Given a long URL, generate a short URL (e.g., `bit.ly/abc123`)
2. **URL Redirection**: When users visit the short URL, redirect to the original
3. **Custom Short URLs**: Allow users to specify their own short code (e.g., `bit.ly/my-promo`)
4. **Analytics**: Track click counts, referrers, geographic data
5. **Link Expiration**: Optional TTL for short URLs

Should I also consider user accounts and link management, or focus on the core shortening service?"

### Non-Functional Requirements

"For a service like Bitly:

- **Scale**: Let's design for 100 million URLs created per month, 10 billion redirects per month
- **Latency**: Redirects must be fast (<100ms) - users expect instant redirects
- **Availability**: 99.99% uptime - broken short links are unacceptable
- **Durability**: URLs should work for years (some go on printed materials)
- **Read-Heavy**: Ratio is roughly 100:1 reads to writes"

---

## Step 2: Scale Estimation

"Let me work through the numbers:

**Write Traffic:**
- 100M new URLs/month = ~40 URLs/second
- Each URL mapping: ~500 bytes (short code, long URL, metadata)
- Monthly storage for new URLs: 100M * 500B = 50 GB

**Read Traffic:**
- 10B redirects/month = ~4,000 redirects/second
- Peak load (viral links): Maybe 10x = 40,000 RPS

**Storage (5-year retention):**
- URLs: 100M * 12 * 5 = 6 billion URLs
- Size: 6B * 500B = 3 TB

**Short Code Space:**
- Using base62 (a-z, A-Z, 0-9): 62 characters
- 7-character codes: 62^7 = 3.5 trillion combinations
- More than enough for billions of URLs

This tells me: read-heavy workload, caching is critical, storage is manageable."

---

## Step 3: High-Level Architecture

```
                              ┌─────────────────┐
                              │    Clients      │
                              │ (Browsers/Apps) │
                              └────────┬────────┘
                                       │
                                       ▼
                          ┌────────────────────────┐
                          │     Load Balancer      │
                          │   (Geographic DNS)     │
                          └────────────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
           ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
           │  API Server  │   │  API Server  │   │  API Server  │
           │   (Node.js)  │   │   (Node.js)  │   │   (Node.js)  │
           └──────────────┘   └──────────────┘   └──────────────┘
                    │                  │                  │
                    └──────────────────┼──────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
           ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
           │    Cache     │   │   Database   │   │  Analytics   │
           │   (Redis)    │   │  (PostgreSQL │   │   (Kafka →   │
           │              │   │   + Shards)  │   │   ClickHouse)│
           └──────────────┘   └──────────────┘   └──────────────┘
```

"The architecture has three main paths:

1. **Create Short URL**: API Server → Database → Return short URL
2. **Redirect**: API Server → Cache (hit) → 301 Redirect, or Cache (miss) → Database → Cache → Redirect
3. **Analytics**: Every redirect → Kafka → Async processing → ClickHouse"

---

## Step 4: Short Code Generation

"This is the most interesting design decision. Let me compare approaches:

### Option 1: Hash the Long URL

```python
short_code = base62(md5(long_url)[:7])
```

**Pros:**
- Same URL always produces same code (deduplication built-in)
- No coordination needed between servers

**Cons:**
- Collisions possible (7 chars from MD5)
- Can't support custom short codes
- Privacy issue: Anyone can check if a URL was shortened

**Verdict**: Too many issues, not recommended.

### Option 2: Counter-Based ID

```python
short_code = base62(auto_increment_id)
```

**Pros:**
- Guaranteed unique
- Simple to implement
- Short codes start small and grow

**Cons:**
- Single point of failure (counter)
- Predictable (can enumerate URLs)
- Scaling issues with distributed counter

**Verdict**: Works at small scale, problematic at large scale.

### Option 3: Pre-generated Key Pool (Recommended)

```
┌─────────────────────────────────────────┐
│         Key Generation Service          │
│  - Pre-generates millions of keys       │
│  - Stores in 'unused_keys' table        │
│  - Marks as 'used' when allocated       │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         API Server Key Cache            │
│  - Fetches batch of 1000 keys           │
│  - Assigns keys from local cache        │
│  - Requests new batch when low          │
└─────────────────────────────────────────┘
```

**How it works:**
1. Key Generation Service pre-generates random 7-character codes
2. Stores in database with `used = false`
3. API servers fetch batches of unused keys
4. On URL creation, pop key from local cache, mark as used

**Pros:**
- No coordination between API servers
- Random codes (not predictable)
- Guaranteed unique
- Scales horizontally

**Cons:**
- Slight complexity
- Need to handle server crash (some keys lost - acceptable)

**I'd go with Option 3 for a production system.**"

---

## Step 5: Data Model

### URLs Table (PostgreSQL)

```sql
CREATE TABLE urls (
    short_code VARCHAR(10) PRIMARY KEY,
    long_url TEXT NOT NULL,
    user_id UUID,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    click_count BIGINT DEFAULT 0,
    is_active BOOLEAN DEFAULT true
);

CREATE INDEX idx_urls_user_id ON urls(user_id);
CREATE INDEX idx_urls_expires ON urls(expires_at) WHERE expires_at IS NOT NULL;
```

### Key Pool Table

```sql
CREATE TABLE key_pool (
    short_code VARCHAR(10) PRIMARY KEY,
    is_used BOOLEAN DEFAULT false,
    allocated_to VARCHAR(50),  -- Server ID
    allocated_at TIMESTAMP
);

CREATE INDEX idx_unused_keys ON key_pool(is_used) WHERE is_used = false;
```

### Analytics Events (Kafka → ClickHouse)

```json
{
  "short_code": "abc123",
  "timestamp": "2024-01-15T14:30:00Z",
  "referrer": "https://twitter.com",
  "user_agent": "Mozilla/5.0...",
  "ip_country": "US",
  "ip_city": "San Francisco",
  "device_type": "mobile"
}
```

---

## Step 6: API Design

### Create Short URL

```
POST /api/v1/shorten

Request:
{
  "long_url": "https://example.com/very/long/url?with=params",
  "custom_code": "my-promo",  // Optional
  "expires_in": 86400         // Optional, seconds
}

Response:
{
  "short_url": "https://bit.ly/my-promo",
  "short_code": "my-promo",
  "long_url": "https://example.com/very/long/url?with=params",
  "expires_at": "2024-01-16T14:30:00Z"
}
```

### Redirect (The Hot Path)

```
GET /{short_code}

Response: 301 Moved Permanently
Location: https://example.com/very/long/url?with=params
```

"Why 301 vs 302?
- **301 (Permanent)**: Browser caches, fewer server hits, but harder to update
- **302 (Temporary)**: No caching, every click hits server (good for analytics)

I'd use 301 for performance, and track analytics separately via JavaScript pixel or server logs."

### Get Analytics

```
GET /api/v1/analytics/{short_code}

Response:
{
  "short_code": "abc123",
  "total_clicks": 15420,
  "clicks_by_day": [...],
  "top_referrers": [...],
  "top_countries": [...]
}
```

---

## Step 7: Caching Strategy

"With 40,000 RPS, we need aggressive caching.

### Cache Architecture

```
Request → Local Cache (in-process) → Redis Cluster → PostgreSQL
```

### Local Cache (LRU, 10K entries)
- For extremely hot URLs (viral links)
- TTL: 60 seconds
- Saves Redis round-trip

### Redis Cluster
- Main caching layer
- Store: `short_code → long_url`
- TTL: 24 hours
- Expect 99%+ cache hit rate

### Cache Population

```python
def get_long_url(short_code):
    # Check local cache
    if short_code in local_cache:
        return local_cache[short_code]

    # Check Redis
    long_url = redis.get(short_code)
    if long_url:
        local_cache[short_code] = long_url
        return long_url

    # Cache miss - hit database
    long_url = db.query("SELECT long_url FROM urls WHERE short_code = ?", short_code)
    if long_url:
        redis.setex(short_code, 86400, long_url)
        local_cache[short_code] = long_url
        return long_url

    return None  # 404
```

### Cache Invalidation

- **Expiration**: TTL handles staleness
- **Updates**: URL updates (rare) → delete from Redis, let re-populate
- **Deletes**: User deletes link → delete from Redis immediately"

---

## Step 8: Database Sharding

"At 6 billion URLs, we need to shard PostgreSQL.

### Sharding Strategy: By Short Code

```
Shard 0: short_codes starting with 0-9, a-f
Shard 1: short_codes starting with g-m
Shard 2: short_codes starting with n-t
Shard 3: short_codes starting with u-z, A-M
Shard 4: short_codes starting with N-Z
```

**Why shard by short_code?**
- The primary access pattern is by short_code (redirects)
- Even distribution (base62 is uniform)
- Simple routing logic

**Shard Routing:**
```python
def get_shard(short_code):
    first_char = short_code[0]
    return hash(first_char) % NUM_SHARDS
```

### Read Replicas

- Each shard has 2 read replicas
- Redirects hit replicas (read-heavy)
- Writes go to primary

### Future Growth

- Add more shards by splitting existing ones
- Use consistent hashing for smoother rebalancing"

---

## Step 9: Analytics Pipeline

"Analytics is async - we don't block redirects for tracking.

### Pipeline Architecture

```
Redirect Request
       │
       ├─→ [Sync] Return 301 Redirect
       │
       └─→ [Async] Log to Kafka
                      │
                      ▼
               Kafka Consumer
                      │
                      ▼
               ClickHouse (OLAP)
                      │
                      ▼
               Analytics API
```

### Click Event Processing

```python
async def log_click(short_code, request):
    event = {
        "short_code": short_code,
        "timestamp": datetime.utcnow(),
        "referrer": request.headers.get("Referer"),
        "user_agent": request.headers.get("User-Agent"),
        "ip": request.remote_addr
    }
    # Fire-and-forget to Kafka
    kafka_producer.send("clicks", event)
```

### Why ClickHouse?

- Columnar storage: Great for aggregations
- Fast ingestion: Can handle our click volume
- SQL interface: Easy for analytics queries
- Compression: Clicks data compresses 10-20x"

---

## Step 10: Handling Custom Short Codes

"Custom codes (like `bit.ly/my-promo`) require special handling:

### Validation

```python
def validate_custom_code(code):
    # Length check
    if len(code) < 4 or len(code) > 20:
        raise ValidationError("Code must be 4-20 characters")

    # Character check
    if not re.match(r'^[a-zA-Z0-9-_]+$', code):
        raise ValidationError("Invalid characters")

    # Reserved words
    if code.lower() in ['admin', 'api', 'login', 'signup']:
        raise ValidationError("Reserved word")

    # Availability check
    if db.exists(code):
        raise ConflictError("Code already taken")

    return True
```

### Collision Prevention

- Custom codes go to same database as generated codes
- Pre-generated codes avoid collisions by checking against used codes
- Race condition: Use database unique constraint as final check"

---

## Step 11: High Availability

"For 99.99% uptime:

### Multi-Region Deployment

```
                    ┌─────────────────┐
                    │   Global DNS    │
                    │  (GeoDNS/Route53)│
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
    ┌─────────┐         ┌─────────┐         ┌─────────┐
    │ US-West │         │ US-East │         │ EU-West │
    │ Region  │         │ Region  │         │ Region  │
    └─────────┘         └─────────┘         └─────────┘
```

### Per-Region Stack

- API servers (3+ instances)
- Redis cluster (for local caching)
- Read replicas of database

### Cross-Region Replication

- Primary database in one region
- Async replication to other regions (few ms lag acceptable)
- Writes routed to primary region

### Failover

- Health checks on all components
- Automatic DNS failover (Route 53 health checks)
- Redis Sentinel for cache failover"

---

## Step 12: Security Considerations

"Several security aspects to address:

### Rate Limiting

- URL creation: 100 per hour per IP (prevent abuse)
- Redirects: 1000 per second per short code (prevent DDoS amplification)

### Malicious URL Detection

```python
def is_safe_url(long_url):
    # Check against Google Safe Browsing API
    # Check against internal blacklist
    # Scan for phishing patterns
    return safe_browsing_api.check(long_url)
```

### Input Validation

- Validate URL format (prevent XSS in redirects)
- Sanitize custom short codes
- Limit URL length (prevent storage abuse)

### Link Privacy

- Optional: Password-protected links
- Optional: One-time-use links
- Analytics opt-out for privacy-conscious users"

---

## Step 13: Trade-offs Summary

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| ID Generation | Pre-generated key pool | Counter, Hash | Scalable, unique, random |
| Database | PostgreSQL (sharded) | Cassandra, DynamoDB | ACID for custom codes, familiar |
| Cache | Redis Cluster | Memcached | Rich data types, persistence |
| Analytics | Kafka + ClickHouse | Direct to DB | Decoupled, handles spikes |
| Redirect Code | 301 | 302 | Performance, browser caching |

---

## Step 14: What Would Break First?

"Under extreme load:

1. **Database writes**: Key pool exhaustion → Pre-generate more keys in background
2. **Cache stampede**: Viral link cold cache → Use probabilistic early expiration
3. **Single hot URL**: One URL gets 50% traffic → Local in-memory cache + CDN

For a truly viral link, I'd put the redirect behind a CDN like CloudFlare, which can cache 301 redirects at the edge."

---

## Summary

"To summarize my design:

1. **Short Code Generation**: Pre-generated key pool for uniqueness and scalability
2. **Storage**: Sharded PostgreSQL by short_code prefix
3. **Caching**: Two-tier (local + Redis) for 99%+ cache hit rate
4. **Analytics**: Async pipeline via Kafka to ClickHouse
5. **Availability**: Multi-region with read replicas and DNS failover

The key insights are:
- This is a read-heavy system (100:1 ratio) - cache aggressively
- Short code generation is the interesting problem - pre-generation solves it elegantly
- Decouple analytics from the redirect path for reliability

Should I dive deeper into any specific component?"
