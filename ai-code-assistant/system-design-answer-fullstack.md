# AI Code Assistant - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

Design an AI-powered command-line coding assistant that enables developers to interact with an LLM to read, write, and debug code in their local environment. Key challenges include:
- Agentic loop orchestration between LLM and tools
- End-to-end streaming from API to terminal
- Safe tool execution with layered permissions
- Session state management across restarts
- Extensibility via plugins and MCP (Model Context Protocol)

## Requirements Clarification

### Functional Requirements
1. **Conversational Interface**: Natural language interaction in terminal
2. **File Operations**: Read, write, and edit files with AI assistance
3. **Code Understanding**: Analyze and explain codebases
4. **Command Execution**: Run shell commands through the AI
5. **Context Retention**: Remember conversation history within session
6. **Safety Controls**: Permission system for sensitive operations

### Non-Functional Requirements
1. **Low Latency**: First token in <500ms, streaming throughout
2. **Portability**: Works across macOS, Linux, Windows
3. **Extensibility**: Plugin system for custom tools
4. **Provider Agnostic**: Support multiple LLM providers

### Scale Estimates
- Context window: 128K-200K tokens depending on model
- Response latency: First token <500ms, full response <30s
- File handling: Support files up to 10MB
- Session history: Thousands of messages across sessions

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

## Deep Dive: The Agentic Loop

This is the heart of the system - the loop that enables autonomous tool use.

### Loop Flow

```
User Input
    │
    ▼
┌─────────────────────────────────────┐
│         Add to Context              │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│         LLM Inference               │◀──────┐
│   - Generate text (stream to UI)    │       │
│   - Decide tool calls               │       │
└─────────────────────────────────────┘       │
    │                                         │
   Has tool calls?                            │
    │                                         │
   Yes                                        │
    │                                         │
    ▼                                         │
┌─────────────────────────────────────┐       │
│      Check Permissions              │       │
│   - Auto-approve reads              │       │
│   - Prompt for writes/commands      │       │
└─────────────────────────────────────┘       │
    │                                         │
    ▼                                         │
┌─────────────────────────────────────┐       │
│      Execute Tools                  │       │
│   - Run in parallel if independent  │       │
│   - Collect results                 │       │
└─────────────────────────────────────┘       │
    │                                         │
    ▼                                         │
┌─────────────────────────────────────┐       │
│      Add Results to Context         │───────┘
└─────────────────────────────────────┘

   No tool calls?
    │
    ▼
   Done (wait for next user input)
```

### Agent Controller Design

**AgentState Structure:**
- conversationId: unique session identifier
- messages: array of conversation messages
- toolCalls: pending tool invocations
- pendingApprovals: operations awaiting user consent
- context: managed context window

**Run Loop Logic:**
1. Add user message to context
2. Enter agentic loop (while true)
3. Get LLM response with streaming enabled
4. Stream text content to terminal as it arrives
5. Check for tool calls in response
6. If no tool calls: break loop, wait for next user input
7. Execute tools (may require user approval)
8. Add tool results to context
9. Continue loop for next LLM turn

**Tool Execution Strategy:**
- Group tool calls by approval requirements
- Auto-approved tools (reads) execute in parallel via Promise.all
- Tools needing approval execute sequentially with prompts
- Denied tools return error result instead of executing

### Key Design Decisions

1. **Single-threaded loop** - Simple, predictable execution
2. **Streaming-first** - Text streams to terminal as generated
3. **Parallel tool execution** - Multiple safe tools run concurrently
4. **Explicit approval** - Dangerous operations require consent

## Deep Dive: End-to-End Data Flow

### User Input to Response

```
User types: "Fix the bug in auth.ts"
            │
            ▼
┌─────────────────────────────┐
│     CLI Interface           │
│  - Parse input              │
│  - Add to context           │
└─────────────────────────────┘
            │
            ▼
┌─────────────────────────────┐
│     Agent Controller        │
│  - Build messages array     │
│  - Send to LLM              │
└─────────────────────────────┘
            │
            ▼
┌─────────────────────────────┐
│     LLM Provider            │
│  - Stream response          │
│  - Parse tool calls         │
└─────────────────────────────┘
            │
            ▼
┌─────────────────────────────┐
│     Tool Execution          │
│  - Read auth.ts             │
│  - Analyze code             │
│  - Edit with fix            │
└─────────────────────────────┘
            │
            ▼
┌─────────────────────────────┐
│     Permission Check        │
│  - Prompt for edit approval │
│  - Execute if approved      │
└─────────────────────────────┘
            │
            ▼
┌─────────────────────────────┐
│     Result Display          │
│  - Show changes made        │
│  - Stream explanation       │
└─────────────────────────────┘
```

### Streaming Pipeline

**Processing stream chunks:**

| Chunk Type | Action |
|------------|--------|
| text | Write directly to stdout via renderer |
| tool_call_start | Store id/name, show spinner |
| tool_call_delta | Accumulate params JSON |
| tool_call_end | Push to toolCalls array |

After stream completes:
- If toolCalls non-empty: execute them, add results to context, recurse
- If no tool calls: return control to user

### Sequence Diagram

```
┌──────┐          ┌───────┐          ┌─────┐          ┌───────┐
│ User │          │ Agent │          │ LLM │          │ Tools │
└──┬───┘          └───┬───┘          └──┬──┘          └───┬───┘
   │                  │                 │                 │
   │  "Fix auth bug"  │                 │                 │
   │─────────────────▶│                 │                 │
   │                  │  messages[]     │                 │
   │                  │────────────────▶│                 │
   │                  │  [Read auth.ts] │                 │
   │                  │◀────────────────│                 │
   │                  │                 │  Read auth.ts   │
   │                  │────────────────────────────────▶│
   │                  │                 │  file contents  │
   │                  │◀────────────────────────────────│
   │                  │  messages[] +   │                 │
   │                  │  tool result    │                 │
   │                  │────────────────▶│                 │
   │                  │  [Edit auth.ts] │                 │
   │                  │◀────────────────│                 │
   │  Approve edit?   │                 │                 │
   │◀─────────────────│                 │                 │
   │  Yes             │                 │  Edit file      │
   │─────────────────▶│────────────────────────────────▶│
   │                  │                 │  success        │
   │                  │◀────────────────────────────────│
   │                  │  messages[] +   │                 │
   │                  │  edit result    │                 │
   │                  │────────────────▶│                 │
   │                  │  "Fixed the bug"│                 │
   │◀─────────────────│◀────────────────│                 │
```

## Deep Dive: Tool System Integration

### Tool Interface

**Tool Structure:**
- name: identifier for LLM
- description: explains capability
- parameters: JSON Schema for inputs
- requiresApproval: boolean or function(params) => boolean
- execute(params, context): performs the operation

**ToolContext Provides:**
- workingDirectory: current path
- permissions: granted permission set
- abortSignal: for cancellation

**ToolResult Returns:**
- success: boolean
- output: string (on success)
- error: string (on failure)
- metadata: optional extra data

### Core Tools

| Tool | Purpose | Approval |
|------|---------|----------|
| Read | Read file contents | Auto |
| Write | Create new file | Required |
| Edit | Modify existing file | Required |
| Glob | Find files by pattern | Auto |
| Grep | Search file contents | Auto |
| Bash | Run shell command | Pattern-based |

### Edit Tool - String Replacement

**Execution flow:**
1. Read file content from disk
2. If not replace_all, check uniqueness:
   - 0 occurrences: return "String not found" error
   - >1 occurrences: return "String appears N times, use replace_all or provide more context"
3. Perform replacement (replaceAll or single replace)
4. Write updated content to file
5. Return success

> "Why string replacement over line numbers? Line numbers change as you edit. String matching is more robust and forces LLM to provide sufficient context."

### Bash Tool - Safety Patterns

**Auto-approve patterns (safe reads):**
- `ls`, `pwd`, `cat`, `head`, `tail`
- `git status`, `git log`, `git diff`
- `npm run (dev|build|test|lint)`

**Execution:**
- Run with exec, respecting timeout (default 120000ms)
- Capture stdout and stderr
- Respect maxBuffer (10MB)
- Honor abortSignal for cancellation

## Deep Dive: Permission System

### Layered Defense

```
┌─────────────────────────────────────┐
│   Layer 1: Path Restrictions        │
│   - Only access working directory   │
│   - Block ~/.ssh, .env, credentials │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│   Layer 2: Command Filtering        │
│   - Block rm -rf /                  │
│   - Block sudo, chmod 777           │
│   - Block fork bombs                │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│   Layer 3: User Approval            │
│   - Show exactly what will happen   │
│   - Require explicit consent        │
│   - Remember session permissions    │
└─────────────────────────────────────┘
```

### Permission Manager

**Check flow:**
1. Check if request matches existing grant - return true
2. Check if previously denied - return false
3. Prompt user for approval
4. On approval: store grant
5. On denial: store denial
6. Return decision

### Permission Levels

| Level | Description | Examples |
|-------|-------------|----------|
| Auto-approve | Always allowed | File reads, safe commands |
| Session-approve | Ask once per session | File writes to specific dirs |
| Always-ask | Prompt every time | Arbitrary shell commands |
| Deny | Never allow | Destructive operations |

### File System Guard

**Blocked patterns:**
- `.env$` - Environment files
- `.ssh/` - SSH keys
- `credentials` (case-insensitive)
- `secrets?.` (case-insensitive)
- `.git/config$` - Git credentials

**Access check:**
1. Resolve to absolute path
2. Check against blocked patterns - reject if match
3. Check if path is within allowed directories
4. Return true only if all checks pass

### Command Sandbox

**Blocked commands (explicit):**
- `rm -rf /`
- `sudo`
- `chmod 777`
- `:(){:|:&};:` (fork bomb)
- `curl | sh`, `wget | sh`

**Dangerous patterns (regex):**
- `rm\s+-rf?\s+[\/~]` - Recursive delete from root/home
- `>\s*\/dev\/sd` - Write to block devices
- `mkfs` - Format filesystems
- `dd\s+if=` - Direct disk access

## Deep Dive: Session and Context Management

### Context Window Strategy

```
┌─────────────────────────────────────────────────────────────┐
│            Context Window Budget (128K tokens)               │
├─────────────────────────────────────────────────────────────┤
│  System prompt:      2K (fixed)                              │
│  Recent messages:   30K (last 10 turns)                      │
│  Tool definitions:   5K (fixed)                              │
│  Context summary:   10K (compressed history)                 │
│  File cache:        40K (recently read files)                │
│  Response buffer:   40K (for LLM output)                     │
└─────────────────────────────────────────────────────────────┘
```

### Context Compression

**Compression triggers:**
- When currentTokens + newMessage > maxTokens * 0.9

**Compression strategies:**

1. **Summarize old messages:**
   - Keep last 10 messages intact
   - Summarize earlier messages via summarizer
   - Replace old messages with summary as system message

2. **Truncate large tool outputs:**
   - If tool result > 10000 chars
   - Keep first 5000 + "[truncated]" + last 2000

### Session Persistence

**Session Structure:**
- id: UUID
- workingDirectory: absolute path
- startedAt: timestamp
- messages: conversation history
- permissions: granted permissions
- settings: user preferences

**Storage location:** `~/.ai-assistant/sessions/{id}.json`

**Operations:**
- create(workingDir): Initialize new session
- resume(sessionId): Load existing session from disk
- save(session): Persist to JSON file

## Deep Dive: Plugin and MCP Integration

### Plugin System

**Plugin Structure:**
- name, version: identification
- tools: array of Tool definitions
- hooks: lifecycle callbacks
- commands: slash commands

**Plugin Hooks:**
- onSessionStart: initialization
- onBeforeToolCall: modify/intercept calls
- onAfterToolCall: post-processing
- onMessage: message transformation

**Loading a plugin:**
1. Import from plugin path
2. Register tools with toolRegistry
3. Register hooks with hookRegistry
4. Store in plugins map

### MCP (Model Context Protocol) Support

**Transport types:**
- stdio: spawn child process, communicate via stdin/stdout
- http: connect to HTTP endpoint

**Operations:**
- connect(server): Establish connection based on transport type
- listTools(): Aggregate tools from all connected servers (namespaced as `server:tool`)
- callTool(name, params): Route to appropriate server, return result

## Deep Dive: Error Handling

### Error Types

| Error | Cause | Contains |
|-------|-------|----------|
| ToolExecutionError | Tool failure | tool name, params, cause |
| ContextOverflowError | Token limit exceeded | currentTokens, maxTokens |
| PermissionDeniedError | User declined | PermissionRequest |

### Error Recovery in Agent Loop

**ContextOverflowError:**
1. Force compress context
2. Retry the loop

**ToolExecutionError:**
1. Add error message to context as tool result
2. Continue loop (LLM will see error and adapt)

**Other errors:**
- Re-throw for caller to handle

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Streaming-first | Better UX, user sees progress | More complex error handling, can't "unsay" errors |
| String-based edits | Robust to line changes, forces context | Fails if string not unique |
| Fine-grained tools | LLM can compose primitives, clear responsibility | More tool calls, higher latency |
| Local-only storage | Privacy, no account needed, works offline | No cross-device sync |
| Single model per session | Consistent behavior, simpler | Can't use cheap model for simple tasks |
| Layered permissions | Defense in depth, flexible policies | More prompts for user |

## Future Enhancements

1. **Autonomous Mode**: Let agent run multi-step tasks without approval
2. **Git Integration**: Automatic commits, branch management
3. **IDE Integration**: VS Code extension for visual interface
4. **MCP Ecosystem**: Connect external tool servers
5. **Model Routing**: Use cheaper models for simple tasks (Haiku for search, Opus for reasoning)
6. **Learning Mode**: Track successful patterns, improve over time
7. **Team Collaboration**: Shared sessions, pair programming
8. **Offline Mode**: Local LLM fallback

## Closing Summary

> "The AI Code Assistant is built around an agentic loop where the LLM orchestrates tool calls to interact with the local file system and shell. Key design decisions include:
>
> 1. **Streaming-first** for responsive UX
> 2. **Layered permissions** for safety
> 3. **Context compression** to stay within token limits
> 4. **Provider abstraction** for flexibility
> 5. **String-based edits** for robustness
>
> The main trade-off is between autonomy and safety - we lean toward explicit user approval for destructive operations while auto-approving reads and safe commands."
