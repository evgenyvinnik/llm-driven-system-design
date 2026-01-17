# LinkedIn - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design LinkedIn, a professional social network where users build career profiles, connect with colleagues, and discover job opportunities. The core challenge is efficiently managing a social graph at massive scale while computing recommendations like 'People You May Know' and job-candidate matching.

This involves three key technical challenges: storing and traversing a graph with billions of edges, building multi-factor recommendation algorithms that run efficiently, and designing a feed ranking system that balances recency with professional relevance."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Profiles**: Create and edit professional history, skills, education
- **Connections**: Send requests, accept, view 1st/2nd/3rd degree network
- **Feed**: Posts from connections ranked by relevance
- **Jobs**: Companies post listings, users apply, matching algorithm
- **Search**: Find people, companies, and jobs
- **PYMK**: "People You May Know" recommendations

### Non-Functional Requirements
- **Latency**: < 200ms for feed, < 500ms for PYMK
- **Scale**: 900M users, 100B+ connections
- **Availability**: 99.9% uptime
- **Consistency**: Eventual for feed, strong for connection state

### Scale Estimates
- **Daily Active Users**: 300M+
- **New connections/day**: 100M+
- **Job applications/day**: 10M+
- **Profile views/day**: 1B+

### Key Questions I'd Ask
1. How deep should we traverse for PYMK (2nd degree vs 3rd)?
2. Should feed be purely chronological or algorithmically ranked?
3. What signals matter most for job-candidate matching?

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                             │
│              React + Professional UI Components                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API Gateway                              │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Profile Service│    │ Graph Service │    │  Job Service  │
│               │    │               │    │               │
│ - CRUD profile│    │ - Connections │    │ - Listings    │
│ - Skills      │    │ - Degrees     │    │ - Matching    │
│ - Experience  │    │ - PYMK        │    │ - Applications│
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │   Graph Cache     │    Elasticsearch          │
│   - Profiles    │   - Connections   │    - Profile search       │
│   - Jobs        │   - 2nd degree    │    - Job search           │
│   - Companies   │   (Redis/Valkey)  │    - Skill matching       │
└─────────────────┴───────────────────┴───────────────────────────┘
```

### Core Components

1. **Profile Service**: CRUD for professional profiles, skills, experience
2. **Graph Service**: Connection management, degree calculations, PYMK
3. **Job Service**: Listings, applications, candidate matching
4. **Search Service**: Elasticsearch for people, companies, jobs
5. **Feed Service**: Post aggregation and ranking

### Why Not a Full Graph Database?

Most LinkedIn queries are 1-2 hops (direct connections, mutual friends). PostgreSQL handles these efficiently with proper indexing. Graph databases like Neo4j add operational complexity without proportional benefit for our query patterns.

## Deep Dive: Connection Degrees and PYMK (8 minutes)

This is the heart of LinkedIn's social value. "People You May Know" drives a huge percentage of new connections.

### Connection Degree Calculation

**1st Degree**: Direct SQL lookup

```sql
SELECT connected_to FROM connections WHERE user_id = $1
```

**2nd Degree**: Friends of friends

```sql
-- Approach 1: SQL Join (works for moderate networks)
SELECT DISTINCT c2.connected_to
FROM connections c1
JOIN connections c2 ON c1.connected_to = c2.user_id
WHERE c1.user_id = $1
  AND c2.connected_to != $1
  AND c2.connected_to NOT IN (SELECT connected_to FROM connections WHERE user_id = $1)
```

**At Scale**: This query explodes. A user with 500 connections, each with 500 connections = 250,000 rows to process.

### Precomputed Approach (Production)

```javascript
// Nightly batch job computes 2nd-degree for all users
async function computeSecondDegree(userId) {
  const firstDegree = await getConnections(userId);
  const secondDegree = new Map(); // candidateId -> mutual count

  for (const friendId of firstDegree) {
    const friendConnections = await getConnections(friendId);
    for (const candidate of friendConnections) {
      if (candidate === userId) continue;
      if (firstDegree.has(candidate)) continue;

      secondDegree.set(candidate, (secondDegree.get(candidate) || 0) + 1);
    }
  }

  // Store top 1000 with mutual counts in Redis
  await redis.set(`2nd-degree:${userId}`, topK(secondDegree, 1000));
}
```

### PYMK Scoring Algorithm

```javascript
function pymkScore(userId, candidateId) {
  let score = 0;

  // Mutual connections (strongest signal)
  const mutuals = getMutualConnections(userId, candidateId);
  score += mutuals.length * 10;

  // Same current company
  if (sameCurrentCompany(userId, candidateId)) score += 8;

  // Same past company
  if (samePastCompany(userId, candidateId)) score += 5;

  // Same school
  if (sameSchool(userId, candidateId)) score += 5;

  // Shared skills
  const sharedSkills = getSharedSkills(userId, candidateId);
  score += sharedSkills.length * 2;

  // Same industry
  if (sameIndustry(userId, candidateId)) score += 3;

  // Same location
  if (sameLocation(userId, candidateId)) score += 2;

  return score;
}
```

### Why These Weights?

- **Mutual connections (10 pts)**: Strongest predictor of professional relationship
- **Same company (8 pts)**: Colleagues should connect
- **Same school (5 pts)**: Alumni networks are valuable
- **Skills/Industry**: Professional affinity

Weights are tuned based on connection accept rates from A/B testing.

### Caching Strategy

```
Redis Structure:
- connections:{userId} = SET of connection IDs (for quick lookups)
- pymk:{userId} = SORTED SET of candidate IDs by score
- mutuals:{userId}:{candidateId} = CACHED count (TTL: 1 hour)
```

## Deep Dive: Job-Candidate Matching (6 minutes)

Two-sided matching: Jobs need candidates, candidates need jobs.

### Multi-Factor Scoring

```javascript
function jobMatchScore(job, candidate) {
  let score = 0;

  // Required skills match (40% weight)
  const requiredSkills = job.requiredSkills;
  const candidateSkills = candidate.skills;
  const skillMatch = intersection(requiredSkills, candidateSkills).length;
  score += (skillMatch / requiredSkills.length) * 40;

  // Experience level (25% weight)
  const expMatch = Math.abs(job.yearsRequired - candidate.yearsExperience);
  score += Math.max(0, 25 - expMatch * 5);

  // Location compatibility (15% weight)
  if (job.remote || sameLocation(job, candidate)) score += 15;

  // Education match (10% weight)
  if (educationMeets(job.education, candidate.education)) score += 10;

  // Network connection (10% weight - referral potential)
  if (hasConnectionAtCompany(candidate, job.companyId)) score += 10;

  return score;
}
```

### Indexing for Search

```javascript
// Elasticsearch mapping for jobs
{
  "mappings": {
    "properties": {
      "title": { "type": "text", "boost": 3 },
      "description": { "type": "text" },
      "required_skills": { "type": "keyword" },
      "location": { "type": "geo_point" },
      "salary_range": { "type": "integer_range" },
      "remote": { "type": "boolean" },
      "posted_at": { "type": "date" }
    }
  }
}
```

### Matching Architecture

1. **Real-time**: When candidate searches, score top jobs dynamically
2. **Batch**: Nightly compute "Jobs for You" - top matches per candidate
3. **Alerts**: When new job matches skills/preferences, send notification

## Deep Dive: Feed Ranking (5 minutes)

Unlike Twitter, LinkedIn's feed is algorithmically ranked for professional relevance.

### Ranking Signals

```javascript
function feedScore(post, viewerUserId) {
  let score = 0;

  // Recency (exponential decay)
  const hoursOld = (Date.now() - post.createdAt) / (1000 * 60 * 60);
  score += Math.exp(-hoursOld / 24) * 20; // Half-life of ~24 hours

  // Author relationship
  const degree = connectionDegree(viewerUserId, post.authorId);
  if (degree === 1) score += 15;
  else if (degree === 2) score += 8;

  // Engagement rate
  const engagementRate = (post.likes + post.comments * 2) / post.views;
  score += Math.min(engagementRate * 100, 20);

  // Content type preference (learned from user behavior)
  const typeAffinity = getUserContentAffinity(viewerUserId, post.type);
  score += typeAffinity * 10;

  // Author affinity (do they engage with this author?)
  const authorAffinity = getAuthorAffinity(viewerUserId, post.authorId);
  score += authorAffinity * 15;

  return score;
}
```

### Feed Generation Pipeline

1. **Candidate Generation**: Get posts from connections + followed companies + engaged-with authors
2. **First Pass Ranking**: Quick scoring to get top 1000
3. **Heavy Ranking**: Full model scoring on top 1000
4. **Diversity Injection**: Ensure variety (not all from same author)
5. **Cache**: Store ranked feed for 15 minutes

## Trade-offs and Alternatives (5 minutes)

### 1. PostgreSQL vs. Graph Database

**Chose: PostgreSQL + Redis cache**
- Pro: Simpler operations, familiar technology
- Pro: 1-2 hop queries efficient with good indexes
- Con: Deep traversals (3+ hops) are expensive
- Trade-off: We rarely need 3+ hop queries

### 2. Real-time vs. Precomputed PYMK

**Chose: Precomputed with daily refresh**
- Pro: Consistent low latency
- Pro: Expensive computation done once
- Con: New connections take up to 24 hours to reflect
- Alternative: Hybrid - precompute base, adjust in real-time for recent connections

### 3. Search Technology

**Chose: Elasticsearch**
- Pro: Excellent text search, faceting, geo
- Pro: Proven at LinkedIn's scale
- Con: Operational complexity
- Alternative: PostgreSQL FTS (simpler, less powerful)

### 4. Skill Normalization

**Chose: Normalized skills table**
- Pro: Standardized skill names across users
- Pro: Enables skill-based matching
- Con: Need synonym mapping (JS === JavaScript)
- Alternative: Free-text skills (simpler, harder to match)

### 5. Feed Ordering

**Chose: Algorithmic ranking**
- Pro: Higher engagement, more relevant content
- Con: Less predictable, "filter bubble" concerns
- Alternative: Chronological (simpler, less engaging)

### Scalability Considerations

**Database Sharding**:
- Shard users by user_id
- Connections table sharded by follower_id
- Cross-shard queries for mutual connections (expensive, hence caching)

**Read Replicas**:
- Profile reads from replicas
- Connection state from primary (strong consistency)

## Closing Summary (1 minute)

"LinkedIn's architecture centers on three key systems:

1. **Graph service with intelligent caching** - Precomputing 2nd-degree connections and PYMK scores nightly, caching in Redis for fast access. This trades freshness for predictable latency.

2. **Multi-factor matching algorithms** - Both PYMK and job matching use weighted scoring across multiple signals (mutual connections, shared experience, skills). Weights are tuned via A/B testing on accept/apply rates.

3. **Algorithmic feed ranking** - Balancing recency, relationship strength, and engagement to surface relevant professional content.

The main trade-off is complexity vs. scale. We chose PostgreSQL over a graph database because our query patterns (1-2 hops) don't justify the operational overhead. For future improvements, I'd focus on real-time PYMK updates for recent connections and implementing ML-based ranking models for feed and job matching."
