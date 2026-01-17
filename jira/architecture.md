# Design Jira - Architecture

## System Overview

Jira is an issue tracking system with customizable workflows. Core challenges involve flexible workflow engines, custom field schemas, and complex permission models.

**Learning Goals:**
- Build configurable workflow engines
- Design dynamic field schemas
- Implement complex permission systems
- Create query languages (JQL)

---

## Requirements

### Functional Requirements

1. **Issues**: Create, update, transition issues
2. **Workflows**: Customizable state machines
3. **Boards**: Kanban and Scrum views
4. **Search**: JQL-based issue search
5. **Reports**: Burndown, velocity, statistics

### Non-Functional Requirements

- **Availability**: 99.9% uptime
- **Latency**: < 200ms for issue operations
- **Scale**: 1M projects, 100M issues
- **Audit**: Full history of all changes

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│         Web │ Mobile │ IDE Plugins │ CLI                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│                  (Auth, Rate Limiting)                          │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Issue Service │    │Workflow Engine│    │Search Service │
│               │    │               │    │               │
│ - CRUD        │    │ - Transitions │    │ - JQL Parser  │
│ - Comments    │    │ - Validators  │    │ - Indexing    │
│ - Attachments │    │ - Actions     │    │ - Aggregation │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │              Elasticsearch                    │
│   - Issues      │              - Issue search                   │
│   - Workflows   │              - JQL queries                    │
│   - History     │                                               │
└─────────────────┴───────────────────────────────────────────────┘
```

---

## Core Components

### 1. Workflow Engine

**Workflow Definition:**
```typescript
interface Workflow {
  id: string
  name: string
  statuses: Status[]
  transitions: Transition[]
}

interface Status {
  id: string
  name: string
  category: 'todo' | 'in_progress' | 'done'
}

interface Transition {
  id: string
  name: string
  from: string[] // Status IDs (empty = any)
  to: string // Target status ID
  conditions: Condition[]
  validators: Validator[]
  postFunctions: PostFunction[]
}

interface Condition {
  type: 'user_in_role' | 'issue_assignee' | 'custom'
  config: Record<string, any>
}
```

**Transition Execution:**
```javascript
async function executeTransition(issueId, transitionId, user) {
  const issue = await getIssue(issueId)
  const workflow = await getWorkflow(issue.projectId)
  const transition = workflow.transitions.find(t => t.id === transitionId)

  // Check conditions
  for (const condition of transition.conditions) {
    if (!await checkCondition(condition, issue, user)) {
      throw new Error(`Condition failed: ${condition.type}`)
    }
  }

  // Run validators
  for (const validator of transition.validators) {
    if (!await runValidator(validator, issue)) {
      throw new Error(`Validation failed: ${validator.type}`)
    }
  }

  // Update issue status
  const previousStatus = issue.status
  await db('issues')
    .where({ id: issueId })
    .update({ status: transition.to })

  // Run post-functions
  for (const postFunc of transition.postFunctions) {
    await runPostFunction(postFunc, issue, transition)
  }

  // Record history
  await recordHistory(issueId, 'status', previousStatus, transition.to, user)
}
```

### 2. Custom Fields

**Dynamic Schema:**
```sql
-- Field definitions per project
CREATE TABLE custom_field_definitions (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'text', 'number', 'select', 'user', 'date'
  config JSONB, -- Options for select, validation rules
  required BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Field values stored as JSONB on issues
CREATE TABLE issues (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  key VARCHAR(50) UNIQUE, -- e.g., "PROJ-123"
  summary VARCHAR(500) NOT NULL,
  description TEXT,
  issue_type VARCHAR(50),
  status VARCHAR(50),
  priority VARCHAR(50),
  assignee_id UUID REFERENCES users(id),
  reporter_id UUID REFERENCES users(id),
  custom_fields JSONB, -- { "field_123": "value", "field_456": 42 }
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 3. JQL Parser

**JQL Grammar:**
```
query        = clause (AND|OR clause)*
clause       = field operator value | "(" query ")"
field        = "project" | "status" | "assignee" | customField
operator     = "=" | "!=" | "~" | ">" | "<" | ">=" | "<=" | "IN" | "NOT IN"
value        = string | number | EMPTY | function
function     = "currentUser()" | "now()" | "startOfDay()" | ...
```

**Parser Implementation:**
```javascript
class JQLParser {
  parse(jql) {
    const tokens = this.tokenize(jql)
    return this.parseQuery(tokens)
  }

  toElasticsearch(ast) {
    if (ast.type === 'AND') {
      return { bool: { must: ast.clauses.map(c => this.toElasticsearch(c)) } }
    }
    if (ast.type === 'OR') {
      return { bool: { should: ast.clauses.map(c => this.toElasticsearch(c)) } }
    }
    if (ast.type === 'clause') {
      return this.clauseToES(ast)
    }
  }

  clauseToES(clause) {
    switch (clause.operator) {
      case '=':
        return { term: { [clause.field]: clause.value } }
      case '~':
        return { match: { [clause.field]: clause.value } }
      case 'IN':
        return { terms: { [clause.field]: clause.value } }
      // ... other operators
    }
  }
}

// Usage
const jql = 'project = PROJ AND status = "In Progress" AND assignee = currentUser()'
const ast = parser.parse(jql)
const esQuery = parser.toElasticsearch(ast)
```

### 4. Permission System

**Permission Model:**
```sql
-- Permission schemes define what permissions exist
CREATE TABLE permission_schemes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  is_default BOOLEAN DEFAULT FALSE
);

-- Permission grants map permissions to roles/users
CREATE TABLE permission_grants (
  scheme_id INTEGER REFERENCES permission_schemes(id),
  permission VARCHAR(100) NOT NULL, -- 'create_issue', 'edit_issue', 'transition', etc.
  grantee_type VARCHAR(50), -- 'role', 'user', 'group', 'anyone'
  grantee_id VARCHAR(100), -- Role name, user ID, or group ID
  PRIMARY KEY (scheme_id, permission, grantee_type, grantee_id)
);

-- Projects use permission schemes
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  key VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  permission_scheme_id INTEGER REFERENCES permission_schemes(id),
  workflow_id INTEGER REFERENCES workflows(id),
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Permission Check:**
```javascript
async function hasPermission(userId, projectId, permission) {
  const project = await getProject(projectId)
  const userRoles = await getUserRoles(userId, projectId)
  const userGroups = await getUserGroups(userId)

  const grants = await db('permission_grants')
    .where({ scheme_id: project.permissionSchemeId, permission })

  for (const grant of grants) {
    if (grant.grantee_type === 'anyone') return true
    if (grant.grantee_type === 'user' && grant.grantee_id === userId) return true
    if (grant.grantee_type === 'role' && userRoles.includes(grant.grantee_id)) return true
    if (grant.grantee_type === 'group' && userGroups.includes(grant.grantee_id)) return true
  }

  return false
}
```

---

## Database Schema

```sql
-- Projects
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  key VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  lead_id UUID REFERENCES users(id),
  permission_scheme_id INTEGER REFERENCES permission_schemes(id),
  workflow_scheme_id INTEGER REFERENCES workflow_schemes(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Issues
CREATE TABLE issues (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  key VARCHAR(50) UNIQUE NOT NULL,
  summary VARCHAR(500) NOT NULL,
  description TEXT,
  issue_type_id INTEGER REFERENCES issue_types(id),
  status_id INTEGER REFERENCES statuses(id),
  priority_id INTEGER REFERENCES priorities(id),
  assignee_id UUID REFERENCES users(id),
  reporter_id UUID REFERENCES users(id),
  parent_id INTEGER REFERENCES issues(id), -- For subtasks
  epic_id INTEGER REFERENCES issues(id),
  sprint_id INTEGER REFERENCES sprints(id),
  story_points INTEGER,
  custom_fields JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Issue history (audit trail)
CREATE TABLE issue_history (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id),
  user_id UUID REFERENCES users(id),
  field VARCHAR(100) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Comments
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id),
  author_id UUID REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. JSONB for Custom Fields

**Decision**: Store custom field values as JSONB

**Rationale**:
- Flexible per-project schema
- No table alterations for new fields
- Good PostgreSQL indexing support

**Trade-off**: Harder to enforce types at DB level

### 2. Workflow as Configuration

**Decision**: Workflows defined in database, not code

**Rationale**:
- Users can customize without developers
- Version and rollback workflows
- Per-project workflow assignment

### 3. JQL to Elasticsearch

**Decision**: Parse JQL and translate to ES queries

**Rationale**:
- Powerful user-facing query language
- Elasticsearch handles complex search
- Familiar to Jira users

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Custom fields | JSONB | EAV table | Simplicity, performance |
| Search | Elasticsearch | PostgreSQL FTS | JQL complexity |
| Workflow | DB-driven | Code-driven | Flexibility |
| History | Event table | Event sourcing | Simpler queries |
