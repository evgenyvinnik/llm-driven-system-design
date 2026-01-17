# Collaborating with Claude on System Design

This document provides guidelines for effectively using Claude (or other LLMs) to learn system design through hands-on implementation.

## 🎯 Philosophy

LLMs are powerful tools for system design practice because they can:
- Help you explore multiple architectural approaches quickly
- Generate boilerplate code so you focus on design decisions
- Explain trade-offs and suggest alternatives
- Debug issues and optimize implementations
- Document your learning journey

However, **you should remain the architect**. The LLM is a collaborator, not a replacement for critical thinking.

## 🛠️ Technology Stack & Environment

### Preferred Technologies (Open Source / Free)

This repository prioritizes **open-source and free technologies** for educational accessibility and hands-on learning. Use the following technology choices unless there's a compelling reason to deviate:

**Databases:**
- **Relational:** PostgreSQL
- **Document Store:** CouchDB
- **Key-Value:** Valkey (when Redis licensing is a concern), Redis (when appropriate)
- **Wide-Column:** Cassandra
- **In-Memory Cache:** Valkey or Redis
- **Graph:** Neo4j Community Edition
- **Time Series:** TimescaleDB (PostgreSQL extension)

**Application Stack:**
- **Frontend:** TypeScript + Vite + Tanstack React
- **Backend:** Node.js + Express
- **Message Queue:** RabbitMQ, Apache Kafka
- **Search:** Elasticsearch (or OpenSearch)
- **Monitoring:** Prometheus + Grafana

### Why Node.js + Express?

**Important:** Node.js + Express may not always be the most performant backend choice, especially for CPU-intensive workloads. However, this repository uses it as the **default backend stack** because:

1. **Educational Focus:** The goal is learning system design, not benchmarking performance
2. **Familiarity:** Consistency in language (TypeScript/JavaScript across frontend and backend) reduces cognitive load
3. **Ecosystem:** Rich ecosystem for building distributed systems quickly
4. **Iteration Speed:** Fast prototyping enables more design iterations

**When to deviate:** If a specific use case clearly benefits from a different approach (e.g., Go for high-throughput services, Python for ML pipelines, Rust for ultra-low latency), the system design document should **explicitly discuss why** the alternative is better, including:
- Performance characteristics comparison
- Resource utilization differences
- Development complexity trade-offs
- Operational considerations

### Local Development Philosophy

**All projects should be executable locally** with the ability to simulate distributed systems:

1. **Multiple Server Instances:** Design projects so you can run 2-5 instances of services locally (different ports) to simulate distribution
2. **Containerization:** Use Docker/Docker Compose for databases and infrastructure components
3. **Service Discovery:** Implement simple service discovery (even if just a config file) to understand distributed coordination
4. **Local Testing:** Every feature should be testable on a single development machine
5. **Resource Awareness:** Keep resource requirements reasonable (< 8GB RAM total for most projects)

**Example Setup:**
```bash
# Run 3 instances of an API server
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003

# Run load balancer locally
npm run dev:lb       # Port 3000

# Infrastructure via Docker Compose
docker-compose up -d # PostgreSQL, Valkey, etc.
```

This approach teaches distributed system concepts without requiring cloud infrastructure.

## 💬 Communicating with Claude: Detail is Key

When working with Claude (or any LLM) on system design, **specificity and thoroughness are critical**. The more detailed your prompts, the better the learning outcomes.

### Always Request Comprehensive Explanations

**Good prompt structure:**
```
I'm designing [SYSTEM]. Before we implement, let's discuss:

1. What are 3-4 different architectural approaches?
2. For each approach, explain:
   - How it works conceptually
   - What components are needed
   - Pros and cons
   - Scalability characteristics
   - When to use it vs alternatives
3. Given our requirements [LIST REQUIREMENTS], which approach would you recommend and why?
4. What are the trade-offs of your recommendation?
```

### Demand "Why" Behind Every Decision

**Don't accept surface-level answers:**

❌ **Bad:**
```
Claude: "Let's use PostgreSQL for this."
You: "Okay"
```

✅ **Good:**
```
Claude: "Let's use PostgreSQL for this."
You: "Why PostgreSQL over CouchDB or Cassandra here? Walk me through:
- What specific features of PostgreSQL are we leveraging?
- What would we gain/lose with a document store?
- What would we gain/lose with a wide-column store?
- At what scale would we reconsider this choice?"
```

### Request Comparative Analysis

When evaluating options, always ask for **head-to-head comparisons**:

**Good prompt:**
```
For this caching layer, compare these options:
1. Valkey
2. Redis
3. In-memory Node.js Map
4. PostgreSQL with aggressive indexes

For each option, explain:
- Performance characteristics (reads/writes per second)
- Memory efficiency
- Persistence guarantees
- Operational complexity
- Cost implications
- Failure modes

Then recommend one with detailed justification.
```

### Be Explicit About Learning Goals

**Tell Claude what you want to learn:**

```
I want to understand rate limiting deeply. Don't just give me code.

First explain:
- 3 different rate limiting algorithms (token bucket, leaky bucket, sliding window)
- Pros/cons of each
- How each performs under burst traffic

Then let's implement token bucket from scratch so I understand every line.
Then we'll discuss how this scales in a distributed system.
```

### Insist on Justification for Deviations

Since we have preferred technologies, when Claude suggests something different, demand justification:

**Good prompt:**
```
You suggested using Go for this service instead of Node.js + Express.
I need a detailed comparison:

1. What specific requirements make Go better here?
2. Benchmark comparison for this use case
3. What do we lose by not using Node.js? (e.g., code reuse, team expertise)
4. Is the performance gain worth the added complexity?
5. Could we achieve similar performance with Node.js optimizations?

Help me make an informed trade-off decision, not just pick the "fastest" option.
```

### Request Implementation Details, Not Abstractions

**Avoid hand-wavy explanations:**

❌ **Bad:** "We'll use consistent hashing for load balancing"

✅ **Good:**
```
You mentioned consistent hashing. Let's implement it:
1. First, explain the algorithm with a concrete example
2. Show me the actual hash function code
3. Implement the ring data structure
4. Handle node addition/removal
5. Write tests that prove it distributes load evenly
6. Discuss what happens during node failures

I want to understand it deeply, not just conceptually.
```

### Example: Full Detailed Prompt

```
I want to design a real-time collaborative document editing system (like Google Docs).

Before we start coding, let's do a thorough design discussion:

**Architecture:**
1. What are the main architectural approaches? (e.g., OT, CRDT, lock-based)
2. For each approach:
   - How does it work?
   - What are the consistency guarantees?
   - What are the trade-offs?
   - What are example systems that use this approach?

**Technology Stack:**
3. Why would we use or not use our default stack (Node.js + Express, PostgreSQL)?
4. What components need real-time communication? (WebSocket vs SSE vs long polling - compare all three)
5. For data storage:
   - PostgreSQL vs CouchDB vs Cassandra - which fits and why?
   - Do we need a separate operational data store vs analytics store?

**Distributed System Challenges:**
6. How do we handle conflicts when two users edit simultaneously?
7. How do we ensure message ordering across distributed servers?
8. What happens if a WebSocket server crashes mid-session?

**Local Development:**
9. How can we run 3-4 instances locally to test distributed behavior?
10. What's the minimal infrastructure needed to demo this?

Let's discuss all of this before writing any code. I want to understand the design space fully.
```

**This level of detail ensures:**
- You think through requirements completely
- You understand trade-offs deeply
- You can justify every technical decision
- You learn principles, not just patterns
- You can adapt designs to new contexts

## 💡 Effective Collaboration Patterns

### 1. Start with Requirements Gathering

**Good prompt:**
```
I want to design a URL shortening service like Bit.ly. Let's start by discussing:
- What are the core features?
- What are the scale requirements?
- What are the key technical challenges?
```

**Why it works:** You're thinking through requirements before jumping to solutions.

### 2. Explore Multiple Architectural Approaches

**Good prompt:**
```
For this URL shortener, what are 3 different approaches to generating short codes?
For each approach, explain:
- How it works
- Pros and cons
- When to use it
```

**Why it works:** Understanding trade-offs is crucial in system design.

### 3. Ask "Why" Questions

**Good prompt:**
```
Why would we use a NoSQL database instead of a relational database for this use case?
What specific features of NoSQL make it better suited here?
```

**Why it works:** Deepens understanding of when and why to use specific technologies.

### 4. Request Incremental Implementation

**Good prompt:**
```
Let's implement this in phases:
1. First, a simple in-memory version
2. Then add database persistence
3. Then add caching
4. Finally add analytics

Let's start with phase 1.
```

**Why it works:** You learn the evolution of system complexity and can test each phase.

### 5. Challenge Assumptions

**Good prompt:**
```
You suggested using Redis for caching. What would happen if we used Memcached instead?
What if we didn't use a cache at all? At what scale does caching become necessary?
```

**Why it works:** Critical thinking about design decisions rather than blindly accepting suggestions.

### 6. Focus on Specific Components

**Good prompt:**
```
Let's focus on just the URL shortening algorithm. I want to understand:
- Different encoding schemes (base62, base64, custom)
- Collision handling strategies
- How to ensure uniqueness at scale
```

**Why it works:** Deep dives into specific components build comprehensive understanding.

### 7. Request Real Implementation, Not Pseudocode

**Good prompt:**
```
Let's implement the actual rate limiter in TypeScript using Node.js + Express and Valkey.
Include error handling and edge cases.
I want to be able to run and test this locally.
```

**Why it works:** Working code reveals issues that pseudocode hides.

### 8. Ask for Testing Scenarios

**Good prompt:**
```
What are the edge cases we should test for this distributed cache?
Help me write test cases that validate:
- Cache hits and misses
- Eviction policies
- Concurrent access
- Network failures
```

**Why it works:** Testing reveals whether your design actually works.

## 🚫 Anti-Patterns to Avoid

### ❌ Being Too Vague
**Bad:** "Design Twitter"
**Good:** "Design Twitter's timeline service. Focus on how to efficiently fetch and rank posts for a user's feed at scale."

### ❌ Accepting Everything Without Question
**Bad:** "Okay, implement that"
**Good:** "Before we implement, why did you choose Kafka over RabbitMQ here? What are the trade-offs?"

### ❌ Asking for Everything at Once
**Bad:** "Build the entire Uber system with all microservices"
**Good:** "Let's start with just the ride matching algorithm. Once that works, we'll add payment processing."

### ❌ Not Testing Your Understanding
**Bad:** "Thanks, that makes sense"
**Good:** "Let me summarize what I understood: we're using consistent hashing because... Is that correct?"

### ❌ Ignoring Scalability from the Start
**Bad:** "Just make it work"
**Good:** "Let's start simple, but design it so we can scale horizontally later. What patterns should we use?"

## 👥 Design for Multiple User Personas

Real-world systems serve multiple types of users with different needs and permissions. **When designing systems, consider implementing both end-user and administrative interfaces** where applicable. This teaches you to think about operational requirements, not just user-facing features.

### When to Implement Multiple Personas

**Always consider both personas for:**
- **Content platforms** (blogging, video sharing, social media)
- **E-commerce systems** (shopping, marketplaces, booking systems)
- **SaaS applications** (project management, CRM, analytics)
- **Communication systems** (messaging, email, notification services)
- **Infrastructure services** (URL shorteners, file storage, APIs)

**May not need separate personas for:**
- **Algorithm-focused projects** (consistent hashing implementation, rate limiting)
- **Pure infrastructure** (load balancers, caching layers)
- **Single-user tools** (personal productivity apps)

### End-User Experience

The end-user interface is what your customers interact with. Focus on:

**Core Functionality:**
- Primary use case features (post content, make purchases, send messages)
- Search and discovery
- Personalization and recommendations
- Real-time updates and notifications
- Mobile-responsive design

**User-Centric Concerns:**
- Performance (fast load times, perceived performance)
- Simplicity (intuitive UI, minimal cognitive load)
- Accessibility (keyboard navigation, screen readers)
- Privacy controls (what data is visible, who can see it)

**Example: URL Shortener End-User Features**
```
- Create short URL from long URL
- Customize short code (if available)
- View click count for my URLs
- Delete or deactivate my URLs
- See basic analytics (clicks over time)
```

### Admin/Operator Experience

The admin interface is for operating and monitoring the system. This is often overlooked but crucial for production systems.

**Operational Features:**
- System health monitoring (uptime, error rates, latency)
- User management (view, suspend, delete accounts)
- Content moderation (review, approve, remove content)
- Configuration management (feature flags, rate limits, quotas)
- Analytics and reporting (usage patterns, growth metrics)

**Admin-Specific Concerns:**
- **Observability:** Can operators diagnose issues quickly?
- **Control:** Can they adjust system behavior without code changes?
- **Safety:** Are dangerous operations protected (confirmations, audit logs)?
- **Efficiency:** Can they perform bulk operations?

**Example: URL Shortener Admin Features**
```
- Dashboard showing:
  - Total URLs created (daily, weekly, monthly)
  - Top domains being shortened
  - System health (response times, error rates)
  - Storage utilization
- Search/filter all shortened URLs
- Ban specific domains or patterns
- View user activity and patterns
- Configure URL expiration policies
- Rate limit adjustments per user tier
- Audit log of all admin actions
```

### Design Considerations for Multiple Personas

**Separate Concerns:**
```
/                    → End-user interface (public)
/admin               → Admin dashboard (authenticated)
/api/v1/urls         → Public API endpoints
/api/v1/admin/stats  → Admin API endpoints
```

**Different Data Access:**
- **End users:** See only their own data (my URLs, my analytics)
- **Admins:** See aggregate data, all users' data, system metrics
- **Design question:** How do you efficiently query "all URLs" vs "my URLs"?

**Different Performance Requirements:**
- **End users:** Must be fast (< 100ms for core operations)
- **Admins:** Can be slower for complex queries (analytics, reports)
- **Design question:** Should admin queries use the same database? Read replicas? Separate analytics DB?

**Different Security Models:**
- **End users:** Row-level security (users can only modify their own data)
- **Admins:** Role-based access control (different admin levels)
- **Design question:** How do you implement role checks efficiently?

### Implementation Strategy

**Phase 1: Start with End-User Experience**
```
1. Build core user-facing features first
2. Ensure the primary use case works end-to-end
3. Test with realistic user scenarios
```

**Phase 2: Add Basic Admin Capabilities**
```
1. Read-only dashboard (view stats, monitor health)
2. Basic CRUD operations (view, delete problem content)
3. Simple configuration (update rate limits via environment)
```

**Phase 3: Enhance Admin Experience**
```
1. Rich analytics and reporting
2. Bulk operations
3. Advanced configuration management
4. Audit logging
```

**Why this order?** You need working features before you can monitor them. Build the system first, then build the tools to operate it.

### Prompting Claude for Dual Experiences

**Good prompt:**
```
I'm designing a URL shortening service. Let's implement both end-user and admin experiences.

**End-User Requirements:**
- Create shortened URLs
- View their own URL analytics
- Delete their URLs

**Admin Requirements:**
- Dashboard showing system-wide metrics
- Ability to search and moderate URLs
- Configure rate limits and policies

For each persona:
1. What are the unique technical challenges?
2. How should data access differ?
3. What are the performance requirements?
4. How do we implement role-based access control?

Let's start with the end-user experience, then add admin capabilities.
```

**Questions to explore:**
```
- Should admin features use the same API as users, or separate endpoints?
- How do we design database queries that work for both "my data" and "all data"?
- Should we use the same frontend framework for both interfaces?
- What metrics should we track for observability?
- How do we test admin features (seed data, test accounts)?
```

### Real-World Examples

**E-commerce Platform:**
- **End-User:** Browse products, add to cart, checkout, track orders
- **Admin:** Inventory management, order fulfillment, customer support tools, sales analytics

**Social Media Platform:**
- **End-User:** Post content, follow users, like/comment, personalized feed
- **Admin:** Content moderation, user management, trending topics, abuse detection

**Analytics Service:**
- **End-User:** Embed tracking code, view their website analytics, create reports
- **Admin:** Monitor system performance, debug tracking issues, manage quotas, billing

### Learning Benefits

Implementing both personas teaches you:

1. **Operational Design:** Production systems need monitoring and control
2. **Security Models:** Different users need different permissions
3. **Data Access Patterns:** Optimizing for "my data" vs "all data" queries
4. **API Design:** Public vs private endpoints, versioning, rate limiting
5. **Observability:** What metrics matter? How to surface them?
6. **Role-Based Access:** Authentication vs authorization
7. **Audit Trails:** Tracking who did what, when (crucial for admin actions)

### When to Skip Admin Experience

It's okay to skip admin interfaces when:
- The focus is learning a specific algorithm or data structure
- The system is purely computational (no user-generated content)
- Time constraints (explicitly note "admin interface out of scope")
- The learning goal doesn't benefit from it

**But always ask:** "In production, how would operators manage this system?" Even if you don't build it, thinking about operational needs improves your design.

## 🔐 Authentication & User Sessions

Most multi-user systems require authentication to identify users and control access. For learning purposes, **keep authentication simple** and focus on the system design aspects rather than production-grade security.

### When to Implement Authentication

**Always implement authentication for:**
- **Multi-user systems** where users have personal data (social media, e-commerce, SaaS)
- **Systems with different user roles** (end-user vs admin)
- **Systems with private/public content** (only owner can edit their data)
- **Rate limiting per user** (different quotas for different users)

**May skip authentication for:**
- **Public services with no user data** (public URL shortener, read-only APIs)
- **Algorithm demonstrations** (consistent hashing, cache eviction)
- **Time-constrained projects** (explicitly note "authentication out of scope")

### Simplified Authentication for Local Development

For learning system design, use **simple, pragmatic authentication** that you can implement quickly:

**Recommended Approach: Session-Based Auth**
```
1. User provides email/username + password
2. Server validates credentials against database
3. Server creates session, stores in Redis/Valkey
4. Server returns session token (cookie or header)
5. Client includes token in subsequent requests
6. Server validates session on each request
```

**Why this approach?**
- Simple to implement (< 100 lines of code)
- Easy to test locally
- Teaches session management concepts
- Works without external dependencies
- Sufficient for learning distributed systems

**Example Implementation Pattern:**
```typescript
// Server: Express middleware
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.query('SELECT * FROM users WHERE email = $1', [email]);

  // In practice, use bcrypt for password hashing
  if (!user || user.password !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Create session
  const sessionId = crypto.randomUUID();
  await redis.setex(`session:${sessionId}`, 3600, JSON.stringify({
    userId: user.id,
    role: user.role,
    createdAt: Date.now()
  }));

  res.cookie('sessionId', sessionId, { httpOnly: true });
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

// Authentication middleware
async function authenticate(req, res, next) {
  const sessionId = req.cookies.sessionId;
  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = await redis.get(`session:${sessionId}`);
  if (!session) {
    return res.status(401).json({ error: 'Session expired' });
  }

  req.user = JSON.parse(session);
  next();
}

// Role-based access control
function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// Usage
app.get('/api/urls', authenticate, async (req, res) => {
  // Only return URLs for this user
  const urls = await db.query('SELECT * FROM urls WHERE user_id = $1', [req.user.userId]);
  res.json(urls);
});

app.get('/api/admin/stats', authenticate, requireRole('admin'), async (req, res) => {
  // Admin-only endpoint
  const stats = await db.query('SELECT COUNT(*) as total FROM urls');
  res.json(stats);
});
```

### Avoid Over-Engineering Authentication

**DON'T do these for learning projects:**
- ❌ OAuth/OpenID Connect (unless learning OAuth specifically)
- ❌ JWT with public/private keys and rotation
- ❌ Multi-factor authentication
- ❌ Password reset flows via email
- ❌ CAPTCHA and bot detection
- ❌ Account lockout after failed attempts

**DO keep it simple:**
- ✅ Email + password stored in PostgreSQL
- ✅ Session IDs stored in Redis/Valkey
- ✅ Simple password hashing (bcrypt)
- ✅ HTTP-only cookies for session tokens
- ✅ Basic role field in users table (`role: 'user' | 'admin'`)

**Why?** The goal is learning system design, not security engineering. Simple auth lets you focus on:
- How to design multi-tenant data models
- How to implement role-based access control
- How sessions work in distributed systems
- How to scale authentication

### Simulating Multiple Users Locally

**Create Seed Users:**
```sql
-- migrations/001_create_users.sql
INSERT INTO users (id, email, password_hash, role, created_at) VALUES
  (1, 'user1@example.com', '$2b$10$...', 'user', NOW()),
  (2, 'user2@example.com', '$2b$10$...', 'user', NOW()),
  (3, 'admin@example.com', '$2b$10$...', 'admin', NOW());

-- Pre-populate some data for each user
INSERT INTO urls (short_code, long_url, user_id, created_at) VALUES
  ('abc123', 'https://example.com/very/long/url/1', 1, NOW()),
  ('xyz789', 'https://example.com/very/long/url/2', 2, NOW());
```

**Testing with Multiple Users:**
```bash
# Terminal 1: Login as regular user
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user1@example.com","password":"password123"}' \
  -c user1-cookies.txt

# Use session for requests
curl http://localhost:3000/api/urls \
  -b user1-cookies.txt

# Terminal 2: Login as admin
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123"}' \
  -c admin-cookies.txt

# Access admin endpoint
curl http://localhost:3000/api/admin/stats \
  -b admin-cookies.txt
```

**Browser Testing:**
```
1. Open browser window: Login as user1@example.com
2. Open incognito window: Login as user2@example.com
3. Verify each user only sees their own data
4. Open another incognito: Login as admin@example.com
5. Verify admin sees all data
```

### Authentication in Distributed Systems

Once you have basic auth working, explore distributed challenges:

**Challenge 1: Session Storage**
```
Question: If we run 3 API servers, where do we store sessions?

Options:
1. In-memory on each server (doesn't work - sessions not shared)
2. Redis/Valkey shared by all servers (standard approach)
3. Database (works, but slower)
4. Sticky sessions + local memory (load balancer pins user to server)

Implement option 2, then discuss trade-offs of others.
```

**Challenge 2: Session Replication**
```
Question: What happens if Redis crashes? All users logged out?

Solutions:
- Redis persistence (RDB snapshots, AOF logs)
- Redis replication (primary + replicas)
- Redis Cluster (distributed, highly available)

Implement Redis persistence, discuss when replication is needed.
```

**Challenge 3: Logout from All Devices**
```
Question: User clicks "Logout from all devices" - how to invalidate all sessions?

Solutions:
- Store all session IDs per user (can query and delete)
- Use session version number in user record (increment on logout)
- Token blacklist (store invalidated tokens)

Implement version number approach.
```

### Frontend Login Experience

**Simple Login Form (React + TypeScript):**
```typescript
// LoginForm.tsx
function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Important: send cookies
        body: JSON.stringify({ email, password })
      });

      if (res.ok) {
        const { user } = await res.json();
        // Store user in context/state, redirect to dashboard
        window.location.href = '/dashboard';
      } else {
        setError('Invalid credentials');
      }
    } catch (err) {
      setError('Login failed');
    }
  };

  return (
    <form onSubmit={handleLogin}>
      <input
        type="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="Password"
      />
      {error && <p className="error">{error}</p>}
      <button type="submit">Login</button>
    </form>
  );
}

// ProtectedRoute.tsx
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(res => res.json())
      .then(data => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div>Loading...</div>;
  if (!user) return <Navigate to="/login" />;

  return <>{children}</>;
}
```

### Quick Setup Script

**Create a helper script for testing:**
```typescript
// scripts/create-test-users.ts
import bcrypt from 'bcrypt';
import { db } from '../src/db';

async function createTestUsers() {
  const users = [
    { email: 'user1@test.com', password: 'password123', role: 'user' },
    { email: 'user2@test.com', password: 'password123', role: 'user' },
    { email: 'admin@test.com', password: 'admin123', role: 'admin' }
  ];

  for (const user of users) {
    const passwordHash = await bcrypt.hash(user.password, 10);
    await db.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [user.email, passwordHash, user.role]
    );
  }

  console.log('Test users created!');
  console.log('Users: user1@test.com, user2@test.com (password: password123)');
  console.log('Admin: admin@test.com (password: admin123)');
}

createTestUsers();
```

Run with: `npm run create-test-users`

### Learning Objectives

Implementing authentication teaches you:

1. **Session Management:** How to track logged-in users across requests
2. **Stateful vs Stateless:** Sessions (stateful) vs JWTs (stateless) trade-offs
3. **Distributed Sessions:** Where to store state in multi-server systems
4. **Authorization:** Authentication (who are you?) vs Authorization (what can you do?)
5. **Data Isolation:** Row-level security, filtering queries by user ID
6. **Security Basics:** Password hashing, secure cookies, HTTPS importance
7. **User Experience:** Login flows, session expiration, staying logged in

### Prompting Claude for Authentication

**Good prompt:**
```
I'm building a URL shortener where users can manage their own URLs and admins can moderate content.

Let's implement simple session-based authentication:

1. Users table with email, password_hash, role
2. Login endpoint that creates a session in Redis
3. Middleware to authenticate requests
4. Role-based access control for admin endpoints

Keep it simple - no OAuth, no password reset flows.

Then help me test with:
- Multiple users in different browser windows
- Verify users only see their own URLs
- Verify admin can see all URLs

What are the key design decisions here?
```

**Questions to explore:**
```
- Where should we store sessions? (Redis, PostgreSQL, in-memory)
- How do we handle session expiration?
- What happens when Redis is unavailable?
- How do we implement "remember me" functionality?
- Should we use cookies or Authorization headers?
- How do we implement role-based access efficiently?
```

## 📋 Project Workflow Template

For each system design project, follow this workflow:

### Phase 1: Requirements & Design (30 minutes)
1. Clarify functional requirements
2. Estimate scale (users, requests, data)
3. Identify key challenges
4. Identify user personas (end-user, admin, guest) and authentication needs
5. Sketch high-level architecture
6. Choose technologies (default to preferred stack above, justify any deviations with detailed comparisons)

### Phase 2: Core Implementation (2-4 hours)
1. Implement authentication (if needed - see Authentication section below)
2. Implement core end-user functionality
3. Add persistence layer
4. Write basic tests
5. Verify it works end-to-end

### Phase 2.5: Admin Interface (1-2 hours, if applicable)
1. Implement admin dashboard with system metrics
2. Add admin-specific operations (moderation, configuration)
3. Implement role-based access control
4. Test with multiple user roles

### Phase 3: Scale & Optimize (1-2 hours)
1. Add caching layer
2. Implement load balancing (if applicable)
3. Add monitoring/logging
4. Load test and identify bottlenecks

### Phase 4: Documentation (30 minutes)
1. Document architecture in `architecture.md`
2. Update `README.md` with setup instructions
3. Record insights in `claude.md`

## 🎓 Learning Reflection Questions

After completing each project, reflect on:

1. **What was the hardest design decision?** Why?
2. **What would break first under load?** How would you fix it?
3. **What did you over-engineer?** What could be simpler?
4. **What did you under-engineer?** What would cause issues in production?
5. **What would you do differently next time?**

## 🔄 Iteration is Key

System design is iterative. Don't expect to get it right the first time. Use Claude to:
- Refactor as you learn
- Explore alternative approaches
- Optimize bottlenecks
- Add features incrementally

## 🤝 When to Use Claude vs. When to Think Independently

**Use Claude for:**
- Generating boilerplate code
- Explaining unfamiliar technologies
- Suggesting architectural patterns
- Debugging implementation issues
- Exploring multiple solutions quickly

**Think independently about:**
- Core requirements and constraints
- Key design trade-offs
- Which approach fits your use case
- Whether the design actually solves the problem
- What you're trying to learn from this exercise

## 📚 Additional Resources

- [System Design Primer](https://github.com/donnemartin/system-design-primer)
- [Designing Data-Intensive Applications](https://dataintensive.net/)
- [High Scalability Blog](http://highscalability.com/)
- [AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/)

---

**Remember:** The goal is to learn by doing. Use Claude as a knowledgeable pair programmer, not as a system design oracle. Question everything, experiment, and build your intuition through hands-on practice.
