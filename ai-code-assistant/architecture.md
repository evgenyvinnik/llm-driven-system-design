# AI Code Assistant - Architecture

## System Overview

An AI-powered command-line interface that helps developers write, debug, and understand code through natural language interaction. The system orchestrates LLM capabilities with local file system and shell access to provide an intelligent coding assistant. Core challenges involve agentic loop design, tool orchestration, context window management, and safe code execution.

**Learning Goals:**
- Design agentic loop architecture with tool use
- Implement permission and safety systems for file/shell access
- Build streaming terminal interfaces
- Abstract across multiple LLM providers
- Handle context window management and summarization

---

## Requirements

### Functional Requirements

1. **Converse**: Natural language interaction for code tasks (write, debug, explain, refactor)
2. **Tool Use**: Read/write files, search codebases, execute shell commands
3. **Permissions**: Layered safety system controlling file and command access
4. **Sessions**: Persist conversation history across CLI invocations
5. **Streaming**: Real-time display of LLM responses as tokens arrive
6. **Multi-Provider**: Support Anthropic, OpenAI, and local LLM backends

### Non-Functional Requirements

- **Latency**: First token within 1 second of sending request (streaming)
- **Safety**: Never execute destructive commands without explicit approval
- **Context**: Efficient use of 128K-200K token context windows
- **Portability**: Run on macOS, Linux, Windows via Node.js
- **Offline**: Demo mode with mock LLM for testing without API keys
- **Extensibility**: Plugin system for custom tools and MCP server integration

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        AI Code Assistant (CLI)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐             │
│  │     CLI      │───▶│    Agent     │───▶│   LLM API    │             │
│  │   Interface  │    │  Controller  │    │   Provider   │             │
│  │              │    │              │    │              │             │
│  │  - Prompt    │    │  - Agentic   │    │  - Anthropic │             │
│  │  - Stream    │    │    loop      │    │  - OpenAI    │             │
│  │  - Confirm   │    │  - Tool      │    │  - Mock      │             │
│  │  - Spinner   │    │    dispatch  │    │  - Local     │             │
│  └──────────────┘    └──────────────┘    └──────────────┘             │
│         │                   │                    │                      │
│         │                   ▼                    │                      │
│         │           ┌──────────────┐             │                      │
│         │           │    Tool      │             │                      │
│         │           │   Registry   │             │                      │
│         │           └──────────────┘             │                      │
│         │                   │                    │                      │
│         │     ┌──────┬──────┼──────┬──────┐     │                      │
│         │     ▼      ▼      ▼      ▼      ▼     │                      │
│         │  ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐                   │
│         │  │ Read ││ Edit ││ Bash ││ Glob ││ Grep │                   │
│         │  │ Tool ││ Tool ││ Tool ││ Tool ││ Tool │                   │
│         │  └──────┘└──────┘└──────┘└──────┘└──────┘                   │
│         │     │      │      │      │      │                            │
│         ▼     ▼      ▼      ▼      ▼      ▼                           │
│  ┌────────────────────────────────────────────────────┐               │
│  │              Permission & Safety Layer              │               │
│  │  - Blocked patterns (.env, .ssh, rm -rf /)         │               │
│  │  - Auto-approve (reads), session-approve (writes)  │               │
│  │  - Always-ask (arbitrary commands)                 │               │
│  └────────────────────────────────────────────────────┘               │
│         │             │             │                                   │
│         ▼             ▼             ▼                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                             │
│  │   File   │  │  Shell   │  │ Session  │                             │
│  │  System  │  │ Sandbox  │  │  Store   │                             │
│  └──────────┘  └──────────┘  └──────────┘                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Agent Controller (Agentic Loop)

The heart of the system: an iterative loop that coordinates between user, LLM, and tools.

**Loop mechanics:**
1. User types a natural language request
2. Agent builds message array (system prompt + conversation history) and sends to LLM
3. LLM streams text response and optionally requests tool calls
4. If no tool calls: loop ends, display final response
5. If tool calls present: execute tools (with permission checks), append results to context, return to step 2
6. Safety limit: max 10 iterations per request to prevent infinite loops

**Key design decisions:**
- **Single-threaded loop**: Predictable execution order; no race conditions between tool calls
- **Streaming-first**: Text tokens display in real-time as the LLM generates them, so users see progress immediately
- **Parallel safe tools**: Auto-approved tools (Read, Glob, Grep) execute concurrently via `Promise.all`; approval-required tools (Write, Edit, Bash) execute sequentially with user confirmation
- **Context prepend**: System prompt is prepended to every LLM call, not stored in message history

### 2. Tool System

Six core tools covering file system and shell operations:

| Tool | Description | Approval | Key Detail |
|------|-------------|----------|------------|
| **Read** | Read file contents with optional offset/limit | Auto-approve | Line numbers in output (`cat -n` style) |
| **Write** | Create new files | Requires approval | Full file content as parameter |
| **Edit** | String replacement in files | Requires approval | `old_string` must be unique unless `replace_all` is set |
| **Bash** | Execute shell commands | Pattern-based | Safe patterns auto-approved (git status, npm test); dangerous commands always blocked |
| **Glob** | Find files by pattern | Auto-approve | Uses `glob` library, returns matching paths |
| **Grep** | Search file contents | Auto-approve | Regex support with line context |

**Edit tool design**: Uses string replacement rather than line numbers. Line numbers change as files are edited, making them unreliable for multi-step edits. String matching forces the LLM to provide enough surrounding context for unique matches. If the string appears multiple times, the tool returns an error suggesting `replace_all` or more context.

**Bash tool safety**: Commands are validated against a blocklist before execution:
- **Always blocked**: `rm -rf /`, `sudo`, `chmod 777`, fork bombs, `curl | sh`
- **Pattern-blocked**: Recursive delete from root/home, block device writes, `mkfs`, `dd`
- **Auto-approved**: `ls`, `pwd`, `cat`, `git status/log/diff`, `npm run dev/build/test/lint`
- **Requires approval**: Everything else

### 3. Permission System

Four-tier permission model:

| Level | Description | Examples | Persistence |
|-------|-------------|----------|-------------|
| **Auto-approve** | Always allowed without asking | File reads, safe shell commands | Built-in |
| **Session-approve** | Ask once, remember for session | File writes to working directory | Session lifetime |
| **Always-ask** | Prompt every time | Arbitrary shell commands | Per-invocation |
| **Never-allow** | Permanently blocked | `.env` files, `.ssh/`, credentials, `rm -rf /` | Built-in |

Permissions use glob pattern matching: granting write access to `/project/**/*` covers all files in the project directory. The permission manager maintains both a grant list and a denial set; previously denied operations are not re-prompted.

### 4. Context Window Management

With 128K-200K token context windows, efficient context management is critical for long coding sessions:

**Compression strategies (applied when context reaches 90% capacity):**

1. **Summarization**: Older messages (all except the last 10) are compressed into a summary by the LLM. The summary replaces the original messages, preserving key decisions and context while reducing tokens.
2. **Tool output truncation**: Tool results longer than 10K characters are truncated to first 5K + last 2K characters with a `[truncated]` marker. This preserves the beginning (usually the most relevant) and end (often error messages).
3. **Selective retention**: System prompt + last 10 messages are always preserved in full. Older content gets progressively summarized.
4. **Rolling window**: As a last resort, the oldest messages are dropped entirely, keeping only the most recent turns.

### 5. LLM Provider Abstraction

A common interface abstracts across LLM backends:

**Provider interface:**
- `complete(request)` -- Synchronous completion returning full response
- `stream(request)` -- Async iterator yielding text chunks and tool call events
- `countTokens(text)` -- Approximate token count for context management

**Implemented providers:**
- **AnthropicProvider**: Real Claude API integration with streaming, tool use, model selection (Sonnet, Opus)
- **MockProvider**: Pattern-based intent detection for demo/testing without API keys

**Message format translation**: Each provider translates the internal `Message[]` format to its API's expected format (Anthropic uses `role: 'user'/'assistant'` with content blocks; OpenAI uses `role: 'user'/'assistant'/'tool'` with function calls).

### 6. Session Management

Sessions persist conversation history and permissions to disk:

- **Storage**: JSON files in `~/.ai-assistant/sessions/{sessionId}.json`
- **Create**: New session on each CLI invocation (or resume with `--resume`)
- **Resume**: Load conversation history and re-establish context
- **List**: Show all saved sessions with message count and working directory

---

## Data Flow

### Agentic Loop Sequence

```
┌──────┐          ┌───────┐          ┌─────┐          ┌───────┐
│ User │          │ Agent │          │ LLM │          │ Tools │
└──┬───┘          └───┬───┘          └──┬──┘          └───┬───┘
   │                  │                 │                 │
   │  "Fix auth bug"  │                 │                 │
   │─────────────────▶│                 │                 │
   │                  │                 │                 │
   │                  │  messages[]     │                 │
   │                  │────────────────▶│                 │
   │                  │                 │                 │
   │                  │  [Read auth.ts] │                 │
   │                  │◀────────────────│                 │
   │                  │                 │                 │
   │                  │                 │  Read auth.ts   │
   │                  │────────────────────────────────▶│
   │                  │                 │                 │
   │                  │                 │  file contents  │
   │                  │◀────────────────────────────────│
   │                  │                 │                 │
   │                  │  messages[] +   │                 │
   │                  │  tool result    │                 │
   │                  │────────────────▶│                 │
   │                  │                 │                 │
   │                  │  [Edit auth.ts] │                 │
   │                  │◀────────────────│                 │
   │                  │                 │                 │
   │  Approve edit?   │                 │                 │
   │◀─────────────────│                 │                 │
   │                  │                 │                 │
   │  Yes             │                 │                 │
   │─────────────────▶│                 │                 │
   │                  │                 │  Edit file      │
   │                  │────────────────────────────────▶│
   │                  │                 │                 │
   │                  │                 │  success        │
   │                  │◀────────────────────────────────│
   │                  │                 │                 │
   │                  │  messages[] +   │                 │
   │                  │  edit result    │                 │
   │                  │────────────────▶│                 │
   │                  │                 │                 │
   │                  │  "Fixed the bug"│                 │
   │◀─────────────────│◀────────────────│                 │
   │                  │                 │                 │
```

---

## API Design

### CLI Arguments

| Flag | Description | Default |
|------|-------------|---------|
| `-d, --directory <path>` | Working directory | Current directory |
| `-k, --api-key <key>` | Anthropic API key | `$ANTHROPIC_API_KEY` |
| `-m, --model <model>` | Claude model | `claude-sonnet-4-20250514` |
| `-r, --resume <id>` | Resume session | None |
| `--demo` | Mock LLM mode | Off |
| `--list-sessions` | List saved sessions | N/A |

### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/session` | Show current session info |
| `/sessions` | List saved sessions |
| `/tools` | List available tools |
| `/exit` | Save session and exit |

### Tool Definition Schema

Each tool is defined with a JSON Schema for parameter validation, consumed by the LLM to understand available capabilities:

```
Tool {
  name: string           -- Tool identifier (e.g., "Read", "Edit")
  description: string    -- What the tool does (sent to LLM)
  parameters: JSONSchema -- Input schema for validation
  requiresApproval: bool | (params) => bool  -- Permission check
  execute(params, context) => ToolResult     -- Implementation
}
```

---

## Key Design Decisions

### 1. String Replacement vs. Line-Number Editing

**Chosen**: String replacement (`old_string` -> `new_string`).

Line numbers change after every edit, making them unreliable for multi-step modifications. If the LLM reads a file, edits line 15, then tries to edit line 30, the target has shifted because the prior edit changed line counts. String replacement forces the LLM to specify enough context for a unique match, which is inherently stable across edits. The trade-off: if `old_string` appears multiple times, the edit fails and requires more context or `replace_all`. In practice, providing 2-3 lines of surrounding code is almost always sufficient for uniqueness.

### 2. Layered Permissions vs. Blanket Allow/Deny

**Chosen**: Four-tier permission system (auto, session, always-ask, never).

A blanket "allow all" approach is dangerous -- one hallucinated `rm -rf` could destroy a project. A blanket "ask every time" approach is unusable -- reading 50 files during code exploration would require 50 approvals. The layered system matches risk to control: reads are always safe, writes to the working directory need one-time approval, and shell commands are scrutinized individually. The trade-off is implementation complexity: the permission manager needs glob matching, denial tracking, and different persistence scopes.

### 3. Mock Provider for Demo Mode

**Chosen**: Built-in mock LLM provider with pattern-based intent detection.

Testing the full agentic loop (tool calls, permissions, session persistence) without an API key is essential for development and demonstration. The mock provider detects intent from keywords ("read" -> Read tool, "edit" -> Edit tool) and generates plausible responses. The trade-off is maintenance: the mock must be updated when new tools or behaviors are added, and it cannot replicate the nuance of real LLM reasoning.

---

## Consistency and Idempotency

### Consistency Model

| Operation | Model | Rationale |
|-----------|-------|-----------|
| Session state | Strong | All writes (messages, permissions) are synchronous and immediately visible |
| File edits | Atomic (write-then-rename) | Prevents partial writes from corrupting files |
| Permission grants | Immediate | Once approved, permission is enforced on next check |
| Context summarization | Eventual | Background compression of old messages can lag |

### Idempotency Handling

- **Tool calls**: Each tool call has a unique ID from the LLM. On retry, cached results are returned instead of re-executing.
- **File edits**: Conflict detection via content comparison. If a file changed since it was last read, the edit fails with a suggestion to re-read.
- **LLM API calls**: Automatic retry with exponential backoff (3 attempts, 1s/2s/4s delays) for rate limits, overload, and timeouts.

### Retry Semantics

| Operation | Retry Behavior | Notes |
|-----------|---------------|-------|
| File Read | Safe to retry | Always returns current state |
| File Write | Idempotent (same content = no-op) | Content-based comparison |
| File Edit | Conflict detection | Fails if file changed since last read |
| Bash Command | Not automatically retried | User must approve re-execution |
| LLM API Call | Auto-retry with backoff | 3 attempts for transient errors |

---

## Security

### File System Guards

- **Scope restriction**: All file operations scoped to working directory by default
- **Blocked patterns**: `.env`, `.ssh/`, `credentials`, `secrets`, `.git/config` (regex-matched)
- **Path traversal prevention**: All paths resolved to absolute before access check

### Command Sandbox

- **Explicit blocklist**: Fork bombs, `curl | sh`, `sudo`, write to block devices
- **Pattern blocklist**: `rm -rf` from root/home, `mkfs`, `dd if=`
- **Timeout**: Default 120 seconds, configurable per command
- **Output limit**: 10 MB max buffer to prevent memory exhaustion

---

## Observability

### Metrics (In-Memory)

| Metric | Type | Purpose |
|--------|------|---------|
| `tool_execution_duration` | Histogram | Track tool performance (p50/p95/p99) |
| `llm_response_time` | Histogram | LLM API latency monitoring |
| `tool_execution_count` | Counter | Tool usage frequency by tool name |
| `llm_api_errors` | Counter | Failed API calls for reliability tracking |
| `context_tokens_used` | Gauge | Context window utilization |
| `cache_hit_ratio` | Gauge | Cache effectiveness |
| `permission_denials` | Counter | Security audit trail |

### Structured Logging

- JSON-formatted log entries with session ID, tool name, trace ID
- Console output: human-readable with color coding
- File output (optional): JSON for parsing by log aggregation tools
- Audit logging: All permission grants/denials and file writes logged to append-only audit file

### Distributed Tracing

For multi-tool operations, span-based tracing tracks the flow:
- Parent span: `agent.run` (entire user request)
- Child spans: `agent.executeTool` (each tool call with duration and status)
- Trace ID propagated through all log entries for correlation

---

## Caching Strategy

### Cache Layers

| Cache | Strategy | TTL | Invalidation |
|-------|----------|-----|--------------|
| File checksums | Cache-aside (LRU) | 5 min | On file write/edit |
| LLM responses | Cache-aside (LRU) | 10 min | Manual only |
| Tool execution results | Write-through | Session | On session end |
| Session state | Write-through | Persistent | Explicit save |
| Glob results | Cache-aside (LRU) | 30 sec | On any file change |
| Grep results | Cache-aside (LRU) | 1 min | On file write/edit |

Local implementation uses in-memory LRU cache. Production extension would add Redis for shared caching across multiple instances.

---

## Failure Handling

| Failure | Strategy | Recovery |
|---------|----------|----------|
| LLM API timeout | Retry 3x with exponential backoff | Show error after exhausting retries |
| LLM rate limit (429) | Backoff with jitter | Auto-retry, respecting Retry-After header |
| Tool execution error | Report error to LLM as tool result | LLM adjusts approach based on error |
| Context overflow | Force compression (summarize + truncate) | Retry with reduced context |
| Permission denied | Report to LLM | LLM skips operation and explains why |
| File not found | Return error as tool result | LLM uses Glob to find correct path |
| Invalid edit (non-unique) | Return error with occurrence count | LLM provides more context |
| Session save failure | Log warning, continue | Session recoverable from memory |

---

## Extensibility

### Plugin System (Designed)

Plugins can contribute tools, hooks (onSessionStart, onBeforeToolCall, onAfterToolCall, onMessage), and slash commands. The plugin interface allows third-party extensions without modifying core code.

### MCP (Model Context Protocol) Support (Designed)

MCP servers provide additional tools via stdio or HTTP transport. Tools from MCP servers are namespaced (`server:toolName`) to avoid collisions. The MCP client manages connections and translates between the internal tool interface and MCP protocol.

---

## Scalability Considerations

As a single-user CLI tool, traditional horizontal scaling does not apply. Scaling considerations focus on:

1. **Context window limits**: At 128K tokens, long coding sessions hit the limit after ~30 tool calls with large file contents. Summarization and truncation extend effective session length.
2. **File system scale**: Large monorepos (100K+ files) make Glob and Grep slow. Future optimization: file watcher for incremental indexing, ignore patterns for node_modules/.git.
3. **Multi-provider load**: For cloud deployments of the assistant, load balance across providers (Anthropic, OpenAI) based on availability and rate limits.
4. **Concurrent tool execution**: Currently limited to safe-tool parallelism. Future: dependency graph for optimal parallel execution order.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| File editing | String replacement | Line-number based | Stable across multi-step edits; line numbers shift |
| Permissions | Four-tier layered system | Blanket allow/deny | Matches risk to control level |
| CLI framework | Custom (readline + chalk) | Ink (React for CLI) | Full control over streaming UX |
| Demo mode | Mock LLM provider | Always require API key | Enables testing and demos without cost |
| Session storage | JSON files | SQLite / Redis | Simple, portable, no dependencies |
| LLM default | Claude Sonnet | GPT-4, local models | Best balance of speed, capability, and cost |
| Streaming | Token-by-token display | Wait for complete response | Better UX -- users see progress immediately |

---

## Implementation Notes

This project is a **standalone CLI application** (not client-server). There is no backend service, database, or Docker infrastructure.

### Local Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    evylcode CLI Process                       │
│                                                              │
│  ┌────────────────┐                                         │
│  │  index.ts      │  Entry point, CLI arg parsing           │
│  │  (Commander)   │  --api-key, --model, --demo, --resume   │
│  └───────┬────────┘                                         │
│          │                                                   │
│          ▼                                                   │
│  ┌────────────────┐    ┌────────────────┐                   │
│  │ CLIInterface   │───▶│ AgentController│                   │
│  │ (chalk, ora,   │    │ (agentic loop) │                   │
│  │  readline)     │    └───────┬────────┘                   │
│  └────────────────┘            │                             │
│                                ▼                             │
│               ┌────────────────────────────┐                │
│               │      ToolRegistry          │                │
│               │  Read │ Write │ Edit │     │                │
│               │  Bash │ Glob  │ Grep │     │                │
│               └───────────┬────────────┘                    │
│                           │                                  │
│          ┌────────────────┼───────────────┐                 │
│          ▼                ▼               ▼                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │ Permission   │ │ Session      │ │ LLM Provider │       │
│  │ Manager      │ │ Manager      │ │ (Anthropic/  │       │
│  │              │ │ (~/.ai-      │ │  Mock)       │       │
│  │ Blocked      │ │ assistant/   │ │              │       │
│  │ patterns,    │ │ sessions/)   │ │ Streaming,   │       │
│  │ grants,      │ │              │ │ tool use     │       │
│  │ denials      │ │ JSON files   │ │              │       │
│  └──────────────┘ └──────────────┘ └──────────────┘       │
│                                          │                   │
│                                          ▼                   │
│                                  Anthropic API               │
│                                  (api.anthropic.com)         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Source File Map

| Module | Files | Responsibility |
|--------|-------|---------------|
| Entry point | `src/index.ts` | CLI argument parsing (Commander), provider selection, session init, REPL loop |
| CLI | `src/cli/interface.ts` | Terminal I/O: prompt, streaming output, spinners (ora), colors (chalk), welcome/goodbye banners |
| Agent | `src/agent/controller.ts` | Agentic loop, tool dispatch, permission-aware execution, context management |
| Tools | `src/tools/read.ts`, `write.ts`, `edit.ts`, `bash.ts`, `glob.ts`, `grep.ts`, `index.ts` | Six core tools with parameter validation and execution |
| LLM | `src/llm/anthropic-provider.ts`, `mock-provider.ts`, `index.ts` | Anthropic SDK integration (streaming, tool use), mock provider for demo mode |
| Permissions | `src/permissions/manager.ts` | Four-tier permission checking, glob pattern matching, blocked patterns |
| Session | `src/session/manager.ts` | JSON file persistence in `~/.ai-assistant/sessions/` |
| Types | `src/types/index.ts` | All interfaces: Message, ToolCall, ToolResult, Permission, Session, LLMProvider, etc. |

### Production-Grade Patterns Actually Implemented

1. **Agentic loop with tool use** -- Full implementation of the LLM -> tool call -> result -> LLM cycle with max-iteration safety limit (`src/agent/controller.ts`)
2. **Streaming responses** -- Real-time token display using Anthropic SDK's streaming API (`src/llm/anthropic-provider.ts`)
3. **Permission system** -- Blocked patterns, auto-approve for reads, approval prompts for writes/commands (`src/permissions/manager.ts`)
4. **Session persistence** -- JSON-based session save/resume with conversation history (`src/session/manager.ts`)
5. **String-based file editing** -- Unique string matching with `replace_all` fallback (`src/tools/edit.ts`)
6. **Command safety** -- Blocklist and safe-pattern matching for shell commands (`src/tools/bash.ts`)
7. **Multi-provider abstraction** -- Common interface for Anthropic and Mock providers (`src/types/index.ts`, `src/llm/`)

### Simplifications vs. Production

| Area | Production | Local Implementation |
|------|-----------|---------------------|
| Context management | Summarization with LLM + truncation + rolling window | Simple message array (no compression) |
| Caching | LRU cache for file checksums, LLM responses, tool results | No caching implemented |
| Metrics | Prometheus-compatible counters/histograms/gauges | No metrics collection |
| Logging | Structured JSON with tracing | Console output only |
| Providers | Anthropic, OpenAI, Google, local models | Anthropic + Mock |
| Plugin system | Dynamic plugin loading with hooks | Not implemented |
| MCP support | stdio/HTTP MCP server connections | Not implemented |
| Audit logging | Append-only audit trail for file writes and permissions | No audit logging |
| Context overflow | Force compression + retry | Error thrown, no recovery |
| File watching | chokidar for cache invalidation | No file watching |

### What Was Omitted

- Context window summarization and compression
- In-memory caching (file checksums, LLM responses, glob/grep results)
- Prometheus metrics and structured logging
- Plugin system and MCP server integration
- OpenAI/Google/local LLM providers
- Distributed tracing and audit logging
- Git integration (automatic commits, branch management)
- Multi-file coordinated editing
- IDE integration (VS Code extension)
- Autonomous mode (run complex tasks with minimal interaction)

### Running Locally

```bash
# With real Claude API
export ANTHROPIC_API_KEY=your-key
cd ai-code-assistant
npm install && npm run dev

# With demo mode (no API key needed)
npm run dev -- --demo

# With specific model
npm run dev -- --model claude-opus-4-20250514

# Resume a previous session
npm run dev -- --resume abc12345

# List saved sessions
npm run dev -- --list-sessions
```
