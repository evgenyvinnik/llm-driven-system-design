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

### Phase 1: Core Messaging [COMPLETED]
- [x] Workspaces and channels
- [x] Basic messages
- [x] WebSocket connections

### Phase 2: Features [IN PROGRESS]
- [x] Threading
- [x] Reactions
- [x] Editing/deleting
- [ ] File attachments
- [ ] Mentions and notifications

### Phase 3: Search [COMPLETED]
- [x] Elasticsearch indexing
- [x] Message search
- [x] Filters (channel, user, date)

### Phase 4: Integrations
- [ ] Webhooks
- [ ] Slash commands
- [ ] Bot users

---

## Implementation Notes

### Completed Features

1. **Workspaces**: Full CRUD with member management and role-based access
2. **Channels**: Public/private channels with membership tracking
3. **Direct Messages**: One-on-one and group DM support
4. **Real-time Messaging**: WebSocket with Redis pub/sub for cross-instance delivery
5. **Threading**: Reply to messages with reply count tracking
6. **Reactions**: Add/remove emoji reactions
7. **Message Editing/Deletion**: With real-time updates
8. **Presence**: Online/offline status with Redis TTL
9. **Typing Indicators**: Real-time typing notifications
10. **Search**: Elasticsearch with PostgreSQL FTS fallback

### Technical Decisions

- **WebSocket per user channel**: Each user subscribes to their own Redis pub/sub channel for message delivery
- **Thread as message attribute**: Threads are implemented as messages with `thread_ts` reference
- **Presence with TTL**: Redis keys with 60-second TTL for automatic cleanup
- **Search fallback**: PostgreSQL `tsvector` when Elasticsearch unavailable

---

## Resources

- [Slack Engineering Blog](https://slack.engineering/)
- [Real-Time Messaging Architecture](https://blog.pusher.com/real-time-architecture/)
- [Building Chat Systems](https://www.ably.io/blog/chat-architecture/)
