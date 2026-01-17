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

## 📋 Project Workflow Template

For each system design project, follow this workflow:

### Phase 1: Requirements & Design (30 minutes)
1. Clarify functional requirements
2. Estimate scale (users, requests, data)
3. Identify key challenges
4. Sketch high-level architecture
5. Choose technologies (default to preferred stack above, justify any deviations with detailed comparisons)

### Phase 2: Core Implementation (2-4 hours)
1. Implement core functionality
2. Add persistence layer
3. Write basic tests
4. Verify it works end-to-end

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
