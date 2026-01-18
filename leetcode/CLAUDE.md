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
*In progress*

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
  - Problem catalog with filtering
  - Code editor with syntax highlighting (CodeMirror)
  - Real-time test results
  - Submission status polling
  - User progress dashboard
  - Admin dashboard
- Seed data with 7 problems (Two Sum, Palindrome Number, etc.)

**Remaining:**
- Add more problems
- Improve error handling
- Add input validation

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer (partially done with Redis)
- Optimize database queries
- Implement load balancing
- Add monitoring
- Worker pool for code execution
- Rate limiting

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

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
1. How to handle very large test case outputs?
2. Should we implement queue-based execution for better scaling?
3. How to detect and prevent plagiarism?

### Future Considerations
- WebSocket for real-time updates
- Contests with time-limited submissions
- More language support (C++, Java, Go, Rust)

## Resources and References

- [Docker Security Best Practices](https://docs.docker.com/engine/security/)
- [LeetCode System Design](https://github.com/donnemartin/system-design-primer)
- [CodeMirror](https://codemirror.net/)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Add more problems
- [ ] Add tests
- [ ] Performance optimization

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*
