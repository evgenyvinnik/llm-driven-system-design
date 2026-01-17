# Figma - Collaborative Design and Prototyping Platform - Development with Claude

## Project Context

This document tracks the development journey of implementing a collaborative design and prototyping platform with real-time multiplayer editing.

## Key Challenges to Explore

1. Real-time collaborative editing (CRDT vs OT)
2. Vector graphics storage and rendering
3. Conflict resolution in concurrent edits
4. Version control and history management
5. Component and design system management
6. Performance with large design files

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Questions explored:**
- What are the core vs. nice-to-have features?
  - Core: Real-time collaboration, vector shapes, version history
  - Nice-to-have: Components, prototyping, export
- What scale are we targeting?
  - Local development with 2-5 concurrent users per file
- What are the key technical constraints?
  - Must run locally with Docker or native services

**Decisions made:**
- Use WebSocket for real-time communication
- PostgreSQL for file metadata and versions
- Redis for presence and pub/sub coordination
- Canvas API for rendering (simpler than WebGL for MVP)

### Phase 2: Initial Implementation
*In progress*

**Focus areas:**
- [x] Implement core functionality
- [x] Get something working end-to-end
- [ ] Validate basic assumptions
- [ ] Add more comprehensive error handling

**What was implemented:**
- Backend with Express + WebSocket
- PostgreSQL database schema with files, versions, operations
- Redis integration for presence tracking
- Frontend with React 19 + Zustand + Tailwind CSS
- Canvas-based editor with shapes (rectangle, ellipse, text)
- Layers panel and properties panel
- Real-time cursor presence
- Version history with save/restore
- File browser interface

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

### 2024-01-16: Initial Architecture Decisions

1. **Canvas API vs WebGL**: Chose Canvas 2D API for simplicity. WebGL would be needed for better performance with thousands of objects, but Canvas is sufficient for MVP.

2. **CRDT Implementation**: Simplified CRDT with Last-Writer-Wins for properties. A full CRDT library (like Yjs or Automerge) would be better for production but adds complexity.

3. **State Management**: Zustand chosen over Redux for simpler API and less boilerplate. Works well with React 19.

4. **WebSocket Library**: Used native `ws` package instead of Socket.io for more control over the protocol.

5. **Database Schema**: Denormalized `canvas_data` as JSONB in files table for simpler queries. Separate operations table for history.

## Iterations and Learnings

### Iteration 1: Basic Canvas Editor
- Implemented canvas with pan/zoom
- Added basic shape tools (rectangle, ellipse, text)
- Selection and drag to move objects

### Iteration 2: Panels
- Added layers panel with visibility/lock toggles
- Added properties panel with live updates
- Connected panels to Zustand store

### Iteration 3: Real-time Collaboration
- WebSocket connection with file subscription
- Presence updates for cursor positions
- Operation broadcasting between clients

### Iteration 4: Version History
- Save/restore versions via REST API
- Modal UI for version management
- Auto-save and named versions

## Questions and Discussions

### Open Questions

1. **How to handle offline editing?**
   - Would need to store operations in IndexedDB
   - Sync on reconnect with conflict resolution

2. **How to scale beyond single server?**
   - Sticky sessions by file_id
   - Redis pub/sub for cross-server presence
   - Consider sharding by file

3. **How to handle large files efficiently?**
   - Viewport culling (already implemented)
   - Lazy loading of objects
   - Level of detail rendering

## Resources and References

- [Figma Multiplayer Technology](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- [CRDTs and the Quest for Distributed Consistency](https://www.youtube.com/watch?v=B5NULPSiOGw)
- [Building Figma's Canvas](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Test and iterate
- [ ] Add more shape tools
- [ ] Implement undo/redo with operation log
- [ ] Add comments feature
- [ ] Add export functionality

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*
