# Design Jira - Development with Claude

## Project Context

Building an issue tracking system to understand workflow engines, custom fields, and complex permission models.

**Key Learning Goals:**
- Build configurable workflow state machines
- Design dynamic field schemas
- Implement role-based permissions with project context
- Create query language parser (JQL)

---

## Key Challenges to Explore

### 1. Workflow Customization

**Requirements:**
- Users define their own statuses
- Custom transitions between statuses
- Conditions on who can transition
- Actions triggered by transitions

### 2. Custom Field Performance

**Challenge**: Querying JSONB custom fields

**Solutions:**
- GIN index on JSONB column
- Materialize common queries
- Use Elasticsearch for search

### 3. Bulk Operations

**Problem**: Updating 1000 issues at once

**Solutions:**
- Background job processing
- Optimistic concurrency control
- Batch history recording

---

## Development Phases

### Phase 1: Core Issues
- [ ] Projects and issues
- [ ] Basic CRUD
- [ ] Standard fields

### Phase 2: Workflows
- [ ] Status definitions
- [ ] Transitions
- [ ] Conditions and validators

### Phase 3: Custom Fields
- [ ] Field definitions
- [ ] JSONB storage
- [ ] Field types

### Phase 4: Search
- [ ] JQL parser
- [ ] Elasticsearch indexing
- [ ] Filters and saved searches

---

## Resources

- [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- [Workflow Engine Patterns](https://www.workflowpatterns.com/)
- [Building Query Languages](https://tomassetti.me/antlr-mega-tutorial/)
