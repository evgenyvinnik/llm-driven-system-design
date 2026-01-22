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

---

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

---

## Deep Dive: LLM Provider Abstraction

### Provider Interface Design

"I would design a provider abstraction layer that normalizes the differences between LLM APIs. Each provider implements a common interface with methods for streaming completion, token counting, and tool formatting."

```
┌─────────────────────────────────────────────────────────────────┐
│                      LLM Provider Layer                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────┐                                             │
│  │  LLMProvider   │◀──── Interface                              │
│  │   Interface    │                                             │
│  ├────────────────┤                                             │
│  │ complete()     │                                             │
│  │ stream()       │                                             │
│  │ countTokens()  │                                             │
│  └───────┬────────┘                                             │
│          │                                                       │
│          ├──────────────────┬──────────────────┐                │
│          ▼                  ▼                  ▼                │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐        │
│  │  Anthropic   │   │   OpenAI     │   │    Local     │        │
│  │   Provider   │   │   Provider   │   │   Provider   │        │
│  └──────────────┘   └──────────────┘   └──────────────┘        │
│          │                  │                  │                 │
│          ▼                  ▼                  ▼                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐        │
│  │ Claude API   │   │ GPT-4 API    │   │ Ollama/LMStudio       │
│  └──────────────┘   └──────────────┘   └──────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key Provider Responsibilities:**
- **complete()**: Non-streaming completion returning full response
- **stream()**: Async iterable yielding text chunks and tool calls
- **countTokens()**: Estimate token count for context budgeting
- **formatMessages()**: Convert internal format to provider-specific format
- **formatTools()**: Convert tool definitions to provider schema

### Retry Configuration

| Config Parameter | Value | Rationale |
|-----------------|-------|-----------|
| maxRetries | 3 | Balance reliability vs latency |
| initialDelayMs | 1000 | Allow transient issues to resolve |
| maxDelayMs | 10000 | Cap wait time for user experience |
| backoffMultiplier | 2 | Exponential backoff for rate limits |
| retryableErrors | rate_limit, overloaded, timeout | Only retry recoverable errors |

---

## Deep Dive: Context Window Management

### The Problem

"LLM context windows are large but finite (128K-200K tokens). Long coding sessions easily exceed limits, and tool outputs like file contents can be huge. We need a multi-strategy approach to stay within budget while preserving conversation intent."

### Token Budgeting

```
┌─────────────────────────────────────────────────────────────────┐
│                 Token Budget (128K Total)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ System Prompt                                    2K tokens │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Tool Definitions                                 5K tokens │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Context Summary (compressed history)            10K tokens │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Recent Messages (last 10 turns)                 30K tokens │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ File Cache (recently read files)                40K tokens │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Response Buffer (for LLM output)                40K tokens │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Compression Strategies

```
┌─────────────────────────────────────────────────────────────────┐
│                   Context Compression Flow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐                                               │
│  │ New Message  │                                               │
│  └──────┬───────┘                                               │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐    No     ┌──────────────┐                   │
│  │ Over 90%     │──────────▶│ Add Message  │                   │
│  │ Capacity?    │           │ to Context   │                   │
│  └──────┬───────┘           └──────────────┘                   │
│         │ Yes                                                    │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                 Compression Pipeline                      │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │ 1. Summarize old messages ──▶ Keep last 10 turns         │  │
│  │ 2. Truncate large tool outputs ──▶ Head + tail only      │  │
│  │ 3. Remove duplicate file reads ──▶ Keep latest version   │  │
│  │ 4. Compress file diffs ──▶ Summary of changes            │  │
│  └──────────────────────────────────────────────────────────┘  │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐                                               │
│  │ Add Message  │                                               │
│  └──────────────┘                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Strategy Details:**
1. **Summarization**: Use LLM to compress old conversation into a summary
2. **Truncation**: Keep first 5K + last 2K chars of large tool outputs
3. **Selective Retention**: Always preserve system prompt and recent turns
4. **Rolling Window**: Fixed number of recent messages (typically 10)

---

## Deep Dive: Tool Execution and Idempotency

### Tool System Architecture

"Each tool receives a unique ID from the LLM. This enables idempotent execution - if we retry a request, we can return cached results instead of re-executing potentially destructive operations."

```
┌─────────────────────────────────────────────────────────────────┐
│                      Tool Execution Flow                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐                                               │
│  │  Tool Call   │                                               │
│  │  from LLM    │                                               │
│  └──────┬───────┘                                               │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐    Yes    ┌──────────────┐                   │
│  │ In Cache?    │──────────▶│ Return       │                   │
│  │ (by call ID) │           │ Cached Result│                   │
│  └──────┬───────┘           └──────────────┘                   │
│         │ No                                                     │
│         ▼                                                        │
│  ┌──────────────┐    Denied  ┌──────────────┐                  │
│  │ Check        │───────────▶│ Return Error │                  │
│  │ Permissions  │            │ "Not Allowed"│                  │
│  └──────┬───────┘            └──────────────┘                  │
│         │ Granted                                                │
│         ▼                                                        │
│  ┌──────────────┐                                               │
│  │ Execute Tool │                                               │
│  └──────┬───────┘                                               │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐                                               │
│  │ Cache Result │                                               │
│  │ Persist      │                                               │
│  └──────┬───────┘                                               │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐                                               │
│  │ Return Result│                                               │
│  └──────────────┘                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### File Edit Conflict Resolution

```
┌─────────────────────────────────────────────────────────────────┐
│                   Edit Conflict Detection                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐                                               │
│  │ Edit Request │                                               │
│  │ old_string   │                                               │
│  │ new_string   │                                               │
│  │ checksum     │                                               │
│  └──────┬───────┘                                               │
│         │                                                        │
│         ▼                                                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 1. Read current file content                               │ │
│  │ 2. Compute current checksum (SHA256)                       │ │
│  │ 3. Compare with expected checksum                          │ │
│  └────────────────────────────────────────────────────────────┘ │
│         │                                                        │
│    ┌────┴────┐                                                   │
│    ▼         ▼                                                   │
│  Match    Mismatch ──▶ "File modified since last read"         │
│    │                                                             │
│    ▼                                                             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Count occurrences of old_string                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│         │                                                        │
│    ┌────┼────────┐                                               │
│    ▼    ▼        ▼                                               │
│   0     1       >1                                               │
│   │     │        │                                               │
│   ▼     ▼        ▼                                               │
│ "Not  Apply   "Ambiguous:                                       │
│ found" edit    use more context                                 │
│                or replace_all"                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Retry Semantics

| Operation | Retry Behavior | Notes |
|-----------|---------------|-------|
| File Read | Safe to retry | Always returns current state |
| File Write | Idempotent via checksum | Same content = no-op |
| File Edit | Conflict detection | Fails if file changed |
| Bash Command | Not automatically retried | User must approve re-execution |
| LLM API Call | Automatic retry with backoff | 3 attempts, exponential delay |

---

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
│  │  - File content checksums (5 min TTL)                    │  │
│  │  - LLM response cache for identical prompts (10 min)     │  │
│  │  - Tool execution results by idempotency key             │  │
│  │  - Session state (persisted on change)                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Cache Patterns

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cache-Aside Pattern                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application ──▶ Cache ──▶ Hit? ──▶ Yes ──▶ Return cached      │
│                              │                                   │
│                              ▼ No                                │
│                           Load from source                       │
│                              │                                   │
│                              ▼                                   │
│                           Store in cache                         │
│                              │                                   │
│                              ▼                                   │
│                           Return value                           │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                   Write-Through Pattern                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application ──▶ Write to storage (source of truth)             │
│                              │                                   │
│                              ▼                                   │
│                           Update cache                           │
│                              │                                   │
│                              ▼                                   │
│                           Return success                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Cache Configuration

| Cache Type | Strategy | TTL | Max Size | Invalidation |
|------------|----------|-----|----------|--------------|
| File checksums | Cache-aside | 5 min | 1000 entries | On file write |
| LLM responses | Cache-aside | 10 min | 100 entries | Manual only |
| Tool results | Write-through | Session | 500 entries | On session end |
| Session state | Write-through | Persistent | N/A | Never (explicit save) |
| Glob results | Cache-aside | 30 sec | 200 entries | On any file change |

### File Watcher Integration

```
┌─────────────────────────────────────────────────────────────────┐
│                   Cache Invalidation Flow                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐                                               │
│  │ File System  │                                               │
│  │   Watcher    │                                               │
│  └──────┬───────┘                                               │
│         │ File changed event                                     │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Invalidation Dispatcher                      │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │ 1. Invalidate file checksum cache ──▶ exact path        │  │
│  │ 2. Invalidate glob caches ──▶ matching directories       │  │
│  │ 3. Invalidate grep results ──▶ all (content changed)     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Ignored paths: node_modules, .git                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Session Persistence

### Session Data Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                      Session Structure                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Session                                                         │
│  ├── id: UUID                                                   │
│  ├── workingDirectory: string                                   │
│  ├── startedAt: Date                                            │
│  ├── messages: Message[]                                        │
│  │   ├── role: "user" | "assistant" | "tool"                   │
│  │   ├── content: string                                        │
│  │   └── toolCalls?: ToolCall[]                                │
│  ├── permissions: Permission[]                                  │
│  │   ├── pattern: string                                        │
│  │   ├── action: "allow" | "deny"                              │
│  │   └── scope: "session" | "always"                           │
│  └── settings: SessionSettings                                  │
│      ├── model: string                                          │
│      ├── maxTokens: number                                      │
│      └── temperature: number                                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Atomic File Write Pattern

"Session data must survive crashes. I use the atomic write pattern: write to temp file, sync to disk, then rename. This ensures we never have partial writes."

```
┌─────────────────────────────────────────────────────────────────┐
│                    Atomic Write Flow                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐                                               │
│  │ Write Data   │                                               │
│  └──────┬───────┘                                               │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 1. Create temp file: session.json.tmp.{timestamp}        │  │
│  └──────────────────────────────────────────────────────────┘  │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 2. Write content to temp file                            │  │
│  └──────────────────────────────────────────────────────────┘  │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 3. fsync() - ensure data is on disk                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 4. Atomic rename: temp → session.json                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│         │                                                        │
│    ┌────┴────┐                                                   │
│    ▼         ▼                                                   │
│ Success   Failure                                                │
│    │         │                                                   │
│    ▼         ▼                                                   │
│  Done     Cleanup temp file                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Session Storage Location

Sessions are stored in the user's home directory under `.ai-assistant/sessions/`:
- Each session is a JSON file named by UUID
- Sessions can be listed, resumed, or deleted
- Automatic cleanup of sessions older than 30 days (configurable)

---

## Deep Dive: Observability

### Metrics Categories

```
┌─────────────────────────────────────────────────────────────────┐
│                       Metrics System                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Counters                                                        │
│  ├── tool_execution_count{tool, status}                        │
│  ├── llm_api_calls{provider, model}                            │
│  ├── permission_denials{tool, pattern}                         │
│  ├── cache_hits{cache_type}                                    │
│  ├── cache_misses{cache_type}                                  │
│  └── errors{type, source}                                       │
│                                                                  │
│  Histograms                                                      │
│  ├── tool_execution_duration_seconds{tool}                     │
│  ├── llm_response_time_seconds{provider}                       │
│  └── context_token_count{phase}                                │
│                                                                  │
│  Gauges                                                          │
│  ├── active_context_tokens                                      │
│  ├── cached_entries{cache_type}                                │
│  └── session_message_count                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
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

```
┌─────────────────────────────────────────────────────────────────┐
│                      Log Entry Structure                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  LogEntry                                                        │
│  ├── timestamp: ISO 8601                                        │
│  ├── level: debug | info | warn | error                        │
│  ├── message: string                                            │
│  ├── context                                                    │
│  │   ├── sessionId: UUID                                       │
│  │   ├── toolName: string (optional)                           │
│  │   ├── traceId: UUID (for request correlation)              │
│  │   └── spanId: UUID (for operation tracking)                │
│  └── metadata: key-value pairs                                  │
│                                                                  │
│  Output Destinations                                             │
│  ├── Console: Human-readable colored output                    │
│  └── File: JSON lines for parsing and aggregation              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Alert Rules Summary

| Alert | Condition | Severity |
|-------|-----------|----------|
| HighLLMLatency | p95 latency > 10s for 5m | Warning |
| LLMAPIErrors | Error rate > 0.1/s for 2m | Critical |
| ContextWindowNearLimit | Usage > 90% for 1m | Warning |

---

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| LLM provider abstraction | Flexibility, vendor independence | Additional complexity, lowest-common-denominator features |
| Cache-aside for files | Simple, tolerates cache misses | Stale data possible within TTL |
| Write-through for sessions | Consistency, durability | Higher write latency |
| Idempotent tool execution | Reliable retry, replay capability | Memory/storage overhead for cache |
| Atomic file writes | Prevents corruption | Requires temp files, slight overhead |
| Summarization compression | Preserves context intent | Information loss, LLM cost |

---

## Future Backend Enhancements

1. **Redis Caching**: Shared cache for multi-instance deployments
2. **Vector Embeddings**: Semantic search over session history
3. **Background Summarization**: Async context compression
4. **Rate Limiting**: Per-user/per-model quotas
5. **Audit Logging**: Compliance and security tracking
6. **Model Routing**: Use cheaper models for simple tasks
7. **MCP Server Mode**: Expose tools via Model Context Protocol
