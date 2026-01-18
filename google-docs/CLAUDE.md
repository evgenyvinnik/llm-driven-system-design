# Google Docs - Collaborative Editing - Development with Claude

## Project Context

This document tracks the development journey of implementing a real-time collaborative document editing platform.

## Key Challenges to Explore

1. Operational transformation
2. Conflict resolution
3. Real-time sync
4. Cursor position sharing

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Completed:**
- Core features: Rich text editing, real-time collaboration, comments, version history
- Scale target: Local development with 2-5 instances
- Technology stack: React + TipTap, Node.js + Express + WebSocket, PostgreSQL, Redis

### Phase 2: Initial Implementation
*In progress*

**Completed:**
- Database schema with users, documents, permissions, versions, comments, suggestions
- Authentication system (register, login, logout, sessions)
- Document CRUD operations with sharing
- WebSocket infrastructure for real-time collaboration
- Operational Transformation engine with transform functions
- Rich text editor with TipTap/ProseMirror
- Comments and replies system
- Version history with snapshots
- Presence awareness (online users)

**In progress:**
- Full OT integration between editor and WebSocket
- Cursor position sync across clients

**Focus areas:**
- Implement core functionality
- Get something working end-to-end
- Validate basic assumptions

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer
- Optimize database queries
- Implement load balancing
- Add monitoring

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

## Design Decisions Log

### 1. Operational Transformation over CRDT
**Decision:** Use OT for collaborative editing
**Rationale:**
- Lower memory overhead (no per-character metadata)
- Battle-tested algorithm (Google Docs uses OT)
- Better control over conflict resolution behavior
- Simpler for learning purposes

### 2. TipTap/ProseMirror for Editor
**Decision:** Use TipTap with ProseMirror
**Rationale:**
- Rich extension ecosystem
- ProseMirror provides solid foundation for collaborative editing
- Good TypeScript support
- Active community

### 3. Session-based Auth with Redis
**Decision:** Cookie-based sessions stored in Redis
**Rationale:**
- Simpler than JWT rotation
- Redis provides fast session lookup
- Easy to invalidate sessions
- Appropriate for learning project

### 4. Sticky Sessions by Document
**Decision:** Route all operations for a document to same server
**Rationale:**
- Simplifies OT processing (single source of truth per doc)
- Reduces coordination overhead
- Redis pub/sub handles cross-server communication

## Iterations and Learnings

### Iteration 1: Basic Structure
- Set up project structure with backend and frontend
- Created Docker Compose for PostgreSQL and Redis
- Established TypeScript configurations

### Iteration 2: Authentication & Documents
- Implemented session-based authentication
- Created document CRUD with permissions
- Added sharing functionality

### Iteration 3: Real-time Collaboration
- Implemented WebSocket server with ws library
- Created OT engine with transform functions
- Added presence tracking via Redis pub/sub

### Iteration 4: Rich Text Editor
- Integrated TipTap with custom toolbar
- Added formatting options (bold, italic, headings, lists)
- Implemented placeholder and highlight extensions

### Iteration 5: Comments & Versions
- Created comment system with threads
- Implemented version history with snapshots
- Added restore functionality

## Questions and Discussions

### Open Questions
1. How to handle very large documents (100+ pages)?
2. Best approach for offline editing queue?
3. Should we add real-time spell checking?

### Resolved
1. OT vs CRDT - Chose OT for simplicity and memory efficiency
2. Editor library - TipTap provides best DX and features

## Resources and References

- [Operational Transformation FAQ](https://www3.ntu.edu.sg/home/czsun/projects/otfaq/)
- [TipTap Documentation](https://tiptap.dev/docs)
- [ProseMirror Guide](https://prosemirror.net/docs/guide/)
- [Google Docs System Design](./system-design-answer.md)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Full OT integration with editor
- [ ] Add offline support
- [ ] Implement suggestions mode
- [ ] Add export functionality
- [ ] Test and iterate

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*
