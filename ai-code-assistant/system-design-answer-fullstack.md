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

### Agent Controller Implementation

```typescript
interface AgentState {
  conversationId: string;
  messages: Message[];
  toolCalls: ToolCall[];
  pendingApprovals: Approval[];
  context: ContextWindow;
}

class AgentController {
  private llm: LLMProvider;
  private tools: Map<string, Tool>;
  private permissions: PermissionManager;
  private context: ContextManager;

  async run(userInput: string): Promise<void> {
    // Add user message to context
    this.context.addMessage({ role: 'user', content: userInput });

    // Agentic loop
    while (true) {
      // Get LLM response
      const response = await this.llm.complete({
        messages: this.context.getMessages(),
        tools: this.getToolDefinitions(),
        stream: true
      });

      // Stream text output to terminal
      await this.streamTextContent(response);

      // Check for tool calls
      const toolCalls = response.getToolCalls();
      if (toolCalls.length === 0) {
        break; // No more tools to execute
      }

      // Execute tools (may require user approval)
      const results = await this.executeTools(toolCalls);

      // Add results to context
      this.context.addToolResults(results);
    }
  }

  private async executeTools(calls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    // Group by approval requirements
    const autoApproved = calls.filter(c => this.canAutoApprove(c));
    const needsApproval = calls.filter(c => !this.canAutoApprove(c));

    // Execute auto-approved in parallel
    const autoResults = await Promise.all(
      autoApproved.map(call => this.executeTool(call))
    );
    results.push(...autoResults);

    // Request approval for others
    for (const call of needsApproval) {
      const approved = await this.requestApproval(call);
      if (approved) {
        results.push(await this.executeTool(call));
      } else {
        results.push({ toolId: call.id, error: 'User denied permission' });
      }
    }

    return results;
  }
}
```

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

```typescript
// LLM streaming -> Agent processing -> CLI rendering
async function streamingPipeline(userInput: string): Promise<void> {
  // 1. Send to LLM with streaming enabled
  const stream = llm.stream({
    messages: context.getMessages(),
    tools: toolDefinitions
  });

  // 2. Process stream chunks
  const toolCalls: ToolCall[] = [];
  let currentToolCall: Partial<ToolCall> | null = null;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text':
        // Stream text directly to terminal
        process.stdout.write(renderer.format(chunk.content));
        break;

      case 'tool_call_start':
        currentToolCall = { id: chunk.id, name: chunk.name, params: '' };
        cli.showSpinner(`Preparing ${chunk.name}...`);
        break;

      case 'tool_call_delta':
        if (currentToolCall) {
          currentToolCall.params += chunk.content;
        }
        break;

      case 'tool_call_end':
        if (currentToolCall) {
          toolCalls.push(currentToolCall as ToolCall);
          currentToolCall = null;
        }
        break;
    }
  }

  // 3. Execute collected tool calls
  if (toolCalls.length > 0) {
    const results = await executeTools(toolCalls);
    context.addToolResults(results);

    // Continue the loop for next LLM turn
    await streamingPipeline(''); // Empty input triggers continuation
  }
}
```

### Sequence Diagram

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
   │─────────────────▶│                 │  Edit file      │
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

## Deep Dive: Tool System Integration

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

```typescript
const EditTool: Tool = {
  name: 'Edit',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' }
    },
    required: ['file_path', 'old_string', 'new_string']
  },
  requiresApproval: true,

  async execute(params, context) {
    const { file_path, old_string, new_string, replace_all = false } = params;

    const content = await fs.readFile(file_path, 'utf-8');

    // Check uniqueness unless replace_all
    if (!replace_all) {
      const occurrences = content.split(old_string).length - 1;
      if (occurrences === 0) {
        return { success: false, error: 'String not found in file' };
      }
      if (occurrences > 1) {
        return {
          success: false,
          error: `String appears ${occurrences} times. Use replace_all or provide more context.`
        };
      }
    }

    const newContent = replace_all
      ? content.replaceAll(old_string, new_string)
      : content.replace(old_string, new_string);

    await fs.writeFile(file_path, newContent);

    return { success: true, output: 'File updated successfully' };
  }
};
```

**Why string replacement over line numbers?**
- Line numbers change as you edit
- String matching is more robust
- Forces LLM to provide sufficient context

### Bash Tool - Safety Patterns

```typescript
const BashTool: Tool = {
  name: 'Bash',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'number' },
      working_directory: { type: 'string' }
    },
    required: ['command']
  },
  requiresApproval: (params) => {
    // Auto-approve safe commands
    const safePatterns = [
      /^ls\b/, /^pwd$/, /^cat\b/, /^head\b/, /^tail\b/,
      /^git status/, /^git log/, /^git diff/,
      /^npm run (dev|build|test|lint)/
    ];
    return !safePatterns.some(p => p.test(params.command));
  },

  async execute(params, context) {
    const { command, timeout = 120000, working_directory } = params;
    const cwd = working_directory || context.workingDirectory;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        signal: context.abortSignal
      });

      return {
        success: true,
        output: stdout + (stderr ? `\n[stderr]\n${stderr}` : '')
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};
```

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

### Permission Interface

```typescript
interface Permission {
  type: 'read' | 'write' | 'execute';
  pattern: string; // Glob pattern or command prefix
  scope: 'session' | 'permanent';
  grantedAt: Date;
}

interface PermissionRequest {
  tool: string;
  operation: string;
  details: string;
}

class PermissionManager {
  private grants: Permission[] = [];
  private denials: Set<string> = new Set();

  async check(request: PermissionRequest): Promise<boolean> {
    // Check explicit grants
    if (this.hasGrant(request)) {
      return true;
    }

    // Check if previously denied
    const key = this.requestKey(request);
    if (this.denials.has(key)) {
      return false;
    }

    // Prompt user
    const approved = await this.promptUser(request);

    if (approved) {
      this.grants.push(this.createGrant(request));
    } else {
      this.denials.add(key);
    }

    return approved;
  }
}
```

### Permission Levels

| Level | Description | Examples |
|-------|-------------|----------|
| Auto-approve | Always allowed | File reads, safe commands |
| Session-approve | Ask once per session | File writes to specific dirs |
| Always-ask | Prompt every time | Arbitrary shell commands |
| Deny | Never allow | Destructive operations |

### File System Guard

```typescript
class FileSystemGuard {
  private allowedPaths: string[];
  private blockedPatterns: RegExp[];

  constructor(workingDir: string) {
    this.allowedPaths = [workingDir];
    this.blockedPatterns = [
      /\.env$/,           // Environment files
      /\.ssh\//,          // SSH keys
      /credentials/i,     // Credential files
      /secrets?\./i,      // Secret files
      /\.git\/config$/,   // Git credentials
    ];
  }

  canAccess(filePath: string, mode: 'read' | 'write'): boolean {
    const resolved = path.resolve(filePath);

    // Check blocked patterns
    if (this.blockedPatterns.some(p => p.test(resolved))) {
      return false;
    }

    // Check path is within allowed directories
    if (!this.allowedPaths.some(p => resolved.startsWith(p))) {
      return false;
    }

    return true;
  }
}
```

### Command Sandbox

```typescript
class CommandSandbox {
  private blockedCommands = [
    'rm -rf /',
    'sudo',
    'chmod 777',
    ':(){:|:&};:',  // Fork bomb
    'curl | sh',
    'wget | sh',
  ];

  private dangerousPatterns = [
    /rm\s+-rf?\s+[\/~]/,  // Recursive delete from root or home
    />\s*\/dev\/sd/,       // Write to block devices
    /mkfs/,                // Format filesystems
    /dd\s+if=/,            // Direct disk access
  ];

  validate(command: string): ValidationResult {
    // Check explicit blocklist
    if (this.blockedCommands.some(b => command.includes(b))) {
      return { valid: false, reason: 'Command is blocked' };
    }

    // Check dangerous patterns
    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(command)) {
        return { valid: false, reason: 'Potentially dangerous command' };
      }
    }

    return { valid: true };
  }
}
```

## Deep Dive: Session and Context Management

### Context Window Strategy

```
Total: 128K tokens

System prompt:     2K (fixed)
Recent messages:  30K (last 10 turns)
Tool definitions:  5K (fixed)
Context summary:  10K (compressed history)
File cache:       40K (recently read files)
Response buffer:  40K (for LLM output)
```

### Context Compression

```typescript
class ContextManager {
  private maxTokens: number;
  private tokenizer: Tokenizer;
  private summarizer: Summarizer;

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
}
```

### Session Persistence

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
}
```

## Deep Dive: Plugin and MCP Integration

### Plugin System

```typescript
interface Plugin {
  name: string;
  version: string;
  tools?: Tool[];
  hooks?: PluginHooks;
  commands?: SlashCommand[];
}

interface PluginHooks {
  onSessionStart?: (session: Session) => Promise<void>;
  onBeforeToolCall?: (call: ToolCall) => Promise<ToolCall>;
  onAfterToolCall?: (call: ToolCall, result: ToolResult) => Promise<void>;
  onMessage?: (message: Message) => Promise<Message>;
}

class PluginManager {
  private plugins: Map<string, Plugin> = new Map();

  async load(pluginPath: string): Promise<void> {
    const plugin = await import(pluginPath);

    // Register tools
    if (plugin.tools) {
      for (const tool of plugin.tools) {
        this.toolRegistry.register(tool);
      }
    }

    // Register hooks
    if (plugin.hooks) {
      this.hookRegistry.register(plugin.name, plugin.hooks);
    }

    this.plugins.set(plugin.name, plugin);
  }
}
```

### MCP (Model Context Protocol) Support

```typescript
interface MCPServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  url?: string;
}

class MCPClient {
  private servers: Map<string, MCPConnection> = new Map();

  async connect(server: MCPServer): Promise<void> {
    if (server.transport === 'stdio') {
      const process = spawn(server.command!);
      const connection = new StdioMCPConnection(process);
      await connection.initialize();
      this.servers.set(server.name, connection);
    } else {
      const connection = new HttpMCPConnection(server.url!);
      await connection.initialize();
      this.servers.set(server.name, connection);
    }
  }

  async listTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const [name, conn] of this.servers) {
      const serverTools = await conn.listTools();
      tools.push(...serverTools.map(t => ({
        ...t,
        name: `${name}:${t.name}` // Namespace tools
      })));
    }
    return tools;
  }

  async callTool(name: string, params: unknown): Promise<ToolResult> {
    const [serverName, toolName] = name.split(':');
    const conn = this.servers.get(serverName);
    if (!conn) {
      throw new Error(`MCP server ${serverName} not connected`);
    }
    return conn.callTool(toolName, params);
  }
}
```

## Deep Dive: Error Handling

### Error Types

```typescript
class ToolExecutionError extends Error {
  constructor(
    public tool: string,
    public params: unknown,
    public cause: Error
  ) {
    super(`Tool ${tool} failed: ${cause.message}`);
  }
}

class ContextOverflowError extends Error {
  constructor(public currentTokens: number, public maxTokens: number) {
    super(`Context overflow: ${currentTokens} > ${maxTokens}`);
  }
}

class PermissionDeniedError extends Error {
  constructor(public request: PermissionRequest) {
    super(`Permission denied: ${request.operation}`);
  }
}
```

### Error Recovery in Agent Loop

```typescript
class AgentController {
  async run(userInput: string): Promise<void> {
    try {
      await this.executeLoop(userInput);
    } catch (error) {
      if (error instanceof ContextOverflowError) {
        // Compress and retry
        await this.context.forceCompress();
        await this.executeLoop(userInput);
      } else if (error instanceof ToolExecutionError) {
        // Report to LLM and continue
        this.context.addMessage({
          role: 'tool',
          content: `Error: ${error.message}`
        });
        await this.executeLoop(''); // Continue loop
      } else {
        throw error;
      }
    }
  }
}
```

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

"The AI Code Assistant is built around an agentic loop where the LLM orchestrates tool calls to interact with the local file system and shell. Key design decisions include:

1. **Streaming-first** for responsive UX
2. **Layered permissions** for safety
3. **Context compression** to stay within token limits
4. **Provider abstraction** for flexibility
5. **String-based edits** for robustness

The main trade-off is between autonomy and safety - we lean toward explicit user approval for destructive operations while auto-approving reads and safe commands."
