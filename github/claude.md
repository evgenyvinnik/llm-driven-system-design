# Design GitHub - Development with Claude

## Project Context

Building a code hosting platform to understand Git internals, code search, and collaborative workflows.

**Key Learning Goals:**
- Understand Git object model and storage
- Build code search with symbol extraction
- Design PR workflow with merge strategies
- Implement reliable webhook delivery

---

## Key Challenges to Explore

### 1. Git Protocol Support

**Protocols to support:**
- SSH (git@github.com:user/repo.git)
- HTTPS (https://github.com/user/repo.git)

**Smart HTTP Protocol:**
- Client sends refs request
- Server responds with available refs
- Client negotiates objects needed
- Server sends pack file

### 2. Large Monorepos

**Problem**: Repos with millions of files

**Solutions:**
- Partial clone (only fetch needed objects)
- Sparse checkout
- LFS for large files
- Pack file optimization

### 3. Code Review at Scale

**Challenges:**
- Large diffs (1000+ file changes)
- Inline comments positioning
- Review request routing
- Stale review detection

---

## Development Phases

### Phase 1: Repository Basics (Completed)
- [x] Create/delete repos
- [x] Git init with bare repositories
- [x] File tree browsing
- [x] File content viewing
- [x] Commit history

### Phase 2: Pull Requests (In Progress)
- [x] PR creation
- [x] Diff computation
- [x] Review comments
- [x] Merge strategies (merge, squash, rebase)
- [ ] Conflict detection and resolution
- [ ] Branch protection rules

### Phase 3: Search (Completed)
- [x] File indexing with Elasticsearch
- [x] Full-text code search
- [x] Symbol extraction (functions, classes)
- [x] Language detection

### Phase 4: Automation (Pending)
- [ ] Webhook system with retry
- [ ] Basic CI runner
- [ ] Status checks on PRs
- [ ] Notification system

---

## Implementation Notes

### Git Storage Strategy
Using bare Git repositories with `simple-git` library:
- Repositories stored in `/repositories/{owner}/{repo}.git`
- Using `git ls-tree` for file listing
- Using `git show` for file content
- Using `git diff` for PR diffs

### Database Design
PostgreSQL with comprehensive schema:
- Users and organizations
- Repositories with owner/org relationship
- Pull requests with state machine
- Issues with labels and comments
- Discussions with threaded comments
- Webhooks with delivery tracking

### Authentication
Session-based auth with Redis:
- 7-day session TTL
- Session ID in header (`X-Session-Id`)
- Role-based access (user/admin)

### Code Search
Elasticsearch with custom analyzer:
- Code tokenizer for identifiers
- Camel case splitting
- Language detection from file extension
- Symbol extraction for functions/classes

---

## Resources

- [Git Internals](https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain)
- [GitHub Engineering Blog](https://github.blog/category/engineering/)
- [Git Wire Protocol](https://git-scm.com/docs/protocol-v2)
