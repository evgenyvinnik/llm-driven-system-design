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

This section documents the complete PostgreSQL schema for the LinkedIn system, including all tables, relationships, indexes, and the rationale behind key design decisions.

### Entity-Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    LINKEDIN DATABASE SCHEMA                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────┘

                                    ┌─────────────┐
                                    │  companies  │
                                    ├─────────────┤
                                    │ id (PK)     │
                                    │ name        │
                                    │ slug (UQ)   │
                                    │ industry    │
                                    │ size        │
                                    │ location    │
                                    └──────┬──────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              │                            │                            │
              ▼ 1:N                        ▼ 1:N                        ▼ 1:N
    ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
    │   experiences   │          │      jobs       │          │      jobs       │
    ├─────────────────┤          ├─────────────────┤          │ (posted_by_user)│
    │ id (PK)         │          │ id (PK)         │          └────────┬────────┘
    │ user_id (FK)    │          │ company_id (FK) │                   │
    │ company_id (FK) │          │ posted_by (FK)──┼───────────────────┤
    │ title           │          │ title           │                   │
    │ is_current      │          │ status          │                   │
    └────────┬────────┘          └────────┬────────┘                   │
             │                            │                            │
             │                            ├─────────────┐              │
             │                            │             │              │
             │                            ▼ M:N         ▼ 1:N          │
             │                   ┌─────────────────┐  ┌──────────────┐ │
             │                   │   job_skills    │  │    job_      │ │
             │                   ├─────────────────┤  │ applications │ │
             │                   │ job_id (PK,FK)  │  ├──────────────┤ │
             │                   │ skill_id (PK,FK)│  │ id (PK)      │ │
             │                   │ is_required     │  │ job_id (FK)  │ │
             │                   └────────┬────────┘  │ user_id (FK) │ │
             │                            │           │ status       │ │
             │                            │           │ match_score  │ │
             │                            ▼           └──────┬───────┘ │
             │                   ┌─────────────────┐         │         │
             │                   │     skills      │         │         │
             │                   ├─────────────────┤         │         │
             │                   │ id (PK)         │         │         │
             │                   │ name (UQ)       │         │         │
             │                   └────────┬────────┘         │         │
             │                            │                  │         │
             │                            ▼ M:N              │         │
             │                   ┌─────────────────┐         │         │
             │                   │   user_skills   │         │         │
             │                   ├─────────────────┤         │         │
             │                   │ user_id (PK,FK) │         │         │
             │                   │ skill_id (PK,FK)│         │         │
             │                   │ endorsement_cnt │         │         │
             │                   └────────┬────────┘         │         │
             │                            │                  │         │
             ▼                            ▼                  ▼         ▼
    ┌─────────────────────────────────────────────────────────────────────────────┐
    │                                   users                                      │
    ├─────────────────────────────────────────────────────────────────────────────┤
    │ id (PK) │ email (UQ) │ first_name │ last_name │ headline │ role │ location │
    └─────────────────────────────────────────────────────────────────────────────┘
             │                   │                            │
             │                   │                            │
    ┌────────┴────────┐ ┌───────┴───────┐           ┌────────┴────────┐
    │                 │ │               │           │                 │
    ▼ 1:N             ▼ 1:N             ▼ M:N       ▼ 1:N             ▼ 1:N
┌───────────┐   ┌───────────┐   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ education │   │   posts   │   │ connections │ │ connection_ │ │ audit_logs  │
├───────────┤   ├───────────┤   ├─────────────┤ │  requests   │ ├─────────────┤
│ id (PK)   │   │ id (PK)   │   │user_id(PK,FK│ ├─────────────┤ │ id (PK)     │
│ user_id   │   │ user_id   │   │connected_to │ │ id (PK)     │ │ event_type  │
│school_name│   │ content   │   │ (PK,FK)     │ │from_user_id │ │ actor_id(FK)│
│ degree    │   │like_count │   │ CHECK:      │ │ to_user_id  │ │ target_type │
│ field     │   │comment_cnt│   │user<connected│ │ status     │ │ details     │
└───────────┘   └─────┬─────┘   └─────────────┘ └─────────────┘ └─────────────┘
                      │
         ┌────────────┴────────────┐
         │                         │
         ▼ 1:N                     ▼ M:N
    ┌───────────────┐       ┌───────────────┐
    │ post_comments │       │  post_likes   │
    ├───────────────┤       ├───────────────┤
    │ id (PK)       │       │ user_id(PK,FK)│
    │ post_id (FK)  │       │ post_id(PK,FK)│
    │ user_id (FK)  │       │ created_at    │
    │ content       │       └───────────────┘
    └───────────────┘

Legend: PK = Primary Key, FK = Foreign Key, UQ = Unique, M:N = Many-to-Many
```

### Complete Table Definitions

#### 1. Core Entities

**companies** - Organizations where users work or have worked

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| name | VARCHAR(255) | NOT NULL | Company display name |
| slug | VARCHAR(255) | UNIQUE NOT NULL | URL-friendly identifier |
| description | TEXT | | Company description/about |
| industry | VARCHAR(100) | | Industry category |
| size | VARCHAR(50) | | Employee count range (e.g., '51-200') |
| location | VARCHAR(100) | | Headquarters location |
| website | VARCHAR(255) | | Company website URL |
| logo_url | VARCHAR(500) | | Company logo image URL |
| created_at | TIMESTAMP | DEFAULT NOW() | Record creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last modification timestamp |

**users** - Core user profile information

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| email | VARCHAR(255) | UNIQUE NOT NULL | Login email address |
| password_hash | VARCHAR(255) | NOT NULL | bcrypt hashed password |
| first_name | VARCHAR(100) | NOT NULL | User's first name |
| last_name | VARCHAR(100) | NOT NULL | User's last name |
| headline | VARCHAR(200) | | Professional tagline (e.g., "Software Engineer at Google") |
| summary | TEXT | | About section / bio |
| location | VARCHAR(100) | | Current location |
| industry | VARCHAR(100) | | Primary industry |
| profile_image_url | VARCHAR(500) | | Profile photo URL |
| banner_image_url | VARCHAR(500) | | Profile banner URL |
| connection_count | INTEGER | DEFAULT 0 | Denormalized 1st-degree connection count |
| role | VARCHAR(20) | DEFAULT 'user' | Role: 'user', 'recruiter', 'admin' |
| created_at | TIMESTAMP | DEFAULT NOW() | Account creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last profile update timestamp |

#### 2. Skills (Normalized)

**skills** - Master list of skills for standardization

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| name | VARCHAR(100) | UNIQUE NOT NULL | Skill name (e.g., "Python", "Machine Learning") |
| created_at | TIMESTAMP | DEFAULT NOW() | Record creation timestamp |

**user_skills** - Junction table for user-skill relationships

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| user_id | INTEGER | PK, FK -> users(id) | User who has this skill |
| skill_id | INTEGER | PK, FK -> skills(id) | Skill the user has |
| endorsement_count | INTEGER | DEFAULT 0 | Number of endorsements from connections |

#### 3. Professional History

**experiences** - Work history

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| user_id | INTEGER | FK -> users(id) | User this experience belongs to |
| company_id | INTEGER | FK -> companies(id) | Link to company (if in system) |
| company_name | VARCHAR(255) | NOT NULL | Denormalized company name |
| title | VARCHAR(200) | NOT NULL | Job title |
| location | VARCHAR(100) | | Job location |
| start_date | DATE | NOT NULL | Employment start date |
| end_date | DATE | | Employment end date (NULL if current) |
| description | TEXT | | Role description |
| is_current | BOOLEAN | DEFAULT FALSE | Currently employed here |
| created_at | TIMESTAMP | DEFAULT NOW() | Record creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last modification timestamp |

**education** - Academic history

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| user_id | INTEGER | FK -> users(id) | User this education belongs to |
| school_name | VARCHAR(255) | NOT NULL | Institution name |
| degree | VARCHAR(100) | | Degree type (e.g., "Bachelor of Science") |
| field_of_study | VARCHAR(100) | | Major/field (e.g., "Computer Science") |
| start_year | INTEGER | | Year started |
| end_year | INTEGER | | Year completed |
| description | TEXT | | Additional details |
| created_at | TIMESTAMP | DEFAULT NOW() | Record creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last modification timestamp |

#### 4. Connections (Social Graph)

**connections** - Bidirectional connection relationships

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| user_id | INTEGER | PK, FK -> users(id) | First user in connection (lower ID) |
| connected_to | INTEGER | PK, FK -> users(id) | Second user in connection (higher ID) |
| connected_at | TIMESTAMP | DEFAULT NOW() | When connection was formed |

*Note: The CHECK constraint `user_id < connected_to` ensures each connection is stored exactly once.*

**connection_requests** - Pending connection invitations

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| from_user_id | INTEGER | FK -> users(id) | User sending the request |
| to_user_id | INTEGER | FK -> users(id) | User receiving the request |
| message | TEXT | | Optional personalized message |
| status | VARCHAR(20) | DEFAULT 'pending' | Status: 'pending', 'accepted', 'declined', 'withdrawn' |
| created_at | TIMESTAMP | DEFAULT NOW() | Request sent timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last status change timestamp |

*Note: UNIQUE(from_user_id, to_user_id) prevents duplicate requests.*

#### 5. Feed and Content

**posts** - User-generated content

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| user_id | INTEGER | FK -> users(id) | Post author |
| content | TEXT | NOT NULL | Post text content |
| image_url | VARCHAR(500) | | Optional attached image |
| like_count | INTEGER | DEFAULT 0 | Denormalized like count |
| comment_count | INTEGER | DEFAULT 0 | Denormalized comment count |
| share_count | INTEGER | DEFAULT 0 | Denormalized share count |
| created_at | TIMESTAMP | DEFAULT NOW() | Post creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last edit timestamp |

**post_likes** - Tracks which users liked which posts

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| user_id | INTEGER | PK, FK -> users(id) | User who liked |
| post_id | INTEGER | PK, FK -> posts(id) | Post that was liked |
| created_at | TIMESTAMP | DEFAULT NOW() | When like occurred |

**post_comments** - Comments on posts

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| post_id | INTEGER | FK -> posts(id) | Parent post |
| user_id | INTEGER | FK -> users(id) | Comment author |
| content | TEXT | NOT NULL | Comment text |
| created_at | TIMESTAMP | DEFAULT NOW() | Comment timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last edit timestamp |

#### 6. Jobs and Applications

**jobs** - Job postings

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| company_id | INTEGER | FK -> companies(id) | Hiring company |
| posted_by_user_id | INTEGER | FK -> users(id) | Recruiter who posted |
| title | VARCHAR(200) | NOT NULL | Job title |
| description | TEXT | NOT NULL | Full job description |
| location | VARCHAR(100) | | Job location |
| is_remote | BOOLEAN | DEFAULT FALSE | Remote work allowed |
| employment_type | VARCHAR(50) | | 'full-time', 'part-time', 'contract', 'internship' |
| experience_level | VARCHAR(50) | | 'entry', 'associate', 'mid-senior', 'director', 'executive' |
| years_required | INTEGER | | Minimum years of experience |
| salary_min | INTEGER | | Minimum salary (annual) |
| salary_max | INTEGER | | Maximum salary (annual) |
| status | VARCHAR(20) | DEFAULT 'active' | 'active', 'closed', 'filled', 'draft' |
| created_at | TIMESTAMP | DEFAULT NOW() | Posted timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last edit timestamp |

**job_skills** - Required skills for jobs

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| job_id | INTEGER | PK, FK -> jobs(id) | Job posting |
| skill_id | INTEGER | PK, FK -> skills(id) | Required skill |
| is_required | BOOLEAN | DEFAULT TRUE | TRUE = required, FALSE = nice-to-have |

**job_applications** - User applications to jobs

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| job_id | INTEGER | FK -> jobs(id) | Job applied to |
| user_id | INTEGER | FK -> users(id) | Applicant |
| resume_url | VARCHAR(500) | | Uploaded resume URL |
| cover_letter | TEXT | | Application cover letter |
| status | VARCHAR(20) | DEFAULT 'pending' | 'pending', 'reviewed', 'interviewing', 'offered', 'rejected', 'withdrawn' |
| match_score | INTEGER | | AI-computed fit score (0-100) |
| created_at | TIMESTAMP | DEFAULT NOW() | Application timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last status change |

*Note: UNIQUE(job_id, user_id) ensures one application per user per job.*

#### 7. Audit and Security

**audit_logs** - Security-sensitive operation tracking

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing identifier |
| event_type | VARCHAR(100) | NOT NULL | Event category (e.g., 'auth.login.success') |
| actor_id | INTEGER | FK -> users(id) | User who performed action |
| actor_ip | INET | | IP address of actor |
| target_type | VARCHAR(50) | | Entity type: 'user', 'profile', 'connection', 'post', 'job', 'session' |
| target_id | INTEGER | | ID of entity acted upon |
| action | VARCHAR(50) | NOT NULL | Short action description |
| details | JSONB | DEFAULT '{}' | Event-specific data |
| created_at | TIMESTAMP | DEFAULT NOW() | Event timestamp |

### Foreign Key Relationships and Cascade Behaviors

| Parent Table | Child Table | FK Column | ON DELETE | Rationale |
|--------------|-------------|-----------|-----------|-----------|
| users | user_skills | user_id | CASCADE | Skills meaningless without user |
| skills | user_skills | skill_id | CASCADE | Remove user-skill links when skill deleted |
| users | experiences | user_id | CASCADE | Work history belongs to user |
| companies | experiences | company_id | SET NULL | Keep experience record even if company deleted |
| users | education | user_id | CASCADE | Education belongs to user |
| users | connections | user_id | CASCADE | Remove connection when user deleted |
| users | connections | connected_to | CASCADE | Remove connection when user deleted |
| users | connection_requests | from_user_id | CASCADE | Request meaningless without sender |
| users | connection_requests | to_user_id | CASCADE | Request meaningless without recipient |
| users | posts | user_id | CASCADE | Posts belong to author |
| users | post_likes | user_id | CASCADE | Like records removed with user |
| posts | post_likes | post_id | CASCADE | Like records removed with post |
| posts | post_comments | post_id | CASCADE | Comments removed with post |
| users | post_comments | user_id | CASCADE | Comments removed with author |
| companies | jobs | company_id | CASCADE | Jobs belong to company |
| users | jobs | posted_by_user_id | SET NULL | Keep job even if recruiter leaves |
| jobs | job_skills | job_id | CASCADE | Skill requirements belong to job |
| skills | job_skills | skill_id | CASCADE | Remove requirement when skill deleted |
| jobs | job_applications | job_id | CASCADE | Applications belong to job |
| users | job_applications | user_id | CASCADE | Applications belong to applicant |
| users | audit_logs | actor_id | SET NULL | Keep audit trail even if user deleted |

**Rationale for Cascade Choices:**

1. **CASCADE for user-owned data**: When a user deletes their account, their posts, comments, connections, and applications should be removed to respect data deletion requests (GDPR compliance).

2. **SET NULL for references that should persist**:
   - `experiences.company_id`: A user's work history should remain visible even if the company profile is deleted from the system.
   - `jobs.posted_by_user_id`: Job listings should remain active even if the recruiter who posted them leaves the company.
   - `audit_logs.actor_id`: Security audit trails must persist for compliance, even after user account deletion.

3. **CASCADE for junction tables**: Many-to-many relationship records (user_skills, job_skills, post_likes) have no meaning without both sides of the relationship.

### Indexes

```sql
-- User lookups
CREATE INDEX idx_users_email ON users(email);

-- Experience queries (profile view, company employee lists)
CREATE INDEX idx_experiences_user_id ON experiences(user_id);
CREATE INDEX idx_experiences_company_id ON experiences(company_id);

-- Education queries (profile view)
CREATE INDEX idx_education_user_id ON education(user_id);

-- Feed queries (posts by user, chronological feed)
CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);

-- Job search and listing
CREATE INDEX idx_jobs_company_id ON jobs(company_id);
CREATE INDEX idx_jobs_status ON jobs(status);

-- Application tracking
CREATE INDEX idx_job_applications_user_id ON job_applications(user_id);
CREATE INDEX idx_job_applications_job_id ON job_applications(job_id);

-- Connection request notifications
CREATE INDEX idx_connection_requests_to_user ON connection_requests(to_user_id, status);

-- Audit log queries
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id, created_at);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_type, target_id, created_at);
CREATE INDEX idx_audit_logs_event ON audit_logs(event_type, created_at);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);

-- Partial index for admin action compliance queries
CREATE INDEX idx_audit_logs_admin ON audit_logs(created_at)
  WHERE event_type LIKE 'admin.%';
```

### Design Rationale

#### Why Normalize Skills?

Skills are normalized into a separate `skills` table rather than stored as arrays or JSON because:

1. **Standardization**: Ensures "JavaScript", "javascript", and "JS" map to a single canonical skill
2. **Searchability**: Enables efficient skill-based user and job search
3. **Matching**: Powers job-candidate matching algorithms by comparing skill IDs
4. **Analytics**: Allows trending skills analysis and skill gap identification

#### Why Store Connections Once with CHECK Constraint?

The `connections` table uses `CHECK (user_id < connected_to)` to store each bidirectional connection exactly once:

```sql
-- Alice (id=5) connects with Bob (id=10)
-- Stored as: (5, 10) regardless of who initiated
-- NOT stored: (10, 5) - would violate CHECK constraint
```

Benefits:
- **50% storage reduction**: One row per connection instead of two
- **No duplicates**: Constraint prevents accidental duplicate entries
- **Consistent queries**: Finding connections requires checking both directions:
  ```sql
  SELECT connected_to FROM connections WHERE user_id = $1
  UNION
  SELECT user_id FROM connections WHERE connected_to = $1
  ```

#### Why Denormalize Counts?

Several tables include denormalized counts (`connection_count`, `like_count`, `comment_count`):

1. **Performance**: Avoids COUNT(*) queries on every profile/post view
2. **Scale**: At LinkedIn scale (billions of connections), counting is expensive
3. **Trade-off**: Requires maintaining counts via triggers or application logic

Count updates use atomic operations:
```sql
UPDATE posts SET like_count = like_count + 1 WHERE id = $1;
```

#### Why company_name in Experiences?

The `experiences` table includes both `company_id` (FK) and `company_name` (VARCHAR):

1. **company_id**: Links to company profile for rich display (logo, link to company page)
2. **company_name**: Denormalized copy for cases where:
   - Company doesn't exist in system (small/defunct companies)
   - Company is deleted but experience should persist
   - Fast display without JOINs

### Data Flow for Key Operations

#### 1. Sending a Connection Request

```
User A clicks "Connect" on User B's profile
         │
         ▼
┌─────────────────────────────────────────┐
│ INSERT INTO connection_requests         │
│ (from_user_id, to_user_id, message)     │
│ VALUES (A, B, 'Hi, let''s connect!')    │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ INSERT INTO audit_logs                  │
│ (event_type, actor_id, target_type,     │
│  target_id, action, details)            │
│ VALUES ('connection.request', A,         │
│  'user', B, 'sent', '{}')               │
└────────────────────┬────────────────────┘
                     │
                     ▼
         Queue notification for User B
```

#### 2. Accepting a Connection Request

```
User B accepts User A's request
         │
         ▼
┌─────────────────────────────────────────┐
│ BEGIN TRANSACTION                       │
├─────────────────────────────────────────┤
│ UPDATE connection_requests              │
│ SET status = 'accepted'                 │
│ WHERE from_user_id = A AND to_user_id = B│
├─────────────────────────────────────────┤
│ INSERT INTO connections                 │
│ (user_id, connected_to)                 │
│ VALUES (MIN(A,B), MAX(A,B))             │
├─────────────────────────────────────────┤
│ UPDATE users SET connection_count =     │
│   connection_count + 1 WHERE id IN (A,B)│
├─────────────────────────────────────────┤
│ COMMIT                                  │
└────────────────────┬────────────────────┘
                     │
                     ▼
         Queue PYMK recalculation for A and B
         Queue notification for User A
```

#### 3. Creating a Post

```
User creates post with content
         │
         ▼
┌─────────────────────────────────────────┐
│ INSERT INTO posts                       │
│ (user_id, content, image_url)           │
│ VALUES ($userId, $content, $imageUrl)   │
│ RETURNING id                            │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ Index post in Elasticsearch             │
│ for content search                      │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ Queue: feed.generate                    │
│ Fanout to all connections' feeds        │
│ (async via RabbitMQ)                    │
└─────────────────────────────────────────┘
```

#### 4. Applying for a Job

```
User applies to job posting
         │
         ▼
┌─────────────────────────────────────────┐
│ INSERT INTO job_applications            │
│ (job_id, user_id, resume_url,           │
│  cover_letter, status)                  │
│ VALUES ($jobId, $userId, $resumeUrl,    │
│  $coverLetter, 'pending')               │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ Queue: jobs.match                       │
│ Calculate match_score based on:         │
│ - User skills vs job_skills             │
│ - Years experience vs years_required    │
│ - Location compatibility                │
│ - Education match                       │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ UPDATE job_applications                 │
│ SET match_score = $calculatedScore      │
│ WHERE id = $applicationId               │
└────────────────────┬────────────────────┘
                     │
                     ▼
         Notify recruiter of new application
```

#### 5. Feed Generation (Query)

```
User loads their feed
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ -- Get posts from 1st-degree connections                    │
│ WITH user_connections AS (                                  │
│   SELECT connected_to AS conn_id FROM connections           │
│   WHERE user_id = $userId                                   │
│   UNION                                                     │
│   SELECT user_id AS conn_id FROM connections                │
│   WHERE connected_to = $userId                              │
│ )                                                           │
│ SELECT p.*, u.first_name, u.last_name, u.headline,          │
│        u.profile_image_url,                                 │
│        -- Ranking score                                     │
│        (p.like_count * 0.3 +                                │
│         p.comment_count * 0.5 +                             │
│         EXTRACT(EPOCH FROM NOW() - p.created_at) / -3600    │
│        ) AS rank_score                                      │
│ FROM posts p                                                │
│ JOIN users u ON p.user_id = u.id                            │
│ WHERE p.user_id IN (SELECT conn_id FROM user_connections)   │
│    OR p.user_id = $userId                                   │
│ ORDER BY rank_score DESC                                    │
│ LIMIT 20 OFFSET $offset                                     │
└─────────────────────────────────────────────────────────────┘
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

## Async Processing and Message Queues

For background jobs, fanout operations, and handling backpressure, we use RabbitMQ with well-defined delivery semantics.

### Queue Architecture

```
┌──────────────┐     ┌─────────────────────────────────────────────────────┐
│ API Services │────▶│                    RabbitMQ                         │
└──────────────┘     ├─────────────────────────────────────────────────────┤
                     │  Exchanges:                                          │
                     │  ├── linkedin.direct (direct)                        │
                     │  ├── linkedin.fanout (fanout)                        │
                     │  └── linkedin.topic (topic)                          │
                     ├─────────────────────────────────────────────────────┤
                     │  Queues:                                             │
                     │  ├── pymk.compute (PYMK batch jobs)                  │
                     │  ├── feed.generate (feed building)                   │
                     │  ├── notifications (email/push)                      │
                     │  ├── search.index (Elasticsearch sync)               │
                     │  └── jobs.match (candidate matching)                 │
                     └─────────────────────────────────────────────────────┘
                                          │
                     ┌────────────────────┼────────────────────┐
                     ▼                    ▼                    ▼
              ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
              │PYMK Worker  │     │Feed Worker  │     │Index Worker │
              └─────────────┘     └─────────────┘     └─────────────┘
```

### Queue Definitions and Use Cases

| Queue | Purpose | Delivery | Concurrency | Retry Policy |
|-------|---------|----------|-------------|--------------|
| `pymk.compute` | Recalculate PYMK for a user | At-least-once | 2 workers | 3 retries, exponential backoff |
| `feed.generate` | Build personalized feed | At-least-once | 3 workers | 5 retries, 30s delay |
| `notifications` | Send emails, push notifications | At-least-once | 5 workers | 3 retries, then dead-letter |
| `search.index` | Sync profile/job changes to Elasticsearch | At-least-once | 2 workers | Infinite retries, 60s delay |
| `jobs.match` | Match candidates to new job postings | At-least-once | 2 workers | 3 retries |

### Message Schemas

```typescript
// Connection event - triggers PYMK recalculation and feed updates
interface ConnectionEvent {
  type: 'connection.created' | 'connection.removed';
  userId: string;
  connectedUserId: string;
  timestamp: string; // ISO 8601
  idempotencyKey: string; // UUID for deduplication
}

// Profile update - triggers search index update
interface ProfileUpdateEvent {
  type: 'profile.updated';
  userId: string;
  changedFields: string[]; // ['headline', 'skills', 'experience']
  timestamp: string;
  idempotencyKey: string;
}

// Job posted - triggers candidate matching
interface JobPostedEvent {
  type: 'job.posted';
  jobId: string;
  companyId: string;
  requiredSkills: string[];
  timestamp: string;
  idempotencyKey: string;
}
```

### Delivery Semantics

**At-Least-Once Delivery** (chosen for all queues):
- Messages are acknowledged only after successful processing
- Workers must be idempotent (use `idempotencyKey` to detect duplicates)
- Idempotency tracking stored in Valkey with 24-hour TTL

```typescript
// Idempotent message processing
async function processMessage(message: ConnectionEvent) {
  const idempotencyKey = `processed:${message.idempotencyKey}`;

  // Check if already processed
  const alreadyProcessed = await valkey.get(idempotencyKey);
  if (alreadyProcessed) {
    return; // Skip duplicate
  }

  // Process the message
  await recalculatePYMK(message.userId);

  // Mark as processed (24-hour TTL)
  await valkey.setex(idempotencyKey, 86400, 'true');
}
```

### Backpressure Handling

1. **Prefetch Limit**: Each worker prefetches at most 10 messages
2. **Queue Length Alerts**: Alert when queue depth exceeds 1000 messages
3. **Dead Letter Queue**: Failed messages after max retries go to `*.dlq` queues
4. **Consumer Scaling**: Workers can be scaled horizontally (2-5 instances locally)

### Local Development Setup

```bash
# Start RabbitMQ with management UI
docker run -d --name rabbitmq \
  -p 5672:5672 -p 15672:15672 \
  -e RABBITMQ_DEFAULT_USER=linkedin \
  -e RABBITMQ_DEFAULT_PASS=linkedin123 \
  rabbitmq:3-management

# Management UI available at http://localhost:15672
```

---

## Authentication, Authorization, and Rate Limiting

### Authentication Strategy

**Session-Based Authentication** (chosen for simplicity in local development):

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────┐
│ Client  │────▶│ API Gateway │────▶│ Auth Service│────▶│ Valkey  │
└─────────┘     └─────────────┘     └─────────────┘     └─────────┘
     │                                     │
     │  Cookie: session_id=abc123          │  Session lookup
     │◀────────────────────────────────────│  user:session:abc123
```

### Session Management

```typescript
// Session stored in Valkey
interface Session {
  userId: string;
  email: string;
  role: 'user' | 'recruiter' | 'admin';
  permissions: string[];
  createdAt: string;
  lastAccessedAt: string;
  ipAddress: string;
  userAgent: string;
}

// Session TTL: 7 days, sliding expiration
// Key format: user:session:{sessionId}
```

**Login Flow:**
1. User submits email/password to `POST /api/v1/auth/login`
2. Server validates credentials against bcrypt hash in PostgreSQL
3. Server creates session in Valkey with 7-day TTL
4. Server sets HttpOnly, Secure, SameSite=Strict cookie with session ID
5. Subsequent requests include cookie automatically

### Role-Based Access Control (RBAC)

| Role | Description | Permissions |
|------|-------------|-------------|
| `user` | Standard LinkedIn user | `profile:read`, `profile:write:own`, `connection:*`, `feed:read`, `job:apply` |
| `recruiter` | Company recruiter | All user permissions + `job:post`, `job:manage:own`, `candidate:search` |
| `admin` | Platform administrator | All permissions + `user:manage`, `content:moderate`, `analytics:view` |

### Permission Checks

```typescript
// Middleware for route protection
function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await getSession(req.cookies.session_id);

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!session.permissions.includes(permission)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    req.user = session;
    next();
  };
}

// Route examples
app.get('/api/v1/profile/:id', requirePermission('profile:read'), getProfile);
app.put('/api/v1/profile/:id', requirePermission('profile:write:own'), updateProfile);
app.post('/api/v1/admin/users/:id/ban', requirePermission('user:manage'), banUser);
```

### API Endpoint Authorization Matrix

| Endpoint | user | recruiter | admin |
|----------|------|-----------|-------|
| `GET /api/v1/profile/:id` | Yes | Yes | Yes |
| `PUT /api/v1/profile/:id` | Own only | Own only | Any |
| `POST /api/v1/connections` | Yes | Yes | Yes |
| `POST /api/v1/jobs` | No | Yes | Yes |
| `GET /api/v1/jobs/:id/candidates` | No | Own jobs | Any |
| `GET /api/v1/admin/users` | No | No | Yes |
| `POST /api/v1/admin/users/:id/ban` | No | No | Yes |
| `GET /api/v1/admin/analytics` | No | No | Yes |

### Rate Limiting

**Strategy**: Token bucket algorithm implemented in Valkey

| Endpoint Category | Rate Limit | Bucket Size | Refill Rate |
|-------------------|------------|-------------|-------------|
| Public (login, signup) | 10 req/min | 10 | 1 token/6s |
| Authenticated reads | 100 req/min | 100 | ~1.6 token/s |
| Authenticated writes | 30 req/min | 30 | 0.5 token/s |
| Search | 20 req/min | 20 | 0.33 token/s |
| Admin endpoints | 60 req/min | 60 | 1 token/s |

```typescript
// Rate limiter implementation
async function checkRateLimit(userId: string, category: string): Promise<boolean> {
  const key = `ratelimit:${category}:${userId}`;
  const limit = RATE_LIMITS[category];

  const current = await valkey.incr(key);
  if (current === 1) {
    await valkey.expire(key, 60); // Reset every minute
  }

  return current <= limit.requestsPerMinute;
}

// Response headers
res.setHeader('X-RateLimit-Limit', limit.requestsPerMinute);
res.setHeader('X-RateLimit-Remaining', Math.max(0, limit.requestsPerMinute - current));
res.setHeader('X-RateLimit-Reset', resetTimestamp);
```

---

## Observability

### Metrics (Prometheus)

**Key Metrics to Track:**

| Metric Name | Type | Description | Labels |
|-------------|------|-------------|--------|
| `http_requests_total` | Counter | Total HTTP requests | `method`, `path`, `status` |
| `http_request_duration_seconds` | Histogram | Request latency | `method`, `path` |
| `active_sessions` | Gauge | Current active sessions | - |
| `connections_created_total` | Counter | New connections made | - |
| `pymk_computation_duration_seconds` | Histogram | PYMK batch job duration | `user_network_size` |
| `feed_generation_duration_seconds` | Histogram | Feed build time | - |
| `queue_depth` | Gauge | Messages waiting in queue | `queue_name` |
| `queue_processing_duration_seconds` | Histogram | Message processing time | `queue_name` |
| `db_query_duration_seconds` | Histogram | Database query time | `query_type` |
| `cache_hits_total` | Counter | Valkey cache hits | `cache_name` |
| `cache_misses_total` | Counter | Valkey cache misses | `cache_name` |
| `elasticsearch_query_duration_seconds` | Histogram | Search query time | `index` |

**Prometheus Configuration (prometheus.yml):**

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'linkedin-api'
    static_configs:
      - targets: ['localhost:3001', 'localhost:3002', 'localhost:3003']

  - job_name: 'linkedin-workers'
    static_configs:
      - targets: ['localhost:3010', 'localhost:3011']

  - job_name: 'rabbitmq'
    static_configs:
      - targets: ['localhost:15692']  # RabbitMQ Prometheus plugin

  - job_name: 'postgres'
    static_configs:
      - targets: ['localhost:9187']  # postgres_exporter
```

### Logging (Structured JSON)

**Log Format:**

```typescript
interface LogEntry {
  timestamp: string;      // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;        // 'api', 'pymk-worker', 'feed-worker'
  traceId: string;        // For request correlation
  spanId: string;
  userId?: string;        // If authenticated
  message: string;
  context: Record<string, any>;
  error?: {
    name: string;
    message: string;
    stack: string;
  };
}
```

**Example Log Entries:**

```json
{"timestamp":"2025-01-15T10:23:45.123Z","level":"info","service":"api","traceId":"abc123","spanId":"def456","userId":"user_789","message":"Connection request sent","context":{"targetUserId":"user_012","mutualConnections":5}}

{"timestamp":"2025-01-15T10:23:46.456Z","level":"error","service":"pymk-worker","traceId":"ghi789","spanId":"jkl012","message":"PYMK computation failed","context":{"userId":"user_789","networkSize":5000},"error":{"name":"TimeoutError","message":"Query exceeded 30s limit","stack":"..."}}
```

**Log Levels by Environment:**

| Environment | Min Level | Destinations |
|-------------|-----------|--------------|
| Development | debug | Console (pretty-printed) |
| Local Docker | info | Console (JSON), file |
| Production | info | Log aggregator (Loki/ELK) |

### Distributed Tracing

**Trace Propagation:**

```typescript
// Express middleware to extract/create trace context
function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
  const traceId = req.headers['x-trace-id'] || crypto.randomUUID();
  const spanId = crypto.randomUUID();

  req.traceContext = { traceId, spanId, parentSpanId: req.headers['x-span-id'] };
  res.setHeader('X-Trace-Id', traceId);

  next();
}

// Propagate to downstream services and workers
async function publishToQueue(queue: string, message: any, traceContext: TraceContext) {
  await channel.sendToQueue(queue, Buffer.from(JSON.stringify({
    ...message,
    _trace: traceContext
  })));
}
```

### SLI/SLO Dashboard

**Service Level Indicators:**

| SLI | Target (SLO) | Measurement |
|-----|--------------|-------------|
| Feed API latency (p99) | < 200ms | `histogram_quantile(0.99, http_request_duration_seconds{path="/api/v1/feed"})` |
| PYMK API latency (p99) | < 500ms | `histogram_quantile(0.99, http_request_duration_seconds{path="/api/v1/pymk"})` |
| API availability | 99.9% | `sum(rate(http_requests_total{status!~"5.."})) / sum(rate(http_requests_total))` |
| Connection request success rate | 99.5% | `sum(rate(http_requests_total{path="/api/v1/connections",status="201"})) / sum(rate(http_requests_total{path="/api/v1/connections"}))` |
| Cache hit ratio | > 80% | `sum(cache_hits_total) / (sum(cache_hits_total) + sum(cache_misses_total))` |
| Queue processing lag | < 30s | `max(queue_depth) / avg(rate(queue_processing_duration_seconds_count))` |

**Grafana Dashboard Panels:**

1. **Overview Row**: Request rate, error rate, p50/p95/p99 latency
2. **API Breakdown**: Latency by endpoint, top 5 slowest endpoints
3. **Cache Performance**: Hit/miss ratio, cache size, evictions
4. **Queue Health**: Depth per queue, processing rate, dead letters
5. **Database**: Query latency, connection pool usage, slow queries
6. **Business Metrics**: New connections/hour, jobs posted, PYMK clicks

### Alert Thresholds

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High Error Rate | `rate(http_requests_total{status=~"5.."}[5m]) > 0.01` | Critical | Page on-call |
| API Latency Spike | `histogram_quantile(0.99, http_request_duration_seconds[5m]) > 1` | Warning | Investigate |
| Queue Backup | `queue_depth{queue_name="feed.generate"} > 5000` | Warning | Scale workers |
| Dead Letters | `rate(queue_depth{queue_name=~".*dlq"}[1h]) > 10` | Warning | Review failures |
| Low Cache Hit Ratio | `cache_hit_ratio < 0.7` | Warning | Check cache config |
| Database Connection Pool Exhausted | `db_pool_available < 5` | Critical | Scale connections |
| Disk Space Low | `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1` | Warning | Clean up or expand |

**Alert Configuration (Prometheus rules):**

```yaml
groups:
  - name: linkedin-alerts
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.01
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }} over the last 5 minutes"

      - alert: FeedLatencyHigh
        expr: histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{path="/api/v1/feed"}[5m])) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Feed API p99 latency exceeds 500ms"
```

### Audit Logging

**Auditable Events:**

| Event | Logged Fields | Retention |
|-------|--------------|-----------|
| Login success/failure | userId, email, ipAddress, userAgent, success | 90 days |
| Profile update | userId, changedFields, previousValues (hashed), newValues (hashed) | 1 year |
| Connection request sent/accepted | userId, targetUserId, action | 1 year |
| Job posted/updated/deleted | recruiterId, jobId, companyId, action | 2 years |
| Admin action | adminUserId, targetUserId, action, reason | 5 years |
| Permission change | adminUserId, targetUserId, oldRole, newRole | 5 years |

**Audit Log Schema:**

```sql
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  actor_ip INET,
  target_type VARCHAR(50),  -- 'user', 'job', 'connection'
  target_id INTEGER,
  action VARCHAR(50) NOT NULL,
  details JSONB,            -- Event-specific data
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for compliance queries
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id, created_at);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_type, target_id, created_at);
CREATE INDEX idx_audit_logs_event ON audit_logs(event_type, created_at);
```

**Audit Log Query Examples:**

```sql
-- All admin actions in the last 30 days
SELECT * FROM audit_logs
WHERE event_type LIKE 'admin.%'
AND created_at > NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;

-- All changes to a specific user's profile
SELECT * FROM audit_logs
WHERE target_type = 'user' AND target_id = 12345
ORDER BY created_at DESC;
```

### Local Observability Stack

```bash
# Start Prometheus + Grafana for local development
docker-compose -f docker-compose.observability.yml up -d

# docker-compose.observability.yml
version: '3.8'
services:
  prometheus:
    image: prom/prometheus:v2.45.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:10.0.0
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - ./grafana/dashboards:/var/lib/grafana/dashboards

  loki:
    image: grafana/loki:2.9.0
    ports:
      - "3100:3100"
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Graph storage | PostgreSQL + cache | Neo4j | Simplicity |
| PYMK | Batch precompute | Real-time | Cost efficiency |
| Search | Elasticsearch | PostgreSQL FTS | Better relevance |
| Skills | Normalized table | JSON array | Queryable, standardized |
| Message Queue | RabbitMQ | Kafka | Simpler ops, sufficient for batch jobs |
| Auth | Session + Valkey | JWT | Simpler revocation, less client complexity |
| Rate Limiting | Token bucket in Valkey | Fixed window | Smoother traffic, burst tolerance |
| Observability | Prometheus + Grafana | Datadog/New Relic | Free, self-hosted, learning-focused |

---

## Implementation Notes

This section documents the rationale behind key implementation decisions for the LinkedIn clone's backend infrastructure.

### Why Async Queues Enable Efficient Feed Fanout

When a user creates a post, their content needs to appear in the feeds of all their connections. For a user with 500+ connections, synchronously updating all those feeds would:

1. **Block the API response** - The user would wait seconds for the post to publish
2. **Create thundering herd problems** - Cache invalidation for 500 feeds simultaneously overwhelms Redis
3. **Risk partial failures** - If the 300th cache update fails, is the post published or not?

**RabbitMQ solves this by decoupling the publish from the fanout:**

```
User creates post -> API returns immediately -> Message queued
                                                      |
                                                      v
                              Worker processes at controlled rate
                              (10 connections/second, not 500 at once)
```

The queue provides:
- **Backpressure handling**: Workers process at sustainable rates
- **Retry semantics**: Failed fanouts retry with exponential backoff
- **Observability**: Queue depth metrics alert when fanout falls behind
- **Idempotency**: Deduplication keys prevent duplicate notifications

For PYMK (People You May Know) recalculation, which can take 30+ seconds for users with large networks, async processing is essential. The queue allows batch computation during off-peak hours without blocking the main API.

### Why Rate Limiting Prevents Spam Connection Requests

LinkedIn's connection request feature is a prime target for spam:

1. **Recruiters** may blast connection requests to thousands of candidates
2. **Bots** harvest connection graphs for lead generation
3. **Bad actors** send malicious links in connection messages

Without rate limiting, a single user could send 10,000 connection requests per hour, creating:
- Notification fatigue for recipients
- Database load from pending request storage
- Reputation damage to the platform

**Our token bucket implementation provides:**

| Endpoint | Limit | Burst | Rationale |
|----------|-------|-------|-----------|
| Connection requests | 20/min | 10 | Prevents spam while allowing normal networking |
| Profile updates | 30/min | 30 | Generous for editing, prevents abuse |
| Search queries | 20/min | 20 | Protects Elasticsearch from query storms |
| Login attempts | 10/min | 10 | Mitigates credential stuffing attacks |

The token bucket algorithm (vs. fixed window) provides smoother traffic patterns:
- A user can burst 10 requests instantly, then must wait
- Tokens refill gradually, not all-at-once at window boundaries
- More predictable load on downstream services

Rate limit headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`) allow well-behaved clients to back off gracefully before hitting limits.

### Why Audit Logging Enables Account Recovery and Security

Professional networks contain sensitive career data. Audit logging serves multiple critical functions:

**1. Account Recovery**
When a user reports their profile was changed without their knowledge:
```sql
SELECT * FROM audit_logs
WHERE target_type = 'profile' AND target_id = 12345
AND created_at > NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;
```
This reveals exactly what changed, when, and from which IP address, enabling:
- Identification of unauthorized access
- Restoration of previous profile state
- Evidence for security investigations

**2. Compliance Requirements**
Professional platforms may need to demonstrate:
- Who accessed candidate data (GDPR data subject requests)
- When admin actions were taken (SOC 2 audits)
- Login history for compromised account investigations

**3. Security Monitoring**
Audit logs enable detection of:
- Credential stuffing (many failed logins from one IP)
- Account takeover (login from unusual location)
- Privilege escalation (role changes)

**What we log:**
| Event Type | Retention | Purpose |
|------------|-----------|---------|
| Login success/failure | 90 days | Security monitoring |
| Profile updates | 1 year | Account recovery |
| Connection events | 1 year | Network integrity |
| Admin actions | 5 years | Compliance |

**Privacy considerations:**
- Sensitive field values are masked (showing only first/last 2 characters)
- IP addresses are stored for security but not exposed to users
- Audit logs are append-only (no UPDATE/DELETE access)

### Why Metrics Enable Engagement Optimization

LinkedIn's business model depends on user engagement. Prometheus metrics enable data-driven optimization:

**1. Performance SLOs**
```yaml
# Alert when feed generation exceeds 500ms p99
- alert: FeedLatencyHigh
  expr: histogram_quantile(0.99, rate(feed_generation_duration_seconds_bucket[5m])) > 0.5
```
Slow feeds reduce scroll engagement. Metrics identify performance regressions before users complain.

**2. Feature Adoption**
```promql
# Track connection request conversion rate
rate(connections_created_total[1h]) / rate(connection_requests_total[1h])
```
This reveals whether PYMK algorithm changes improve actual connection formation.

**3. Capacity Planning**
```promql
# Predict when we'll exceed queue capacity
predict_linear(queue_depth{queue_name="notifications"}[1h], 3600)
```
Queue depth trends indicate when to scale notification workers.

**4. Business Metrics**
| Metric | What It Reveals |
|--------|-----------------|
| `posts_created_total` | Content creation health |
| `profile_views_total` | Job seeker activity |
| `post_likes_total` | Feed engagement quality |
| `pymk_computation_duration_seconds` | Algorithm efficiency |

**Key Prometheus patterns used:**
- **Counters** for monotonically increasing values (requests, errors)
- **Histograms** for latency distributions (p50, p95, p99)
- **Gauges** for current state (queue depth, active sessions)

The `/metrics` endpoint exposes all metrics in Prometheus format, enabling:
- Grafana dashboards for real-time visibility
- Alertmanager integration for on-call notifications
- Long-term trend analysis for quarterly reviews

### Implementation Summary

| Feature | Files Added/Modified | Key Benefit |
|---------|---------------------|-------------|
| RabbitMQ integration | `utils/rabbitmq.ts` | Async fanout, decoupled architecture |
| Rate limiting | `utils/rateLimiter.ts` | Spam prevention, fair usage |
| Audit logging | `utils/audit.ts`, `db/migrations/001_create_audit_logs.sql` | Security, compliance, recovery |
| Prometheus metrics | `utils/metrics.ts` | Observability, SLO monitoring |
| Structured logging | `utils/logger.ts` | Debugging, trace correlation |
| Enhanced health checks | `index.ts` | Kubernetes readiness, dependency monitoring |
| RBAC middleware | `middleware/auth.ts` | Fine-grained access control |

---

## Frontend Architecture

This section documents the organization and structure of the LinkedIn frontend application, including component architecture, routing, and state management patterns.

### Technology Stack

- **Framework**: React 19 with TypeScript
- **Build Tool**: Vite
- **Routing**: TanStack Router (file-based routing)
- **State Management**: Zustand (global auth state), React useState (local UI state)
- **Styling**: Tailwind CSS
- **Icons**: Lucide React

### Directory Structure

```
frontend/src/
├── components/              # Reusable UI components
│   ├── profile/             # Profile page sub-components
│   │   ├── index.ts         # Barrel export for profile components
│   │   ├── ProfileHeader.tsx
│   │   ├── EditProfileModal.tsx
│   │   ├── ProfileAbout.tsx
│   │   ├── ExperienceSection.tsx
│   │   ├── EducationSection.tsx
│   │   ├── SkillsSection.tsx
│   │   └── ActivitySection.tsx
│   ├── ConnectionCard.tsx   # Connection display card
│   ├── JobCard.tsx          # Job listing card
│   ├── Navbar.tsx           # Global navigation bar
│   └── PostCard.tsx         # Feed post card with engagement
├── routes/                  # TanStack Router file-based routes
│   ├── __root.tsx           # Root layout with navbar
│   ├── index.tsx            # Home/feed page
│   ├── login.tsx            # Authentication page
│   ├── register.tsx         # Registration page
│   ├── profile.$userId.tsx  # Dynamic user profile page
│   ├── network.tsx          # Connections and PYMK
│   ├── jobs.tsx             # Job listings
│   ├── jobs.$jobId.tsx      # Individual job detail
│   └── search.tsx           # Global search page
├── services/                # API client modules
│   └── api.ts               # REST API service layer
├── stores/                  # Zustand global state stores
│   └── authStore.ts         # Authentication state
├── types/                   # TypeScript type definitions
│   └── index.ts             # Shared interface definitions
└── main.tsx                 # Application entry point
```

### Component Organization Patterns

#### 1. Profile Components

The profile page was refactored from a single 534-line component into focused sub-components, each under 200 lines:

| Component | Lines | Responsibility |
|-----------|-------|----------------|
| `ProfileHeader` | ~150 | Banner, avatar, name, connection actions |
| `EditProfileModal` | ~160 | Profile editing form dialog |
| `ProfileAbout` | ~35 | User summary/bio display |
| `ExperienceSection` | ~115 | Work history list with add action |
| `EducationSection` | ~110 | Education history list with add action |
| `SkillsSection` | ~195 | Skills list with add/remove/endorse |
| `ActivitySection` | ~40 | User's posts feed |

**Benefits of this structure:**
- **Readability**: Each component has a single, clear responsibility
- **Testability**: Components can be unit tested in isolation
- **Reusability**: Section components could be used in other contexts
- **Maintainability**: Changes to one section don't affect others

#### 2. Barrel Exports

Components in feature directories use barrel exports (`index.ts`) for cleaner imports:

```typescript
// Instead of multiple imports
import { ProfileHeader } from '../components/profile/ProfileHeader';
import { EditProfileModal } from '../components/profile/EditProfileModal';

// Single import from barrel
import {
  ProfileHeader,
  EditProfileModal,
  ProfileAbout,
  ExperienceSection,
  EducationSection,
  SkillsSection,
  ActivitySection,
} from '../components/profile';
```

#### 3. JSDoc Documentation

All components include JSDoc documentation following this pattern:

```typescript
/**
 * Brief description of the component's purpose.
 * Additional details about functionality and behavior.
 *
 * @module components/feature/ComponentName
 */

/**
 * Props interface with field descriptions.
 */
interface ComponentNameProps {
  /** Description of this prop */
  propName: string;
}

/**
 * Detailed component description.
 *
 * @param props - Component props
 * @returns The component JSX element
 */
export function ComponentName({ propName }: ComponentNameProps) {
  // Implementation
}
```

### State Management Patterns

#### Global State (Zustand)

Authentication state is managed globally via Zustand:

```typescript
// stores/authStore.ts
interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  updateUser: (user: User) => void;
}
```

#### Local State (React useState)

UI-specific state is managed locally within components:

- Loading states
- Form data
- Modal visibility
- Fetched data (profile, posts, skills, etc.)

### Routing Architecture

TanStack Router provides file-based routing with:

- **Dynamic segments**: `profile.$userId.tsx` matches `/profile/123`
- **Layout routes**: `__root.tsx` wraps all pages with the navbar
- **Type-safe params**: Route params are typed and accessible via hooks

```typescript
// Accessing route params
const { userId } = Route.useParams();

// Programmatic navigation
const navigate = useNavigate();
navigate({ to: '/login' });
```

### API Integration

The `services/api.ts` module provides typed API clients:

```typescript
// Grouped by feature domain
export const usersApi = {
  getProfile: (userId: number) => /* ... */,
  updateProfile: (data: Partial<User>) => /* ... */,
  addSkill: (skillName: string) => /* ... */,
  // ...
};

export const feedApi = {
  getUserPosts: (userId: number) => /* ... */,
  likePost: (postId: number) => /* ... */,
  // ...
};

export const connectionsApi = {
  sendRequest: (userId: number) => /* ... */,
  getConnectionDegree: (userId: number) => /* ... */,
  // ...
};
```

### Component Guidelines

1. **Size Limit**: Keep components under 200 lines; extract sub-components when larger
2. **Single Responsibility**: Each component should do one thing well
3. **Props Interface**: Always define explicit TypeScript interfaces for props
4. **Documentation**: Include JSDoc comments for all exported components and functions
5. **Accessibility**: Include `aria-label` for icon-only buttons
6. **Error Handling**: Log errors to console; consider toast notifications for user feedback
