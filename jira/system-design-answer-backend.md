# Design Jira - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thanks for the opportunity. Today I'll design Jira, an issue tracking and project management system. From a backend perspective, Jira is fascinating because it combines:

1. **Configurable workflow engines** with database-driven state machines
2. **Dynamic field schemas** using JSONB for flexible custom fields
3. **Complex permission models** with schemes and role-based access
4. **JQL parser** that translates a DSL to Elasticsearch queries

I'll focus on the workflow engine internals, the permission checking pipeline, and how we ensure consistency across distributed operations."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For the backend services:

1. **Issue CRUD**: Create, update, transition issues with validation
2. **Workflow Engine**: Execute transitions with conditions, validators, post-functions
3. **Custom Fields**: JSONB storage with type validation
4. **JQL Parser**: Parse query language and translate to Elasticsearch
5. **Audit Trail**: Record every change with actor, timestamp, diff"

### Non-Functional Requirements

"For scale and reliability:

- **Availability**: 99.9% uptime with graceful degradation
- **Latency**: < 200ms for issue operations, < 1s for complex JQL
- **Scale**: 1M projects, 100M issues
- **Consistency**: Strong for issue writes, eventual for search
- **Idempotency**: Safe retries for webhook integrations"

---

## High-Level Architecture (8 minutes)

### Service Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      API Gateway                                 │
│              (Auth, Rate Limiting, Idempotency)                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Issue Service │    │Workflow Engine│    │Search Service │
│               │    │               │    │               │
│ - CRUD        │    │ - Transitions │    │ - JQL Parser  │
│ - Comments    │    │ - Validators  │    │ - ES Queries  │
│ - Attachments │    │ - Post-funcs  │    │ - Aggregation │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Data Layer                               │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │       Redis       │     Elasticsearch          │
│   - Issues      │   - Sessions      │     - Issue search         │
│   - Workflows   │   - Cache         │     - JQL execution        │
│   - History     │   - Idempotency   │     - Aggregations         │
└─────────────────┴───────────────────┴───────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│                       RabbitMQ                                   │
│     issue.events (fanout) → Search │ Notifications │ Webhooks    │
└─────────────────────────────────────────────────────────────────┘
```

### Database Schema (PostgreSQL)

```sql
-- Core issue storage with JSONB custom fields
CREATE TABLE issues (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  key VARCHAR(50) UNIQUE NOT NULL,  -- 'PROJ-123'
  summary VARCHAR(500) NOT NULL,
  description TEXT,
  issue_type_id INTEGER REFERENCES issue_types(id),
  status_id INTEGER REFERENCES statuses(id),
  priority_id INTEGER REFERENCES priorities(id),
  assignee_id UUID REFERENCES users(id),
  reporter_id UUID REFERENCES users(id),
  parent_id INTEGER REFERENCES issues(id),  -- Subtasks
  sprint_id INTEGER REFERENCES sprints(id),
  story_points INTEGER,
  custom_fields JSONB,  -- { "field_123": "value", "field_456": 42 }
  version INTEGER DEFAULT 1,  -- Optimistic locking
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- GIN index for efficient JSONB queries
CREATE INDEX idx_issues_custom_fields ON issues USING GIN(custom_fields);

-- Composite index for common queries
CREATE INDEX idx_issues_project_status ON issues(project_id, status_id);

-- Workflow definitions
CREATE TABLE workflows (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  is_default BOOLEAN DEFAULT FALSE
);

CREATE TABLE statuses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  category VARCHAR(20) NOT NULL  -- 'todo', 'in_progress', 'done'
);

CREATE TABLE transitions (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER REFERENCES workflows(id),
  name VARCHAR(100) NOT NULL,
  from_status_id INTEGER REFERENCES statuses(id),  -- NULL = from any
  to_status_id INTEGER REFERENCES statuses(id) NOT NULL,
  conditions JSONB DEFAULT '[]',
  validators JSONB DEFAULT '[]',
  post_functions JSONB DEFAULT '[]'
);

-- Audit trail
CREATE TABLE issue_history (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id),
  user_id UUID REFERENCES users(id),
  field VARCHAR(100) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Idempotency keys for safe retries
CREATE TABLE idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL,
  request_path VARCHAR(200) NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours'
);
```

---

## Deep Dive: Workflow Engine (12 minutes)

### Workflow Data Model

```typescript
interface Workflow {
  id: number;
  name: string;
  statuses: Status[];
  transitions: Transition[];
}

interface Transition {
  id: number;
  name: string;
  from_status_id: number | null;  // null = from any status
  to_status_id: number;
  conditions: Condition[];      // Who can execute
  validators: Validator[];      // What must be true
  post_functions: PostFunction[];  // Side effects
}

interface Condition {
  type: 'always' | 'user_in_role' | 'issue_assignee' | 'user_in_group';
  config: Record<string, any>;
}

interface Validator {
  type: 'field_required' | 'field_value' | 'custom_expression';
  config: { field?: string; value?: any };
}

interface PostFunction {
  type: 'assign_to_current_user' | 'clear_field' | 'update_field' | 'send_notification';
  config: Record<string, any>;
}
```

### Transition Execution Pipeline

```javascript
async function executeTransition(issueId, transitionId, userId, fields = {}) {
  const issue = await db('issues').where({ id: issueId }).first();
  if (!issue) throw new NotFoundError('Issue not found');

  const workflow = await getWorkflowForProject(issue.project_id);
  const transition = workflow.transitions.find(t => t.id === transitionId);

  // 1. Validate source status
  if (transition.from_status_id !== null &&
      transition.from_status_id !== issue.status_id) {
    throw new InvalidTransitionError(
      `Cannot transition from current status`
    );
  }

  // 2. Check conditions (authorization)
  for (const condition of transition.conditions) {
    const allowed = await checkCondition(condition, issue, userId);
    if (!allowed) {
      throw new ForbiddenError(`Condition failed: ${condition.type}`);
    }
  }

  // 3. Run validators (data validation)
  const mergedIssue = { ...issue, ...fields };
  for (const validator of transition.validators) {
    const valid = await runValidator(validator, mergedIssue);
    if (!valid) {
      throw new ValidationError(`Validation failed: ${validator.type}`);
    }
  }

  // 4. Execute transition atomically
  await db.transaction(async (trx) => {
    const previousStatus = issue.status_id;

    // Update issue with optimistic locking
    const updated = await trx('issues')
      .where({ id: issueId, version: issue.version })
      .update({
        status_id: transition.to_status_id,
        ...fields,
        version: issue.version + 1,
        updated_at: trx.fn.now()
      });

    if (updated === 0) {
      throw new ConflictError('Issue was modified by another user');
    }

    // Record history
    await trx('issue_history').insert({
      issue_id: issueId,
      user_id: userId,
      field: 'status',
      old_value: previousStatus.toString(),
      new_value: transition.to_status_id.toString()
    });
  });

  // 5. Run post-functions (async for non-critical)
  for (const postFunc of transition.post_functions) {
    await runPostFunction(postFunc, issue, transition, userId);
  }

  // 6. Publish event for async processing
  await publishEvent('issue.transitioned', {
    event_id: uuid(),
    issue_id: issueId,
    from_status: issue.status_id,
    to_status: transition.to_status_id,
    actor_id: userId
  });
}
```

### Condition Checking

```javascript
async function checkCondition(condition, issue, userId) {
  switch (condition.type) {
    case 'always':
      return true;

    case 'user_in_role': {
      const roles = await getUserProjectRoles(userId, issue.project_id);
      return roles.includes(condition.config.role);
    }

    case 'issue_assignee':
      return issue.assignee_id === userId;

    case 'user_in_group': {
      const groups = await getUserGroups(userId);
      return groups.includes(condition.config.group_id);
    }

    default:
      logger.warn('Unknown condition type', { type: condition.type });
      return false;
  }
}
```

### Post-Function Execution

```javascript
async function runPostFunction(postFunc, issue, transition, userId) {
  switch (postFunc.type) {
    case 'assign_to_current_user':
      await db('issues')
        .where({ id: issue.id })
        .update({ assignee_id: userId });
      break;

    case 'clear_field':
      await db('issues')
        .where({ id: issue.id })
        .update({ [postFunc.config.field]: null });
      break;

    case 'update_field':
      await db('issues')
        .where({ id: issue.id })
        .update({ [postFunc.config.field]: postFunc.config.value });
      break;

    case 'send_notification':
      // Queue for async delivery
      await publishEvent('notification.send', {
        issue_id: issue.id,
        template: postFunc.config.template,
        recipients: postFunc.config.recipients
      });
      break;
  }
}
```

---

## Deep Dive: Permission System (8 minutes)

### Permission Model

```sql
-- Permission schemes are templates
CREATE TABLE permission_schemes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  is_default BOOLEAN DEFAULT FALSE
);

-- Grants map permissions to grantees
CREATE TABLE permission_grants (
  scheme_id INTEGER REFERENCES permission_schemes(id),
  permission VARCHAR(100) NOT NULL,  -- 'create_issue', 'edit_issue', 'transition'
  grantee_type VARCHAR(50),          -- 'role', 'user', 'group', 'anyone'
  grantee_id VARCHAR(100),           -- Role name, user ID, or group ID
  PRIMARY KEY (scheme_id, permission, grantee_type, grantee_id)
);

-- Projects use schemes
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  key VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  permission_scheme_id INTEGER REFERENCES permission_schemes(id),
  workflow_id INTEGER REFERENCES workflows(id)
);

-- Project role membership
CREATE TABLE project_members (
  project_id UUID REFERENCES projects(id),
  user_id UUID REFERENCES users(id),
  role VARCHAR(50) NOT NULL,  -- 'admin', 'developer', 'viewer'
  PRIMARY KEY (project_id, user_id)
);
```

### Permission Checking

```javascript
async function hasPermission(userId, projectId, permission) {
  // Check cache first
  const cacheKey = `user-perms:${userId}:${projectId}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    const permissions = JSON.parse(cached);
    return permissions.includes(permission);
  }

  // Compute permissions
  const project = await getProject(projectId);
  const userRoles = await getUserProjectRoles(userId, projectId);
  const userGroups = await getUserGroups(userId);

  const grants = await db('permission_grants')
    .where({ scheme_id: project.permission_scheme_id, permission });

  let hasAccess = false;
  for (const grant of grants) {
    if (grant.grantee_type === 'anyone') {
      hasAccess = true;
      break;
    }
    if (grant.grantee_type === 'user' && grant.grantee_id === userId) {
      hasAccess = true;
      break;
    }
    if (grant.grantee_type === 'role' && userRoles.includes(grant.grantee_id)) {
      hasAccess = true;
      break;
    }
    if (grant.grantee_type === 'group' && userGroups.includes(grant.grantee_id)) {
      hasAccess = true;
      break;
    }
  }

  // Cache computed permissions (10 minute TTL)
  const allPerms = await computeAllPermissions(userId, projectId);
  await redis.setex(cacheKey, 600, JSON.stringify(allPerms));

  return hasAccess;
}

// Middleware for route protection
function requirePermission(permission) {
  return async (req, res, next) => {
    const { projectId } = req.params;
    const userId = req.session.userId;

    if (!await hasPermission(userId, projectId, permission)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `Missing permission: ${permission}`
      });
    }

    next();
  };
}
```

---

## Deep Dive: JQL Parser (8 minutes)

### JQL Grammar

```
query        = clause (AND|OR clause)*
clause       = field operator value | "(" query ")"
field        = "project" | "status" | "assignee" | "priority" | customField
operator     = "=" | "!=" | "~" | ">" | "<" | ">=" | "<=" | "IN" | "NOT IN"
value        = string | number | EMPTY | NULL | function
function     = "currentUser()" | "now()" | "startOfDay()" | "endOfDay()"
```

### Parser Implementation

```javascript
class JQLParser {
  constructor() {
    this.pos = 0;
    this.tokens = [];
  }

  parse(jql) {
    this.tokens = this.tokenize(jql);
    this.pos = 0;
    return this.parseQuery();
  }

  tokenize(jql) {
    const regex = /(\(|\)|AND|OR|=|!=|~|>=|<=|>|<|IN|NOT\s+IN|IS\s+NOT|IS|"[^"]*"|'[^']*'|\w+\(\)|\w+)/gi;
    return jql.match(regex) || [];
  }

  parseQuery() {
    let left = this.parseClause();

    while (this.pos < this.tokens.length) {
      const operator = this.tokens[this.pos]?.toUpperCase();
      if (operator === 'AND' || operator === 'OR') {
        this.pos++;
        const right = this.parseClause();
        left = { type: operator, clauses: [left, right] };
      } else {
        break;
      }
    }

    return left;
  }

  parseClause() {
    if (this.tokens[this.pos] === '(') {
      this.pos++;  // consume '('
      const query = this.parseQuery();
      this.pos++;  // consume ')'
      return query;
    }

    const field = this.tokens[this.pos++];
    const operator = this.tokens[this.pos++];
    const value = this.parseValue();

    return { type: 'clause', field, operator, value };
  }

  parseValue() {
    const token = this.tokens[this.pos++];

    // Handle functions
    if (token === 'currentUser()') {
      return { type: 'function', name: 'currentUser' };
    }
    if (token === 'now()') {
      return { type: 'function', name: 'now' };
    }

    // Handle quoted strings
    if (token.startsWith('"') || token.startsWith("'")) {
      return token.slice(1, -1);
    }

    return token;
  }

  toElasticsearch(ast, context = {}) {
    if (ast.type === 'AND') {
      return {
        bool: {
          must: ast.clauses.map(c => this.toElasticsearch(c, context))
        }
      };
    }

    if (ast.type === 'OR') {
      return {
        bool: {
          should: ast.clauses.map(c => this.toElasticsearch(c, context)),
          minimum_should_match: 1
        }
      };
    }

    if (ast.type === 'clause') {
      return this.clauseToES(ast, context);
    }
  }

  clauseToES(clause, context) {
    const field = this.mapField(clause.field);
    const value = this.resolveValue(clause.value, context);

    switch (clause.operator.toUpperCase()) {
      case '=':
        return { term: { [field]: value } };

      case '!=':
        return { bool: { must_not: { term: { [field]: value } } } };

      case '~':  // Contains (full-text)
        return { match: { [field]: value } };

      case 'IN':
        return { terms: { [field]: value } };

      case '>':
        return { range: { [field]: { gt: value } } };

      case '>=':
        return { range: { [field]: { gte: value } } };

      case '<':
        return { range: { [field]: { lt: value } } };

      case '<=':
        return { range: { [field]: { lte: value } } };

      case 'IS':
        if (value === 'EMPTY' || value === 'NULL') {
          return { bool: { must_not: { exists: { field } } } };
        }
        break;
    }
  }

  mapField(jqlField) {
    const fieldMap = {
      'project': 'project_key',
      'status': 'status_name',
      'assignee': 'assignee_username',
      'reporter': 'reporter_username',
      'priority': 'priority_name',
      'type': 'issue_type',
      'created': 'created_at',
      'updated': 'updated_at'
    };
    return fieldMap[jqlField.toLowerCase()] || jqlField;
  }

  resolveValue(value, context) {
    if (value?.type === 'function') {
      switch (value.name) {
        case 'currentUser':
          return context.currentUser?.username;
        case 'now':
          return new Date().toISOString();
        case 'startOfDay':
          return new Date().setHours(0, 0, 0, 0);
      }
    }
    return value;
  }
}

// Usage
const parser = new JQLParser();
const jql = 'project = DEMO AND status = "In Progress" AND assignee = currentUser()';
const ast = parser.parse(jql);
const esQuery = parser.toElasticsearch(ast, { currentUser: req.user });
```

---

## Consistency and Idempotency (5 minutes)

### Idempotency Layer

```javascript
// Middleware for idempotent operations
async function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (!idempotencyKey) {
    return next();  // Non-idempotent request
  }

  const userId = req.session.userId;

  // Check for existing response
  const existing = await db('idempotency_keys')
    .where({ key: idempotencyKey, user_id: userId })
    .first();

  if (existing) {
    // Replay cached response
    return res.status(existing.response_status).json(existing.response_body);
  }

  // Wrap response to capture for caching
  const originalJson = res.json.bind(res);
  res.json = async (body) => {
    await db('idempotency_keys').insert({
      key: idempotencyKey,
      user_id: userId,
      request_path: req.path,
      response_status: res.statusCode,
      response_body: body
    });
    return originalJson(body);
  };

  next();
}
```

### Optimistic Concurrency Control

```javascript
async function updateIssue(issueId, updates, expectedVersion) {
  const result = await db('issues')
    .where({ id: issueId, version: expectedVersion })
    .update({
      ...updates,
      version: expectedVersion + 1,
      updated_at: db.fn.now()
    });

  if (result === 0) {
    // Check if issue exists
    const issue = await db('issues').where({ id: issueId }).first();
    if (!issue) {
      throw new NotFoundError('Issue not found');
    }
    throw new ConflictError(
      'Issue was modified by another user. Refresh and retry.'
    );
  }

  return result;
}
```

---

## Observability (2 minutes)

### Prometheus Metrics

```javascript
const issuesCreated = new Counter({
  name: 'jira_issues_created_total',
  help: 'Total issues created',
  labelNames: ['project_key', 'issue_type']
});

const transitionsExecuted = new Counter({
  name: 'jira_transitions_total',
  help: 'Total workflow transitions',
  labelNames: ['project_key', 'from_status', 'to_status']
});

const searchLatency = new Histogram({
  name: 'jira_search_latency_seconds',
  help: 'JQL search latency',
  labelNames: ['query_type'],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5]
});

// Usage
issuesCreated.inc({ project_key: 'DEMO', issue_type: 'bug' });
transitionsExecuted.inc({
  project_key: 'DEMO',
  from_status: 'To Do',
  to_status: 'In Progress'
});

const timer = searchLatency.startTimer({ query_type: 'jql' });
const results = await executeJQL(query);
timer();
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Custom fields | JSONB | EAV table | Simpler queries, better performance |
| Search | Elasticsearch | PostgreSQL FTS | Complex JQL, aggregations |
| Workflows | Database-driven | Code-driven | User customization without deploys |
| History | Event table | Event sourcing | Simpler queries for UI |
| Cache | Cache-aside | Write-through | Write latency matters |
| Consistency | Strong + Eventual | Full eventual | Issue state must be immediately consistent |

---

## Summary

"I've designed Jira's backend with:

1. **Workflow Engine**: Database-driven state machine with conditions, validators, and post-functions executed atomically with optimistic locking
2. **Permission System**: Scheme-based grants with role/group/user resolution, cached in Redis
3. **JQL Parser**: Tokenizer → AST → Elasticsearch query translation
4. **JSONB Custom Fields**: Flexible schema with GIN indexes for efficient queries
5. **Idempotency Layer**: Request-level keys stored in PostgreSQL with 24h TTL
6. **Async Processing**: RabbitMQ fanout for search indexing, notifications, webhooks

The design prioritizes flexibility (every team customizes workflows) while maintaining strong consistency for issue writes and sub-second search performance through Elasticsearch."
