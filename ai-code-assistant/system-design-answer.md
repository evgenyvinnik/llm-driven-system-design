# AI Code Assistant - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design an AI-powered command-line coding assistant similar to Claude Code or Cursor. This is essentially a terminal-based interface that lets developers interact with an LLM to read, write, and debug code in their local environment.

The key challenge is building an agentic system where the LLM can autonomously decide which tools to use while maintaining safety and providing a responsive user experience."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Conversational interface** - Natural language interaction in terminal
- **File operations** - Read, write, and edit files with AI assistance
- **Code understanding** - Analyze and explain codebases
- **Command execution** - Run shell commands through the AI
- **Context retention** - Remember conversation history within session
- **Safety controls** - Permission system for sensitive operations

### Non-Functional Requirements
- **Low latency** - Streaming responses for real-time feedback
- **Portability** - Works across macOS, Linux, Windows
- **Extensibility** - Plugin system for custom tools
- **Provider agnostic** - Support multiple LLM providers

### Scale Estimates
This is a single-user, local application, but we still have constraints:
- **Context window** - 128K-200K tokens depending on model
- **Response latency** - First token in <500ms, full response in <30s
- **File handling** - Support files up to 10MB
- **Session history** - Store thousands of messages across sessions

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Code Assistant                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐           │
│   │   CLI    │────▶│  Agent   │────▶│   LLM    │           │
│   │Interface │     │Controller│     │ Provider │           │
│   └──────────┘     └──────────┘     └──────────┘           │
│        │                │                                    │
│        │                ▼                                    │
│        │         ┌──────────┐                               │
│        │         │   Tool   │                               │
│        │         │  Router  │                               │
│        │         └──────────┘                               │
│        │                │                                    │
│        │    ┌───────────┼───────────┐                       │
│        │    ▼           ▼           ▼                       │
│        │ ┌──────┐   ┌──────┐   ┌──────┐                    │
│        │ │ Read │   │ Edit │   │ Bash │                    │
│        │ └──────┘   └──────┘   └──────┘                    │
│        │    │           │           │                       │
│        ▼    ▼           ▼           ▼                       │
│   ┌────────────────────────────────────────┐               │
│   │       Permission & Safety Layer        │               │
│   └────────────────────────────────────────┘               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Core Components

1. **CLI Interface** - Terminal UI with input handling, streaming output, markdown rendering
2. **Agent Controller** - Orchestrates the agentic loop between user, LLM, and tools
3. **Tool System** - Pluggable tools (Read, Edit, Bash, Glob, Grep, etc.)
4. **LLM Provider** - Abstraction for multiple LLM backends (Anthropic, OpenAI, etc.)
5. **Permission Manager** - Safety layer for approving sensitive operations
6. **Context Manager** - Handles token limits with summarization strategies

## Deep Dive: Agentic Loop (8 minutes)

This is the heart of the system - the loop that enables autonomous tool use.

### The Loop

```
User Input
    ↓
┌─────────────────────────────────────┐
│         Add to Context              │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│         LLM Inference               │◄──────┐
│   - Generate text (stream to UI)    │       │
│   - Decide tool calls               │       │
└─────────────────────────────────────┘       │
    ↓                                         │
   Has tool calls?                            │
    ↓                                         │
   Yes                                        │
    ↓                                         │
┌─────────────────────────────────────┐       │
│      Check Permissions              │       │
│   - Auto-approve reads              │       │
│   - Prompt for writes/commands      │       │
└─────────────────────────────────────┘       │
    ↓                                         │
┌─────────────────────────────────────┐       │
│      Execute Tools                  │       │
│   - Run in parallel if independent  │       │
│   - Collect results                 │       │
└─────────────────────────────────────┘       │
    ↓                                         │
┌─────────────────────────────────────┐       │
│      Add Results to Context         │───────┘
└─────────────────────────────────────┘

   No tool calls?
    ↓
   Done (wait for next user input)
```

### Key Design Decisions

**1. Streaming-first architecture**
```typescript
async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
  const stream = await this.client.messages.stream({...});

  for await (const event of stream) {
    if (event.type === 'text_delta') {
      yield { type: 'text', content: event.delta.text };
    }
  }
}
```
- Text streams to terminal immediately
- Tool calls are collected and executed after text completes
- User sees progress in real-time

**2. Parallel tool execution**
```typescript
// Safe tools can run in parallel
const readResults = await Promise.all([
  readFile('src/auth.ts'),
  readFile('src/user.ts'),
  readFile('src/db.ts')
]);
```
- Reads don't conflict - run them together
- Writes are sequential to avoid race conditions

**3. Approval batching**
- For multiple writes, show a single approval prompt with all changes
- User can approve all, reject all, or review individually

## Deep Dive: Tool System (7 minutes)

### Tool Interface

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  requiresApproval: boolean | ((params: any) => boolean);

  execute(params: any, context: ToolContext): Promise<ToolResult>;
}
```

### Core Tools

| Tool | Purpose | Approval |
|------|---------|----------|
| Read | Read file contents | Auto |
| Write | Create new file | Required |
| Edit | Modify existing file | Required |
| Glob | Find files by pattern | Auto |
| Grep | Search file contents | Auto |
| Bash | Run shell command | Pattern-based |

### Edit Tool - The Tricky One

```typescript
const EditTool: Tool = {
  name: 'Edit',
  parameters: {
    file_path: { type: 'string' },
    old_string: { type: 'string' },
    new_string: { type: 'string' }
  },

  async execute({ file_path, old_string, new_string }) {
    const content = await readFile(file_path);

    // Critical: old_string must be unique
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) {
      return { error: 'String not found' };
    }
    if (occurrences > 1) {
      return { error: 'String not unique - provide more context' };
    }

    const newContent = content.replace(old_string, new_string);
    await writeFile(file_path, newContent);
    return { success: true };
  }
};
```

Why string replacement over line numbers?
- Line numbers change as you edit
- String matching is more robust
- Forces LLM to provide sufficient context

### Bash Tool - Safety Patterns

```typescript
requiresApproval: (params) => {
  const safePatterns = [
    /^ls\b/,
    /^git (status|log|diff)/,
    /^npm run (dev|build|test)/,
    /^pwd$/
  ];
  return !safePatterns.some(p => p.test(params.command));
}
```

Read-only commands auto-approve. Anything destructive prompts the user.

## Deep Dive: Context Management (6 minutes)

### The Problem
- LLM context windows are large but finite (128K-200K tokens)
- Long coding sessions easily exceed limits
- Tool outputs (file contents) can be huge

### Solution: Multi-Strategy Compression

```typescript
class ContextManager {
  private maxTokens = 128000;

  async addMessage(message: Message): Promise<void> {
    const tokens = this.countTokens(message);

    if (this.currentTokens + tokens > this.maxTokens * 0.9) {
      await this.compress();
    }

    this.messages.push(message);
  }

  private async compress(): Promise<void> {
    // Strategy 1: Summarize old messages
    const old = this.messages.slice(0, -10);
    const recent = this.messages.slice(-10);

    const summary = await this.llm.summarize(old);

    this.messages = [
      { role: 'system', content: `Context summary:\n${summary}` },
      ...recent
    ];

    // Strategy 2: Truncate large tool outputs
    for (const msg of this.messages) {
      if (msg.content.length > 10000) {
        msg.content = msg.content.slice(0, 5000) +
          '\n...[truncated]...\n' +
          msg.content.slice(-2000);
      }
    }
  }
}
```

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

## Deep Dive: Permission System (5 minutes)

### Threat Model
- LLM might hallucinate dangerous commands
- Malicious prompts could trick the agent
- Accidental destructive operations

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

### Permission Grants

```typescript
interface Permission {
  type: 'read' | 'write' | 'execute';
  pattern: string;  // Glob pattern
  scope: 'once' | 'session' | 'permanent';
}

// User approves: "Allow writes to src/**/*.ts"
// Future writes to matching paths auto-approve
```

## LLM Provider Abstraction (3 minutes)

```typescript
interface LLMProvider {
  complete(request: CompletionRequest): Promise<Response>;
  stream(request: CompletionRequest): AsyncIterable<Chunk>;
  countTokens(text: string): number;
}

class AnthropicProvider implements LLMProvider {
  async *stream(request) {
    const stream = await this.client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      messages: request.messages,
      tools: request.tools
    });
    for await (const event of stream) { yield event; }
  }
}

class OpenAIProvider implements LLMProvider {
  async *stream(request) {
    const stream = await this.client.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: request.messages,
      tools: request.tools,
      stream: true
    });
    for await (const chunk of stream) { yield chunk; }
  }
}
```

Key insight: Tool calling schemas differ between providers but can be normalized.

## Session Management (2 minutes)

```typescript
interface Session {
  id: string;
  workingDirectory: string;
  messages: Message[];
  permissions: Permission[];
}

// Store in ~/.ai-assistant/sessions/
// Resume with: ai-assistant --resume <session-id>
```

Sessions enable:
- Continuing work across terminal restarts
- Reviewing past conversations
- Carrying forward learned permissions

## Trade-offs and Alternatives (5 minutes)

### 1. Streaming vs Buffered Responses
**Chose: Streaming**
- Pro: Better UX, user sees progress
- Con: More complex error handling, can't "unsay" errors
- Alternative: Buffer and show at once (simpler but worse UX)

### 2. String-based Edit vs Line Numbers
**Chose: String replacement**
- Pro: Robust to line changes, forces context
- Con: Fails if string not unique
- Alternative: Unified diff format (more expressive but LLMs struggle with it)

### 3. Tool Granularity
**Chose: Fine-grained tools (Read, Edit, Glob, Grep...)**
- Pro: LLM can compose primitives, clear responsibility
- Con: More tool calls, higher latency
- Alternative: Coarse tools (ReadAndEdit in one) - faster but less flexible

### 4. Local-only vs Cloud Sync
**Chose: Local-only**
- Pro: Privacy, no account needed, works offline
- Con: No cross-device sync
- Alternative: Optional cloud backup (complexity tradeoff)

### 5. Single Model vs Model Routing
**Chose: Single model per session**
- Pro: Consistent behavior, simpler
- Con: Can't use cheap model for simple tasks
- Alternative: Route by task complexity (e.g., Haiku for search, Opus for complex reasoning)

## Potential Improvements

1. **Autonomous mode** - Let agent run multi-step tasks without approval
2. **Git integration** - Automatic commits, branch management
3. **IDE integration** - VS Code extension for visual interface
4. **MCP support** - Connect external tool servers
5. **Learning** - Track successful patterns, improve over time

## Closing Summary (1 minute)

"The AI Code Assistant is built around an agentic loop where the LLM orchestrates tool calls to interact with the local file system and shell. Key design decisions include:

1. **Streaming-first** for responsive UX
2. **Layered permissions** for safety
3. **Context compression** to stay within token limits
4. **Provider abstraction** for flexibility
5. **String-based edits** for robustness

The main trade-off is between autonomy and safety - we lean toward explicit user approval for destructive operations while auto-approving reads and safe commands."
