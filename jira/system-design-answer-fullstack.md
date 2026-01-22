# Design Jira - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Introduction (2 minutes)

"Thanks for the opportunity. Today I'll design Jira, an issue tracking and project management system. As a fullstack engineer, I'll focus on the integration points between frontend and backend:

1. **End-to-end workflow transitions** from drag-drop to database update
2. **Optimistic updates with conflict resolution** using version-based locking
3. **Real-time board synchronization** when teammates modify issues
4. **JQL search** from autocomplete input to Elasticsearch query
5. **Shared type contracts** ensuring consistency across the stack

I'll demonstrate how frontend and backend work together to deliver a responsive, consistent experience."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For the integrated system:

1. **Board Operations**: Drag issues across columns with instant feedback
2. **Issue Editing**: Inline field changes with server persistence
3. **Workflow Transitions**: Execute transitions with validation
4. **Search**: JQL queries with autocomplete and results
5. **Real-time Updates**: See teammate changes without refresh"

### Non-Functional Requirements

"For user experience and reliability:

- **Latency**: < 100ms perceived response for all interactions
- **Consistency**: No lost updates from concurrent edits
- **Offline Resilience**: Queue operations when disconnected
- **Type Safety**: Shared contracts prevent runtime errors"

---

## Architecture Overview (8 minutes)

### End-to-End Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Board       │  │ Issue       │  │ Search      │              │
│  │ Component   │  │ Detail      │  │ Component   │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│         ▼                ▼                ▼                      │
│  ┌─────────────────────────────────────────────────┐            │
│  │              Zustand Stores                      │            │
│  │   boardStore │ issueStore │ searchStore          │            │
│  └─────────────────────────────────────────────────┘            │
│         │                │                │                      │
│         ▼                ▼                ▼                      │
│  ┌─────────────────────────────────────────────────┐            │
│  │              API Service (fetch + WebSocket)     │            │
│  └─────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Backend                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Issue       │  │ Workflow    │  │ Search      │              │
│  │ Service     │  │ Engine      │  │ Service     │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│         ▼                ▼                ▼                      │
│  ┌─────────────────────────────────────────────────┐            │
│  │   PostgreSQL   │   Redis   │   Elasticsearch    │            │
│  └─────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### Shared Type Contracts

```typescript
// shared/types.ts - Used by both frontend and backend

export interface Issue {
  id: number;
  key: string;
  summary: string;
  description: string;
  issueType: IssueType;
  status: Status;
  priority: Priority;
  assignee: User | null;
  reporter: User;
  storyPoints: number | null;
  customFields: Record<string, any>;
  version: number;  // Optimistic locking
  createdAt: string;
  updatedAt: string;
}

export interface Status {
  id: number;
  name: string;
  category: 'todo' | 'in_progress' | 'done';
}

export interface Transition {
  id: number;
  name: string;
  from: Status | null;  // null = from any
  to: Status;
}

export interface UpdateIssueRequest {
  summary?: string;
  description?: string;
  assigneeId?: string | null;
  priorityId?: number;
  storyPoints?: number | null;
  customFields?: Record<string, any>;
  version: number;  // Required for optimistic locking
}

export interface TransitionRequest {
  transitionId: number;
  fields?: Record<string, any>;  // Fields to update during transition
}

export interface ApiError {
  error: string;
  message: string;
  code?: 'CONFLICT' | 'VALIDATION_ERROR' | 'FORBIDDEN' | 'NOT_FOUND';
  field?: string;  // For validation errors
}
```

---

## Deep Dive: Workflow Transition Flow (12 minutes)

### Frontend: Drag and Drop Handler

```tsx
// stores/boardStore.ts
export const useBoardStore = create<BoardState>((set, get) => ({
  columns: [],

  moveIssue: async (issueId: number, toStatusId: number) => {
    const { columns } = get();

    // Find issue
    let issue: Issue | undefined;
    let fromColumn: BoardColumn | undefined;

    for (const col of columns) {
      const found = col.issues.find((i) => i.id === issueId);
      if (found) {
        issue = found;
        fromColumn = col;
        break;
      }
    }

    if (!issue || issue.status.id === toStatusId) return;

    const toColumn = columns.find((col) => col.status.id === toStatusId);
    if (!toColumn) return;

    // Store original state for rollback
    const originalColumns = columns;

    // Optimistic update
    set({
      columns: columns.map((col) => {
        if (col.status.id === fromColumn!.status.id) {
          return {
            ...col,
            issues: col.issues.filter((i) => i.id !== issueId),
          };
        }
        if (col.status.id === toStatusId) {
          return {
            ...col,
            issues: [...col.issues, { ...issue!, status: col.status }],
          };
        }
        return col;
      }),
    });

    try {
      // Find transition to target status
      const transitions = await api.getAvailableTransitions(issue.key);
      const transition = transitions.find((t) => t.to.id === toStatusId);

      if (!transition) {
        throw new Error('No valid transition to target status');
      }

      await api.executeTransition(issue.id, {
        transitionId: transition.id,
      });
    } catch (error: any) {
      // Rollback on failure
      set({ columns: originalColumns });

      // Show error to user
      if (error.code === 'CONFLICT') {
        toast.error('Issue was modified. Refreshing board...');
        get().fetchBoard(issue!.projectKey);
      } else if (error.code === 'FORBIDDEN') {
        toast.error('You cannot perform this transition');
      } else {
        toast.error(error.message || 'Transition failed');
      }
    }
  },
}));
```

### API Client with Error Handling

```typescript
// services/api.ts
const BASE_URL = '/api/v1';

class ApiClient {
  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      credentials: 'include',  // Include session cookie
    });

    if (!response.ok) {
      const error: ApiError = await response.json();

      if (response.status === 409) {
        throw { ...error, code: 'CONFLICT' };
      }
      if (response.status === 403) {
        throw { ...error, code: 'FORBIDDEN' };
      }
      if (response.status === 400) {
        throw { ...error, code: 'VALIDATION_ERROR' };
      }

      throw error;
    }

    return response.json();
  }

  async getAvailableTransitions(issueKey: string): Promise<Transition[]> {
    return this.request(`/issues/${issueKey}/transitions`);
  }

  async executeTransition(
    issueId: number,
    request: TransitionRequest
  ): Promise<Issue> {
    return this.request(`/issues/${issueId}/transitions`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async updateIssue(
    issueKey: string,
    updates: UpdateIssueRequest
  ): Promise<Issue> {
    return this.request(`/issues/${issueKey}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }
}

export const api = new ApiClient();
```

### Backend: Transition Endpoint

```typescript
// routes/issues.ts
router.post('/issues/:issueId/transitions', async (req, res) => {
  const { issueId } = req.params;
  const { transitionId, fields = {} } = req.body as TransitionRequest;
  const userId = req.session.userId;

  try {
    const result = await executeTransition(
      parseInt(issueId),
      transitionId,
      userId,
      fields
    );

    res.json(result);
  } catch (error: any) {
    if (error instanceof ConflictError) {
      return res.status(409).json({
        error: 'Conflict',
        message: error.message,
        code: 'CONFLICT',
      });
    }
    if (error instanceof ForbiddenError) {
      return res.status(403).json({
        error: 'Forbidden',
        message: error.message,
        code: 'FORBIDDEN',
      });
    }
    if (error instanceof ValidationError) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.message,
        code: 'VALIDATION_ERROR',
        field: error.field,
      });
    }

    logger.error('Transition failed', { issueId, transitionId, error });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
```

### Backend: Workflow Engine

```typescript
// services/workflowEngine.ts
export async function executeTransition(
  issueId: number,
  transitionId: number,
  userId: string,
  fields: Record<string, any> = {}
): Promise<Issue> {
  const issue = await db('issues').where({ id: issueId }).first();
  if (!issue) throw new NotFoundError('Issue not found');

  const workflow = await getWorkflowForProject(issue.project_id);
  const transition = workflow.transitions.find((t) => t.id === transitionId);
  if (!transition) throw new ValidationError('Invalid transition');

  // Check source status
  if (
    transition.from_status_id !== null &&
    transition.from_status_id !== issue.status_id
  ) {
    throw new ValidationError('Cannot transition from current status');
  }

  // Check conditions (authorization)
  for (const condition of transition.conditions) {
    const allowed = await checkCondition(condition, issue, userId);
    if (!allowed) {
      throw new ForbiddenError(`Condition failed: ${condition.type}`);
    }
  }

  // Run validators (data validation)
  const mergedIssue = { ...issue, ...fields };
  for (const validator of transition.validators) {
    const valid = await runValidator(validator, mergedIssue);
    if (!valid) {
      throw new ValidationError(
        `Validation failed: ${validator.type}`,
        validator.config.field
      );
    }
  }

  // Execute transition atomically
  const updatedIssue = await db.transaction(async (trx) => {
    const previousStatus = issue.status_id;

    // Update with optimistic locking
    const updated = await trx('issues')
      .where({ id: issueId, version: issue.version })
      .update({
        status_id: transition.to_status_id,
        ...fields,
        version: issue.version + 1,
        updated_at: trx.fn.now(),
      })
      .returning('*');

    if (updated.length === 0) {
      throw new ConflictError('Issue was modified by another user');
    }

    // Record history
    await trx('issue_history').insert({
      issue_id: issueId,
      user_id: userId,
      field: 'status',
      old_value: previousStatus.toString(),
      new_value: transition.to_status_id.toString(),
    });

    return updated[0];
  });

  // Run post-functions asynchronously
  for (const postFunc of transition.post_functions) {
    await runPostFunction(postFunc, issue, transition, userId);
  }

  // Publish event for real-time updates
  await publishEvent('issue.transitioned', {
    issueId,
    fromStatus: issue.status_id,
    toStatus: transition.to_status_id,
    actorId: userId,
  });

  // Return full issue with relations
  return await getIssueWithRelations(issueId);
}
```

---

## Deep Dive: Conflict Resolution (8 minutes)

### Version-Based Optimistic Locking

```
Timeline of concurrent edits:

User A reads issue (version 1)
                                    User B reads issue (version 1)
User A updates summary (version 1 → 2)
                                    User B updates priority (version 1 → ?)
                                    ↓
                                    CONFLICT! Version mismatch
                                    ↓
                                    UI shows merge dialog
```

### Frontend: Handling Conflicts

```tsx
// hooks/useIssueDetail.ts
export function useIssueDetail(issueKey: string) {
  const [state, setState] = useState<IssueDetailState>({
    issue: null,
    conflict: null,  // Stores server version on conflict
    // ...
  });

  const updateIssue = useCallback(async (updates: Partial<Issue>) => {
    if (!state.issue) return;

    const previousIssue = state.issue;

    // Optimistic update
    setState((prev) => ({
      ...prev,
      isSaving: true,
      issue: { ...prev.issue!, ...updates },
    }));

    try {
      const updated = await api.updateIssue(issueKey, {
        ...updates,
        version: state.issue.version,
      });

      setState((prev) => ({
        ...prev,
        isSaving: false,
        issue: updated,
        conflict: null,
      }));
    } catch (error: any) {
      // Rollback UI
      setState((prev) => ({
        ...prev,
        isSaving: false,
        issue: previousIssue,
      }));

      if (error.code === 'CONFLICT') {
        // Fetch server version for merge
        const serverIssue = await api.getIssue(issueKey);

        setState((prev) => ({
          ...prev,
          conflict: {
            serverVersion: serverIssue,
            localChanges: updates,
          },
        }));
      } else {
        throw error;
      }
    }
  }, [issueKey, state.issue]);

  const resolveConflict = useCallback(async (resolution: 'keep_mine' | 'keep_theirs' | 'merge') => {
    if (!state.conflict) return;

    if (resolution === 'keep_theirs') {
      setState((prev) => ({
        ...prev,
        issue: prev.conflict!.serverVersion,
        conflict: null,
      }));
    } else if (resolution === 'keep_mine') {
      // Retry with new version
      await updateIssue({
        ...state.conflict.localChanges,
        version: state.conflict.serverVersion.version,
      });
    }
    // 'merge' would open a merge UI
  }, [state.conflict, updateIssue]);

  return { state, actions: { updateIssue, resolveConflict } };
}
```

### Conflict Resolution Dialog

```tsx
// components/ConflictDialog.tsx
interface ConflictDialogProps {
  conflict: {
    serverVersion: Issue;
    localChanges: Partial<Issue>;
  };
  onResolve: (resolution: 'keep_mine' | 'keep_theirs') => void;
}

export function ConflictDialog({ conflict, onResolve }: ConflictDialogProps) {
  const changedFields = Object.keys(conflict.localChanges);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Conflict Detected
        </h2>

        <p className="text-gray-600 mb-4">
          This issue was modified by another user while you were editing.
        </p>

        <div className="bg-gray-50 rounded p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">
            Your changes:
          </h3>
          <ul className="text-sm text-gray-600 space-y-1">
            {changedFields.map((field) => (
              <li key={field}>
                <span className="font-medium">{field}:</span>{' '}
                {String(conflict.localChanges[field])}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => onResolve('keep_theirs')}
            className="flex-1 px-4 py-2 border rounded hover:bg-gray-50"
          >
            Discard My Changes
          </button>
          <button
            onClick={() => onResolve('keep_mine')}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Keep My Changes
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

## Deep Dive: Real-Time Updates (8 minutes)

### WebSocket Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Browser A  │     │  Browser B  │     │  Browser C  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │      WebSocket Connections            │
       ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────┐
│                   WebSocket Hub                      │
│           (subscriptions by project/board)           │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│                    Redis Pub/Sub                     │
│               (cross-server messaging)               │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│                   Issue Service                      │
│              (publishes events on changes)           │
└─────────────────────────────────────────────────────┘
```

### Backend: WebSocket Server

```typescript
// websocket/hub.ts
import { WebSocketServer, WebSocket } from 'ws';
import { redis } from '../shared/cache';

interface Client {
  ws: WebSocket;
  userId: string;
  subscriptions: Set<string>;  // 'board:123', 'issue:PROJ-456'
}

class WebSocketHub {
  private clients: Map<string, Client> = new Map();

  constructor(wss: WebSocketServer) {
    wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    // Subscribe to Redis for cross-server events
    redis.subscribe('issue.events', (message) => {
      this.broadcastEvent(JSON.parse(message));
    });
  }

  private handleConnection(ws: WebSocket, req: any) {
    const userId = req.session?.userId;
    if (!userId) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const clientId = `${userId}-${Date.now()}`;
    const client: Client = { ws, userId, subscriptions: new Set() };
    this.clients.set(clientId, client);

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      this.handleMessage(clientId, message);
    });

    ws.on('close', () => {
      this.clients.delete(clientId);
    });
  }

  private handleMessage(clientId: string, message: any) {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case 'subscribe':
        client.subscriptions.add(message.channel);
        break;

      case 'unsubscribe':
        client.subscriptions.delete(message.channel);
        break;
    }
  }

  private broadcastEvent(event: any) {
    const channels = this.getChannelsForEvent(event);

    for (const [, client] of this.clients) {
      // Check if client is subscribed to any relevant channel
      const isSubscribed = channels.some((ch) => client.subscriptions.has(ch));

      // Don't send to actor (they have optimistic update)
      if (isSubscribed && client.userId !== event.actorId) {
        client.ws.send(JSON.stringify(event));
      }
    }
  }

  private getChannelsForEvent(event: any): string[] {
    const channels: string[] = [];

    if (event.projectId) {
      channels.push(`board:${event.projectId}`);
    }
    if (event.issueKey) {
      channels.push(`issue:${event.issueKey}`);
    }

    return channels;
  }
}
```

### Frontend: WebSocket Client

```typescript
// services/websocket.ts
class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private listeners: Map<string, Set<(event: any) => void>> = new Map();

  connect() {
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      // Resubscribe to channels
      for (const channel of this.listeners.keys()) {
        this.ws?.send(JSON.stringify({ type: 'subscribe', channel }));
      }
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.notifyListeners(data);
    };

    this.ws.onclose = () => {
      this.attemptReconnect();
    };
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

    const delay = Math.pow(2, this.reconnectAttempts) * 1000;
    this.reconnectAttempts++;

    setTimeout(() => this.connect(), delay);
  }

  subscribe(channel: string, callback: (event: any) => void) {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
      this.ws?.send(JSON.stringify({ type: 'subscribe', channel }));
    }

    this.listeners.get(channel)!.add(callback);

    // Return unsubscribe function
    return () => {
      const channelListeners = this.listeners.get(channel);
      if (channelListeners) {
        channelListeners.delete(callback);
        if (channelListeners.size === 0) {
          this.listeners.delete(channel);
          this.ws?.send(JSON.stringify({ type: 'unsubscribe', channel }));
        }
      }
    };
  }

  private notifyListeners(event: any) {
    const channels = this.getChannelsForEvent(event);

    for (const channel of channels) {
      const listeners = this.listeners.get(channel);
      if (listeners) {
        for (const callback of listeners) {
          callback(event);
        }
      }
    }
  }
}

export const wsClient = new WebSocketClient();
```

### Integrating Real-Time Updates in Board

```tsx
// components/Board.tsx
import { useEffect } from 'react';
import { useBoardStore } from '../stores/boardStore';
import { wsClient } from '../services/websocket';

export function Board({ projectKey }: { projectKey: string }) {
  const { columns, fetchBoard, applyRemoteUpdate } = useBoardStore();

  useEffect(() => {
    fetchBoard(projectKey);

    // Subscribe to real-time updates
    const unsubscribe = wsClient.subscribe(`board:${projectKey}`, (event) => {
      switch (event.type) {
        case 'issue.transitioned':
        case 'issue.updated':
          applyRemoteUpdate(event);
          break;

        case 'issue.created':
          // Add new issue to appropriate column
          applyRemoteUpdate(event);
          break;
      }
    });

    return () => unsubscribe();
  }, [projectKey]);

  // ... render board
}
```

---

## Deep Dive: JQL Search Integration (5 minutes)

### Frontend: Search Component with Autocomplete

```tsx
// components/SearchBar.tsx
import { useState, useEffect, useRef } from 'react';
import { useJQLAutocomplete } from '../hooks/useJQLAutocomplete';
import { api } from '../services/api';

export function SearchBar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Issue[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const { suggestions, getSuggestions } = useJQLAutocomplete();
  const debounceRef = useRef<NodeJS.Timeout>();

  const handleInputChange = (value: string) => {
    setQuery(value);

    // Get autocomplete suggestions
    getSuggestions(value);

    // Debounce search
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      if (value.trim()) {
        setIsSearching(true);
        try {
          const searchResults = await api.searchIssues(value);
          setResults(searchResults);
        } finally {
          setIsSearching(false);
        }
      } else {
        setResults([]);
      }
    }, 300);
  };

  return (
    <div className="relative w-full max-w-xl">
      <input
        type="text"
        value={query}
        onChange={(e) => handleInputChange(e.target.value)}
        placeholder="Search issues (JQL)"
        className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
      />

      {/* Autocomplete Suggestions */}
      {suggestions.length > 0 && (
        <ul className="absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg">
          {suggestions.map((suggestion, i) => (
            <li
              key={i}
              onClick={() => setQuery(suggestion.text)}
              className="px-4 py-2 hover:bg-gray-100 cursor-pointer"
            >
              <span className="font-mono text-sm">{suggestion.text}</span>
              <span className="text-gray-500 ml-2">{suggestion.description}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Search Results */}
      {results.length > 0 && (
        <div className="absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-96 overflow-y-auto">
          {results.map((issue) => (
            <IssueSearchResult key={issue.id} issue={issue} />
          ))}
        </div>
      )}

      {isSearching && (
        <div className="absolute right-3 top-2.5">
          <Spinner size="sm" />
        </div>
      )}
    </div>
  );
}
```

### Backend: Search Endpoint

```typescript
// routes/search.ts
router.get('/search', async (req, res) => {
  const { q: jql, limit = 50, offset = 0 } = req.query;
  const userId = req.session.userId;

  try {
    // Parse JQL to AST
    const parser = new JQLParser();
    const ast = parser.parse(jql as string);

    // Translate to Elasticsearch query
    const esQuery = parser.toElasticsearch(ast, {
      currentUser: await getUser(userId),
    });

    // Execute search
    const result = await esClient.search({
      index: 'issues',
      body: {
        query: esQuery,
        from: parseInt(offset as string),
        size: parseInt(limit as string),
        sort: [{ updated_at: 'desc' }],
      },
    });

    // Filter by permissions
    const issues = await filterByPermissions(
      result.hits.hits.map((hit) => hit._source),
      userId
    );

    res.json({
      issues,
      total: result.hits.total.value,
    });
  } catch (error: any) {
    if (error.name === 'JQLSyntaxError') {
      return res.status(400).json({
        error: 'Invalid JQL',
        message: error.message,
        position: error.position,
      });
    }
    throw error;
  }
});
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Conflict resolution | Version-based OCC | Last-write-wins | Prevents silent data loss |
| Real-time | WebSocket + Redis | Polling | Lower latency, better UX |
| Search | Elasticsearch | PostgreSQL FTS | Complex JQL, aggregations |
| State sync | Event-driven | Full refresh | Efficient updates |
| Type sharing | Manual contracts | OpenAPI codegen | Simpler, less tooling |

---

## Summary

"I've designed Jira with end-to-end integration:

1. **Workflow Transitions**: Drag-drop triggers optimistic update, backend validates conditions/permissions, executes atomically with version check, broadcasts via WebSocket
2. **Conflict Resolution**: Version-based locking with merge UI when conflicts detected
3. **Real-Time Updates**: WebSocket hub with Redis pub/sub for cross-server delivery, smart subscription management
4. **JQL Search**: Frontend autocomplete, backend parser translates to Elasticsearch queries
5. **Shared Contracts**: TypeScript interfaces used by both frontend and backend ensure type safety

The design prioritizes immediate feedback through optimistic updates while maintaining data integrity through version-based conflict detection and proper error handling."
