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

### Phase 1: Core Issues (Completed)
- [x] Projects and issues
- [x] Basic CRUD
- [x] Standard fields

### Phase 2: Workflows (In Progress)
- [x] Status definitions
- [x] Transitions
- [x] Conditions and validators
- [x] Post-functions (assign, clear field, update field)

### Phase 3: Custom Fields (Partially Complete)
- [x] Field definitions schema
- [x] JSONB storage
- [ ] Field type validation UI
- [ ] Custom field editor

### Phase 4: Search (Complete)
- [x] JQL parser
- [x] Elasticsearch indexing
- [x] Quick search
- [ ] Saved filters

---

## Implementation Notes

### Workflow Engine

The workflow engine is database-driven, allowing users to customize without code changes:

```typescript
interface Transition {
  id: number;
  name: string;
  from_status_id: number | null; // null = from any status
  to_status_id: number;
  conditions: TransitionCondition[];
  validators: TransitionValidator[];
  post_functions: TransitionPostFunction[];
}
```

Condition types implemented:
- `always` - Always allow
- `user_in_role` - User must have specific project role
- `issue_assignee` - Only assignee can transition

Validator types implemented:
- `field_required` - Require a field to have a value
- `field_value` - Require specific field value

Post-function types implemented:
- `assign_to_current_user` - Set assignee to current user
- `clear_field` - Clear a field value
- `update_field` - Set a field to specific value
- `send_notification` - (Placeholder) Send notification

### JQL Parser

The JQL parser tokenizes input, builds an AST, and converts to Elasticsearch query:

```javascript
// Input: "project = DEMO AND status = 'In Progress'"
// Output Elasticsearch query:
{
  bool: {
    must: [
      { term: { project_key: "DEMO" } },
      { term: { status: "In Progress" } }
    ]
  }
}
```

Supported features:
- AND/OR boolean operators
- Parentheses for grouping
- Comparison operators: =, !=, ~, >, <, >=, <=, IN, NOT IN, IS, IS NOT
- Functions: currentUser(), now(), startOfDay(), endOfDay()

### Database Schema Highlights

1. **Issues table** uses JSONB for custom fields with GIN index
2. **History table** tracks all field changes for audit trail
3. **Permission grants** use scheme pattern for reusability
4. **Project members** link users to projects with roles

---

## Resources

- [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- [Workflow Engine Patterns](https://www.workflowpatterns.com/)
- [Building Query Languages](https://tomassetti.me/antlr-mega-tutorial/)
