# LeetCode - Online Judge - Development with Claude

## Project Context

This document tracks the development journey of implementing an online coding practice and evaluation platform.

## Key Challenges to Explore

1. Sandboxed code execution
2. Multiple language support
3. Resource limiting
4. Plagiarism detection

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Outcomes:**
- Defined functional requirements: problem database, code submission, execution, test validation, leaderboards
- Identified scale targets: support for concurrent users, multiple languages
- Documented security requirements for sandboxed execution
- See `system-design-answer.md` for detailed architecture

### Phase 2: Initial Implementation
*Completed*

**Completed:**
- Backend API with Express.js
  - Authentication (register, login, logout, session management)
  - Problems CRUD with caching
  - Submissions with async processing
  - User progress tracking
  - Admin dashboard APIs
- Database schema with PostgreSQL
  - Users, Problems, TestCases, Submissions, UserProblemStatus tables
  - Proper indexes for performance
- Redis integration for sessions and caching
- Code execution sandbox using Docker
  - Security restrictions (no network, dropped capabilities, resource limits)
  - Support for Python and JavaScript
  - Output comparison with normalization
- Frontend with React + TypeScript
  - Problem catalog with filtering and virtualized list
  - Code editor with syntax highlighting (CodeMirror)
  - Real-time test results
  - Submission status polling
  - User progress dashboard
  - Admin dashboard
- Seed data with 15 problems covering various algorithm types:
  - Easy: Two Sum, Palindrome Number, Valid Parentheses, Merge Two Sorted Lists, Reverse String, Climbing Stairs, Best Time to Buy and Sell Stock, Contains Duplicate, FizzBuzz, Binary Search
  - Medium: Maximum Subarray, Longest Common Subsequence, Coin Change, Longest Substring Without Repeating Characters
  - Hard: Median of Two Sorted Arrays
- Multi-language support: Python, JavaScript, C++, Java
- Kafka queue-based execution (optional, for production scale)

### Phase 3: Scaling and Optimization
*Completed*

**Implemented:**
- Rate limiting (fully implemented in src/shared/rateLimiter.ts)
  - Submissions: 10/minute per user
  - Code runs: 30/minute per user
  - General API: 100/minute per user/IP
  - Auth endpoints: 5/15 minutes per IP (brute force protection)
- Circuit breaker for code execution (src/shared/circuitBreaker.ts)
  - Protects against Docker daemon failures
  - Opens after 50% error rate with 5+ requests
  - 30-second reset timeout
- Idempotency for submissions (src/shared/idempotency.ts)
  - Content-hash based deduplication
  - 5-minute TTL in Redis
- Prometheus metrics (src/shared/metrics.ts)
  - HTTP request metrics
  - Submission lifecycle metrics
  - Code execution metrics
  - Circuit breaker state
  - Cache hit/miss rates
- Structured logging with pino (src/shared/logger.ts)
- Health check endpoints (/health, /health/live, /health/ready)
- Graceful shutdown handling
- Frontend virtualized problem list (@tanstack/react-virtual)
- Rate limit error handling in frontend API client

### Phase 4: Polish and Documentation
*In progress*

**Completed:**
- System design answer documents (fullstack, frontend, backend variants)
- Architecture.md with comprehensive trade-off discussions
- README with setup instructions

**Completed:**
- Comprehensive tests with vitest (auth routes, idempotency module, code executor)
- Expanded seed data from 7 to 15 problems

## Design Decisions Log

### Decision 1: Docker for Code Execution
**Choice:** Use Docker containers with security restrictions instead of gVisor or Firecracker
**Rationale:**
- Simpler setup for local development
- Sufficient security for learning project
- Easy to upgrade to gVisor later if needed

### Decision 2: React Router DOM instead of TanStack Router
**Choice:** Use react-router-dom v6 for routing
**Rationale:**
- Simpler setup without code generation
- Well-documented and widely used
- Sufficient for this project's needs

### Decision 3: Polling for Submission Status
**Choice:** Use HTTP polling instead of WebSocket
**Rationale:**
- Simpler implementation
- Adequate for learning project
- Can upgrade to WebSocket for real-time updates later

### Decision 4: Session-based Auth with Redis
**Choice:** Use express-session with Redis store
**Rationale:**
- Simple and secure
- Follows repository guidelines (avoid JWT complexity)
- Easy session management and revocation

### Decision 5: Circuit Breaker for Code Execution
**Choice:** Use opossum library to protect code execution
**Rationale:**
- Docker daemon can become unavailable or hang
- Circuit breaker provides fail-fast behavior
- Prevents cascading failures to rest of API
- Users can still browse problems when execution is down

### Decision 6: Virtualized Problem List
**Choice:** Use @tanstack/react-virtual for problem list
**Rationale:**
- Scales to thousands of problems efficiently
- Only renders visible rows + overscan buffer
- Maintains 60fps scrolling performance
- Reduces DOM node count from N to ~20

### Decision 7: Rate Limiting with Multiple Tiers
**Choice:** Implement per-endpoint rate limiting
**Rationale:**
- Submissions need strict limits (Docker resources expensive)
- Code runs can be more lenient (no persistence)
- Auth needs brute force protection
- General API needs abuse prevention

## Iterations and Learnings

### Iteration 1: Initial Setup
- Created project structure with separate frontend/backend
- Set up Docker Compose for PostgreSQL and Redis
- Implemented basic API routes

### Iteration 2: Code Execution
- Implemented Docker-based sandbox execution
- Added security restrictions (no network, resource limits)
- Handled output comparison with normalization

### Iteration 3: Frontend
- Built problem catalog and detail pages
- Integrated CodeMirror for code editing
- Added test results display with status badges

## Questions and Discussions

### Open Questions
1. How to handle very large test case outputs? (Consider streaming or truncation)
2. How to detect and prevent plagiarism? (MOSS algorithm, or simpler hash-based detection)

### Resolved Questions
1. Should we implement queue-based execution? **Decision:** Not needed for local dev scope. Current async processing with circuit breaker is sufficient. Can add Kafka/RabbitMQ later for production scale.

### Future Considerations
- WebSocket for real-time updates
- Contests with time-limited submissions
- More language support (C++, Java, Go, Rust)
- Queue-based execution with Kafka for production scale

## Resources and References

- [Docker Security Best Practices](https://docs.docker.com/engine/security/)
- [LeetCode System Design](https://github.com/donnemartin/system-design-primer)
- [CodeMirror](https://codemirror.net/)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [x] Add rate limiting
- [x] Add circuit breaker
- [x] Add metrics and observability
- [x] Add idempotency
- [x] Add list virtualization
- [x] Add more problems (expanded from 7 to 15)
- [x] Add comprehensive tests (vitest)
- [x] Add more language support (C++, Java)
- [x] Queue-based execution with Kafka (optional)

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*
