# Design LinkedIn - Architecture

## System Overview

LinkedIn is a professional social network where users build career profiles, connect with colleagues, and discover job opportunities. Core challenges involve graph traversal for connections and multi-factor recommendation algorithms.

**Learning Goals:**
- Design efficient social graph storage and traversal
- Build recommendation engines (PYMK, job matching)
- Implement feed ranking with multiple signals
- Handle company-employee relationships

---

## Requirements

### Functional Requirements

1. **Profiles**: Professional history, skills, education
2. **Connections**: Request, accept, view network
3. **Feed**: Posts from connections, ranked by relevance
4. **Jobs**: Post listings, apply, match candidates
5. **Search**: Find people, companies, jobs

### Non-Functional Requirements

- **Latency**: < 200ms for feed, < 500ms for PYMK
- **Scale**: 900M users, 100B connections
- **Availability**: 99.9% uptime
- **Consistency**: Eventual for feed, strong for connections

---

## High-Level Architecture

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
│   PostgreSQL    │   Graph Store     │    Elasticsearch          │
│   - Profiles    │   - Connections   │    - Profile search       │
│   - Jobs        │   - Traversals    │    - Job search           │
│   - Companies   │   (Neo4j or       │    - Skill matching       │
│                 │   PostgreSQL)     │                           │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Connection Degrees

**Challenge**: Given user A, find all 2nd-degree connections efficiently

**Approach 1: SQL Recursive CTE**
```sql
WITH RECURSIVE connection_degrees AS (
  -- First degree
  SELECT connected_to as user_id, 1 as degree
  FROM connections WHERE user_id = $1

  UNION

  -- Second degree
  SELECT c.connected_to, cd.degree + 1
  FROM connections c
  JOIN connection_degrees cd ON c.user_id = cd.user_id
  WHERE cd.degree < 2
)
SELECT DISTINCT user_id, MIN(degree) as degree
FROM connection_degrees
GROUP BY user_id;
```

**Approach 2: Graph Database (Neo4j)**
```cypher
MATCH (me:User {id: $userId})-[:CONNECTED*1..2]-(other:User)
WHERE other.id <> $userId
RETURN other.id, min(length(path)) as degree
```

**Approach 3: Precomputed + Cache (Chosen for scale)**
- Precompute 2nd-degree connections nightly
- Store in Valkey sorted sets
- Refresh incrementally on new connections

### 2. People You May Know (PYMK)

**Scoring Factors:**
```javascript
function pymkScore(userId, candidateId) {
  let score = 0

  // Mutual connections (strongest signal)
  const mutuals = getMutualConnections(userId, candidateId)
  score += mutuals.length * 10

  // Same company (current or past)
  if (sameCompany(userId, candidateId)) score += 8

  // Same school
  if (sameSchool(userId, candidateId)) score += 5

  // Shared skills
  const sharedSkills = getSharedSkills(userId, candidateId)
  score += sharedSkills.length * 2

  // Same industry
  if (sameIndustry(userId, candidateId)) score += 3

  // Geographic proximity
  if (sameLocation(userId, candidateId)) score += 2

  return score
}
```

**Batch Processing:**
- Run PYMK calculation daily in background
- Store top 100 candidates per user
- Invalidate on new connections

### 3. Job-Candidate Matching

**Multi-Factor Scoring:**
```javascript
function jobMatchScore(job, candidate) {
  let score = 0

  // Required skills match
  const requiredSkills = job.requiredSkills
  const candidateSkills = candidate.skills
  const skillMatch = intersection(requiredSkills, candidateSkills).length
  score += (skillMatch / requiredSkills.length) * 40

  // Experience level
  const expMatch = Math.abs(job.yearsRequired - candidate.yearsExperience)
  score += Math.max(0, 25 - expMatch * 5)

  // Location compatibility
  if (job.remote || sameLocation(job, candidate)) score += 15

  // Education match
  if (educationMeets(job.education, candidate.education)) score += 10

  // Company connection (knows someone there)
  if (hasConnectionAtCompany(candidate, job.companyId)) score += 10

  return score
}
```

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  headline VARCHAR(200),
  location VARCHAR(100),
  industry VARCHAR(100),
  connection_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Experience
CREATE TABLE experiences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  company_id INTEGER REFERENCES companies(id),
  title VARCHAR(200),
  start_date DATE,
  end_date DATE,
  description TEXT,
  is_current BOOLEAN DEFAULT FALSE
);

-- Connections
CREATE TABLE connections (
  user_id INTEGER REFERENCES users(id),
  connected_to INTEGER REFERENCES users(id),
  connected_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, connected_to)
);

-- Skills
CREATE TABLE skills (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE
);

CREATE TABLE user_skills (
  user_id INTEGER REFERENCES users(id),
  skill_id INTEGER REFERENCES skills(id),
  endorsement_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, skill_id)
);

-- Jobs
CREATE TABLE jobs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  title VARCHAR(200),
  description TEXT,
  location VARCHAR(100),
  is_remote BOOLEAN DEFAULT FALSE,
  years_required INTEGER,
  required_skills INTEGER[],
  posted_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Hybrid Graph Storage

**Decision**: PostgreSQL for profile data, optional Neo4j for deep traversals

**Rationale**:
- Most queries are 1-2 hops (efficient in SQL)
- Neo4j for complex PYMK calculations (optional)
- Keeps primary stack simple

### 2. Precomputed Recommendations

**Decision**: Batch compute PYMK and job matches offline

**Rationale**:
- Expensive calculations (millions of comparisons)
- Results don't need real-time freshness
- Cache invalidated on relevant changes

### 3. Skills as First-Class Entities

**Decision**: Normalized skills table with endorsements

**Rationale**:
- Enables skill-based search and matching
- Standardizes skill names across users
- Supports endorsement counting

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Graph storage | PostgreSQL + cache | Neo4j | Simplicity |
| PYMK | Batch precompute | Real-time | Cost efficiency |
| Search | Elasticsearch | PostgreSQL FTS | Better relevance |
| Skills | Normalized table | JSON array | Queryable, standardized |
