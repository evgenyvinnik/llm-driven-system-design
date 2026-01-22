# AI Code Assistant - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design the backend infrastructure for an AI-powered command-line coding assistant. Key challenges include:
- LLM provider abstraction for multi-vendor support
- Context window management with token limits
- Safe tool execution with permission enforcement
- Session persistence and recovery
- Caching strategy for file and response data
- Observability for debugging and performance monitoring

## Requirements Clarification

### Functional Requirements
1. **LLM Integration**: Support multiple LLM providers (Anthropic, OpenAI, local models)
2. **Tool System**: Extensible framework for file operations and shell commands
3. **Context Management**: Handle token limits with summarization and truncation
4. **Session Persistence**: Store and resume conversation state across restarts
5. **Permission System**: Enforce security policies for file and command access

### Non-Functional Requirements
1. **Latency**: First token in <500ms, streaming throughout
2. **Portability**: Single-user local application on macOS/Linux/Windows
3. **Reliability**: Graceful degradation on API failures
4. **Extensibility**: Plugin system for custom tools

### Scale Estimates
- Context window: 128K-200K tokens depending on model
- File handling: Support files up to 10MB
- Session history: Thousands of messages across sessions
- Tool execution cache: 500 entries per session

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           AI Code Assistant                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │     CLI      │───▶│    Agent     │───▶│   LLM API    │              │
│  │   Interface  │    │  Controller  │    │   (Claude)   │              │
│  └──────────────┘    └──────────────┘    └──────────────┘              │
│         │                   │                    │                       │
│         │                   ▼                    │                       │
│         │           ┌──────────────┐             │                       │
│         │           │    Tool      │             │                       │
│         │           │   Router     │             │                       │
│         │           └──────────────┘             │                       │
│         │                   │                    │                       │
│         │     ┌─────────────┼─────────────┐     │                       │
│         │     ▼             ▼             ▼     │                       │
│         │  ┌──────┐    ┌──────┐    ┌──────┐    │                       │
│         │  │ Read │    │ Edit │    │ Bash │    │                       │
│         │  │ Tool │    │ Tool │    │ Tool │    │                       │
│         │  └──────┘    └──────┘    └──────┘    │                       │
│         │     │             │             │     │                       │
│         ▼     ▼             ▼             ▼     ▼                       │
│  ┌────────────────────────────────────────────────────┐                │
│  │              Permission & Safety Layer              │                │
│  └────────────────────────────────────────────────────┘                │
│         │             │             │                                    │
│         ▼             ▼             ▼                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                              │
│  │   File   │  │  Shell   │  │ Session  │                              │
│  │  System  │  │ Sandbox  │  │  Store   │                              │
│  └──────────┘  └──────────┘  └──────────┘                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: LLM Provider Abstraction

### Provider Interface

```typescript
interface LLMProvider {
  name: string;

  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  countTokens(text: string): number;
}

interface CompletionRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

interface StreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end';
  content?: string;
  toolCall?: Partial<ToolCall>;
}
```

### Anthropic Implementation

```typescript
class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const stream = await this.client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      messages: this.formatMessages(request.messages),
      tools: this.formatTools(request.tools),
      max_tokens: request.maxTokens || 4096
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', content: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          yield { type: 'tool_call_delta', content: event.delta.partial_json };
        }
      }
    }
  }
}
```

### OpenAI Implementation

```typescript
class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const stream = await this.client.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: this.formatMessages(request.messages),
      tools: this.formatTools(request.tools),
      stream: true
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        yield { type: 'text', content: delta.content };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          yield { type: 'tool_call_delta', toolCall: tc };
        }
      }
    }
  }
}
```

### Retry Configuration

```typescript
const retryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableErrors: [
    'rate_limit_exceeded',
    'overloaded',
    'timeout',
    'connection_error'
  ]
};
```

## Deep Dive: Context Window Management

### The Problem

- LLM context windows are large but finite (128K-200K tokens)
- Long coding sessions easily exceed limits
- Tool outputs (file contents) can be huge

### Token Budgeting

```
Total: 128K tokens

System prompt:     2K (fixed)
Recent messages:  30K (last 10 turns)
Tool definitions:  5K (fixed)
Context summary:  10K (compressed history)
File cache:       40K (recently read files)
Response buffer:  40K (for LLM output)
```

### Multi-Strategy Compression

```typescript
class ContextManager {
  private maxTokens: number;
  private tokenizer: Tokenizer;
  private summarizer: Summarizer;

  constructor(maxTokens: number = 128000) {
    this.maxTokens = maxTokens;
  }

  async addMessage(message: Message): Promise<void> {
    const tokens = this.tokenizer.count(message.content);

    // Check if we need to compress
    if (this.currentTokens + tokens > this.maxTokens * 0.9) {
      await this.compressContext();
    }

    this.messages.push(message);
  }

  private async compressContext(): Promise<void> {
    // Strategy 1: Summarize old messages
    const oldMessages = this.messages.slice(0, -10);
    const recentMessages = this.messages.slice(-10);

    if (oldMessages.length > 0) {
      const summary = await this.summarizer.summarize(oldMessages);
      this.messages = [
        { role: 'system', content: `Previous context summary:\n${summary}` },
        ...recentMessages
      ];
    }

    // Strategy 2: Truncate large tool outputs
    for (const msg of this.messages) {
      if (msg.role === 'tool' && msg.content.length > 10000) {
        msg.content = msg.content.slice(0, 5000) +
          '\n... [truncated] ...\n' +
          msg.content.slice(-2000);
      }
    }
  }

  getMessages(): Message[] {
    return [
      { role: 'system', content: this.systemPrompt },
      ...this.messages
    ];
  }
}
```

### Compression Strategies

1. **Summarization** - Compress old conversation into summary
2. **Truncation** - Cut long tool outputs
3. **Selective retention** - Keep recent messages, system prompt
4. **Rolling window** - Fixed number of recent turns

## Deep Dive: Tool Execution and Idempotency

### Tool Interface

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  requiresApproval: boolean | ((params: unknown) => boolean);

  execute(params: unknown, context: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  workingDirectory: string;
  permissions: PermissionSet;
  abortSignal: AbortSignal;
}

interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

### Idempotent Tool Executor

Each tool call receives a unique ID from the LLM. This ID is used to prevent duplicate execution on retry, cache results for replay, and track execution history.

```typescript
interface IdempotentToolExecutor {
  private executionCache: Map<string, ToolResult>;
  private cacheFile: string;

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const idempotencyKey = toolCall.id; // UUID from LLM

    // Check if already executed
    if (this.executionCache.has(idempotencyKey)) {
      console.log(`[Replay] Using cached result for ${toolCall.name}`);
      return this.executionCache.get(idempotencyKey)!;
    }

    // Execute and cache
    const result = await this.tools.get(toolCall.name)!.execute(
      toolCall.params,
      this.context
    );

    this.executionCache.set(idempotencyKey, result);
    await this.persistCache(); // Survive process restarts

    return result;
  }

  // Expire old entries (older than current session)
  async cleanupCache(): Promise<void> {
    const sessionStart = this.session.startedAt.getTime();
    for (const [key, result] of this.executionCache) {
      if (result.timestamp < sessionStart) {
        this.executionCache.delete(key);
      }
    }
  }
}
```

### File Edit Conflict Resolution

```typescript
interface EditOperation {
  filePath: string;
  oldString: string;
  newString: string;
  expectedChecksum?: string; // SHA256 of file at read time
}

class ConflictAwareEditor {
  async edit(operation: EditOperation): Promise<EditResult> {
    const currentContent = await fs.readFile(operation.filePath, 'utf-8');
    const currentChecksum = this.checksum(currentContent);

    // Detect if file changed since last read
    if (operation.expectedChecksum &&
        operation.expectedChecksum !== currentChecksum) {
      return {
        success: false,
        error: 'File modified since last read. Please read again.',
        conflictType: 'stale_read',
        suggestion: 'Use Read tool to get current content'
      };
    }

    // Check uniqueness of old_string
    const occurrences = currentContent.split(operation.oldString).length - 1;

    if (occurrences === 0) {
      return {
        success: false,
        error: 'String not found - may have been edited',
        conflictType: 'missing_target'
      };
    }

    if (occurrences > 1 && !operation.replaceAll) {
      return {
        success: false,
        error: `Ambiguous: found ${occurrences} occurrences`,
        conflictType: 'ambiguous_target',
        suggestion: 'Provide more context or use replace_all'
      };
    }

    // Perform edit with atomic write
    const newContent = currentContent.replace(operation.oldString, operation.newString);
    await this.atomicWriter.write(operation.filePath, newContent);

    return { success: true, newChecksum: this.checksum(newContent) };
  }

  private checksum(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}
```

### Retry Semantics

| Operation | Retry Behavior | Notes |
|-----------|---------------|-------|
| File Read | Safe to retry | Always returns current state |
| File Write | Idempotent via checksum | Same content = no-op |
| File Edit | Conflict detection | Fails if file changed |
| Bash Command | Not automatically retried | User must approve re-execution |
| LLM API Call | Automatic retry with backoff | 3 attempts, exponential delay |

## Deep Dive: Caching Strategy

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Caching Layers                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   In-Memory  │───▶│  File Cache  │───▶│  Redis/CDN   │      │
│  │   (LRU)      │    │  (Optional)  │    │ (Production) │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│       │                    │                    │               │
│       ▼                    ▼                    ▼               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Cache Usage                            │  │
│  │  • File content checksums (5 min TTL)                    │  │
│  │  • LLM response cache for identical prompts (10 min)     │  │
│  │  • Tool execution results by idempotency key             │  │
│  │  • Session state (persisted on change)                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Cache-Aside Pattern

```typescript
class CacheAside<T> {
  private cache: LRUCache<string, CacheEntry<T>>;

  constructor(options: { maxSize: number; defaultTtlMs: number }) {
    this.cache = new LRUCache({
      max: options.maxSize,
      ttl: options.defaultTtlMs
    });
  }

  async get(key: string, loader: () => Promise<T>): Promise<T> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached && !this.isExpired(cached)) {
      return cached.value;
    }

    // Cache miss - load from source
    const value = await loader();

    // Store in cache
    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });

    return value;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidatePattern(pattern: RegExp): void {
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
      }
    }
  }
}
```

### Write-Through for Critical State

```typescript
class WriteThrough<T> {
  private cache: Map<string, T>;
  private storage: Storage;

  async set(key: string, value: T): Promise<void> {
    // Write to storage first (source of truth)
    await this.storage.write(key, value);

    // Then update cache
    this.cache.set(key, value);
  }

  async get(key: string): Promise<T | undefined> {
    // Always check cache first (it's in sync due to write-through)
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    // Cold start - load from storage
    const value = await this.storage.read(key);
    if (value) {
      this.cache.set(key, value);
    }
    return value;
  }
}
```

### Cache Configuration

| Cache Type | Strategy | TTL | Max Size | Invalidation |
|------------|----------|-----|----------|--------------|
| File checksums | Cache-aside | 5 min | 1000 entries | On file write |
| LLM responses | Cache-aside | 10 min | 100 entries | Manual only |
| Tool results | Write-through | Session | 500 entries | On session end |
| Session state | Write-through | Persistent | N/A | Never (explicit save) |
| Glob results | Cache-aside | 30 sec | 200 entries | On any file change |

### File Watcher for Cache Invalidation

```typescript
class CacheInvalidator {
  private watcher: FSWatcher;
  private caches: Map<string, CacheAside<unknown>>;

  constructor(workingDir: string) {
    this.watcher = chokidar.watch(workingDir, {
      ignoreInitial: true,
      ignored: ['node_modules', '.git']
    });

    this.watcher.on('all', (event, path) => {
      this.handleFileChange(event, path);
    });
  }

  private handleFileChange(event: string, filePath: string): void {
    // Invalidate file checksum cache
    this.caches.get('fileChecksums')?.invalidate(filePath);

    // Invalidate glob caches that might include this file
    this.caches.get('globResults')?.invalidatePattern(
      new RegExp(path.dirname(filePath))
    );

    // Invalidate grep results
    this.caches.get('grepResults')?.invalidatePattern(/./);
  }
}
```

## Deep Dive: Session Persistence

### Session Structure

```typescript
interface Session {
  id: string;
  workingDirectory: string;
  startedAt: Date;
  messages: Message[];
  permissions: Permission[];
  settings: SessionSettings;
}

class SessionManager {
  private sessionDir: string;

  constructor() {
    this.sessionDir = path.join(os.homedir(), '.ai-assistant', 'sessions');
  }

  async create(workingDir: string): Promise<Session> {
    const session: Session = {
      id: crypto.randomUUID(),
      workingDirectory: workingDir,
      startedAt: new Date(),
      messages: [],
      permissions: [],
      settings: this.loadDefaultSettings()
    };

    await this.save(session);
    return session;
  }

  async resume(sessionId: string): Promise<Session | null> {
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);

    if (await fs.pathExists(sessionPath)) {
      const data = await fs.readJson(sessionPath);
      return data as Session;
    }

    return null;
  }

  async save(session: Session): Promise<void> {
    const sessionPath = path.join(this.sessionDir, `${session.id}.json`);
    await fs.ensureDir(this.sessionDir);
    await fs.writeJson(sessionPath, session, { spaces: 2 });
  }

  async list(): Promise<SessionSummary[]> {
    const files = await fs.readdir(this.sessionDir);
    const sessions: SessionSummary[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const session = await fs.readJson(path.join(this.sessionDir, file));
        sessions.push({
          id: session.id,
          workingDirectory: session.workingDirectory,
          startedAt: session.startedAt,
          messageCount: session.messages.length
        });
      }
    }

    return sessions.sort((a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }
}
```

### Atomic File Write Pattern

```typescript
class AtomicFileWriter {
  async write(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp.${Date.now()}`;

    try {
      // Write to temp file
      await fs.writeFile(tempPath, content, 'utf-8');

      // Sync to disk before rename
      const fd = await fs.open(tempPath, 'r');
      await fd.sync();
      await fd.close();

      // Atomic rename
      await fs.rename(tempPath, filePath);
    } catch (error) {
      // Clean up temp file on failure
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }
}
```

## Deep Dive: Observability

### Metrics Collection

```typescript
interface Metrics {
  // Counters
  toolExecutionCount: Counter;
  llmApiCalls: Counter;
  permissionDenials: Counter;
  cacheHits: Counter;
  cacheMisses: Counter;
  errors: Counter;

  // Histograms
  toolExecutionDuration: Histogram;
  llmResponseTime: Histogram;
  contextTokenCount: Histogram;

  // Gauges
  activeContextTokens: Gauge;
  cachedEntries: Gauge;
  sessionMessageCount: Gauge;
}

class MetricsCollector {
  private metrics: Map<string, number[]> = new Map();
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();

  // Counter operations
  increment(name: string, labels?: Record<string, string>): void {
    const key = this.labeledKey(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + 1);
  }

  // Histogram operations
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.labeledKey(name, labels);
    const values = this.metrics.get(key) || [];
    values.push(value);
    this.metrics.set(key, values);
  }

  // Gauge operations
  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  // Export in Prometheus format
  toPrometheusFormat(): string {
    const lines: string[] = [];

    for (const [key, value] of this.counters) {
      lines.push(`${key}_total ${value}`);
    }

    for (const [key, value] of this.gauges) {
      lines.push(`${key} ${value}`);
    }

    return lines.join('\n');
  }
}
```

### Key Metrics and SLIs

| Metric | Type | Description | Alert Threshold |
|--------|------|-------------|-----------------|
| `tool_execution_duration_seconds` | Histogram | Time to execute each tool | p99 > 30s |
| `llm_response_time_seconds` | Histogram | LLM API latency | p95 > 10s |
| `llm_api_errors_total` | Counter | Failed LLM API calls | > 5/minute |
| `tool_execution_errors_total` | Counter | Failed tool executions | > 10/minute |
| `context_tokens_used` | Gauge | Current context window usage | > 90% capacity |
| `cache_hit_ratio` | Gauge | Cache effectiveness | < 50% |

### Structured Logging

```typescript
interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context: {
    sessionId?: string;
    toolName?: string;
    traceId?: string;
    spanId?: string;
  };
  metadata?: Record<string, unknown>;
}

class StructuredLogger {
  private logFile: WriteStream;
  private level: LogLevel;

  log(level: LogLevel, message: string, context?: Partial<LogEntry['context']>): void {
    if (this.shouldLog(level)) {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        context: {
          sessionId: this.currentSessionId,
          traceId: this.currentTraceId,
          ...context
        }
      };

      // Console output (human-readable)
      this.writeConsole(entry);

      // File output (JSON for parsing)
      this.writeFile(entry);
    }
  }
}
```

### Alert Rules

```yaml
groups:
  - name: evylcode-alerts
    rules:
      - alert: HighLLMLatency
        expr: histogram_quantile(0.95, rate(llm_response_time_seconds_bucket[5m])) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "LLM API response time is high"
          description: "p95 latency is {{ $value }}s (threshold: 10s)"

      - alert: LLMAPIErrors
        expr: rate(llm_api_errors_total[5m]) > 0.1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "LLM API errors detected"
          description: "Error rate: {{ $value }}/s"

      - alert: ContextWindowNearLimit
        expr: context_tokens_used / context_tokens_max > 0.9
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Context window nearly full"
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| LLM provider abstraction | Flexibility, vendor independence | Additional complexity, lowest-common-denominator features |
| Cache-aside for files | Simple, tolerates cache misses | Stale data possible within TTL |
| Write-through for sessions | Consistency, durability | Higher write latency |
| Idempotent tool execution | Reliable retry, replay capability | Memory/storage overhead for cache |
| Atomic file writes | Prevents corruption | Requires temp files, slight overhead |
| Summarization compression | Preserves context intent | Information loss, LLM cost |

## Future Backend Enhancements

1. **Redis Caching**: Shared cache for multi-instance deployments
2. **Vector Embeddings**: Semantic search over session history
3. **Background Summarization**: Async context compression
4. **Rate Limiting**: Per-user/per-model quotas
5. **Audit Logging**: Compliance and security tracking
6. **Model Routing**: Use cheaper models for simple tasks
7. **MCP Server Mode**: Expose tools via Model Context Protocol
