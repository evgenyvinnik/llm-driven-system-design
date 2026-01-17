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

### Phase 1: Repository Basics
- [ ] Create/delete repos
- [ ] Git clone support
- [ ] Push/pull basics

### Phase 2: Pull Requests
- [ ] PR creation
- [ ] Diff computation
- [ ] Review comments
- [ ] Merge strategies

### Phase 3: Search
- [ ] File indexing
- [ ] Full-text search
- [ ] Symbol extraction

### Phase 4: Automation
- [ ] Webhook system
- [ ] Basic CI runner
- [ ] Status checks

---

## Resources

- [Git Internals](https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain)
- [GitHub Engineering Blog](https://github.blog/category/engineering/)
- [Git Wire Protocol](https://git-scm.com/docs/protocol-v2)
