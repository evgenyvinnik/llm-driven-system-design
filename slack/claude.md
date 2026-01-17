# Design Slack - Development with Claude

## Project Context

Building a team messaging platform to understand real-time communication, workspace isolation, and integration platforms.

**Key Learning Goals:**
- Build real-time messaging at scale
- Design threading/reply models
- Implement workspace tenant isolation
- Create integration and bot platform

---

## Key Challenges to Explore

### 1. Message Ordering

**Problem**: Messages must appear in order across devices

**Solutions:**
- Server-assigned timestamps
- Hybrid logical clocks
- Sequence numbers per channel

### 2. Thread Scalability

**Problem**: Popular threads with 1000+ replies

**Solutions:**
- Paginate thread replies
- Collapse old replies
- Separate query for thread view

### 3. Presence at Scale

**Problem**: Tracking 100K+ online users

**Solutions:**
- Valkey with TTL for automatic cleanup
- Batch presence updates
- Only broadcast to visible users

---

## Development Phases

### Phase 1: Core Messaging
- [ ] Workspaces and channels
- [ ] Basic messages
- [ ] WebSocket connections

### Phase 2: Features
- [ ] Threading
- [ ] Reactions
- [ ] Editing/deleting

### Phase 3: Search
- [ ] Elasticsearch indexing
- [ ] Message search
- [ ] Filters

### Phase 4: Integrations
- [ ] Webhooks
- [ ] Slash commands
- [ ] Bot users

---

## Resources

- [Slack Engineering Blog](https://slack.engineering/)
- [Real-Time Messaging Architecture](https://blog.pusher.com/real-time-architecture/)
- [Building Chat Systems](https://www.ably.io/blog/chat-architecture/)
