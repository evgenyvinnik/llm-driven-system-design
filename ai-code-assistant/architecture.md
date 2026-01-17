# AI Code Assistant - Architecture

## System Overview

An AI-powered command-line interface that helps developers write, debug, and understand code through natural language interaction. The system orchestrates LLM capabilities with local file system and shell access to provide an intelligent coding assistant.

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

## Core Components

### 1. CLI Interface

The terminal interface for user interaction.

```typescript
interface CLIConfig {
  // Display settings
  theme: 'dark' | 'light' | 'auto';
  colorOutput: boolean;
  verbosity: 'quiet' | 'normal' | 'verbose';

  // Behavior
  streamResponses: boolean;
  confirmBeforeWrite: boolean;
  autoApproveReads: boolean;

  // Session
  saveHistory: boolean;
  historyPath: string;
}

class CLIInterface {
  private readline: Interface;
  private renderer: MarkdownRenderer;
  private spinner: Spinner;

  async prompt(): Promise<string> {
    return new Promise((resolve) => {
      this.readline.question('> ', resolve);
    });
  }

  async streamOutput(stream: AsyncIterable<string>): Promise<void> {
    for await (const chunk of stream) {
      process.stdout.write(this.renderer.render(chunk));
    }
  }

  async confirmAction(description: string): Promise<boolean> {
    const answer = await this.prompt(`Allow: ${description}? [y/n] `);
    return answer.toLowerCase() === 'y';
  }
}
```

**Features:**
- Markdown rendering for code blocks and formatting
- Streaming output with syntax highlighting
- Interactive prompts for permissions
- Progress indicators for long operations
- History navigation with arrow keys

### 2. Agent Controller

The core orchestration loop that coordinates LLM and tools.

```typescript
interface AgentState {
  conversationId: string;
  messages: Message[];
  toolCalls: ToolCall[];
  pendingApprovals: Approval[];
  context: ContextWindow;
}

interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: Date;
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

**Key Design Decisions:**

1. **Single-threaded loop** - Simple, predictable execution
2. **Streaming-first** - Text streams to terminal as generated
3. **Parallel tool execution** - Multiple safe tools run concurrently
4. **Explicit approval** - Dangerous operations require consent

### 3. Tool System

Extensible tool framework for file and shell operations.

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

// Example: Read Tool
const ReadTool: Tool = {
  name: 'Read',
  description: 'Read contents of a file',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to file' },
      offset: { type: 'number', description: 'Starting line number' },
      limit: { type: 'number', description: 'Number of lines to read' }
    },
    required: ['file_path']
  },
  requiresApproval: false, // Reading is safe

  async execute(params, context) {
    const { file_path, offset = 0, limit } = params;

    // Security check
    if (!context.permissions.canRead(file_path)) {
      return { success: false, error: 'Permission denied' };
    }

    try {
      const content = await fs.readFile(file_path, 'utf-8');
      const lines = content.split('\n');
      const selectedLines = limit
        ? lines.slice(offset, offset + limit)
        : lines.slice(offset);

      // Format with line numbers
      const output = selectedLines
        .map((line, i) => `${offset + i + 1}\t${line}`)
        .join('\n');

      return { success: true, output };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};

// Example: Edit Tool
const EditTool: Tool = {
  name: 'Edit',
  description: 'Replace text in a file',
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
  requiresApproval: true, // Writing requires approval

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
        return { success: false, error: `String appears ${occurrences} times. Use replace_all or provide more context.` };
      }
    }

    const newContent = replace_all
      ? content.replaceAll(old_string, new_string)
      : content.replace(old_string, new_string);

    await fs.writeFile(file_path, newContent);

    return { success: true, output: 'File updated successfully' };
  }
};

// Example: Bash Tool
const BashTool: Tool = {
  name: 'Bash',
  description: 'Execute shell command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'number', description: 'Timeout in ms' },
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
        maxBuffer: 10 * 1024 * 1024, // 10MB
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

**Tool Categories:**

| Category | Tools | Approval |
|----------|-------|----------|
| Read | Read, Glob, Grep | Auto-approved |
| Write | Write, Edit | Requires approval |
| Execute | Bash, Task | Pattern-based |
| Navigation | Search, Explore | Auto-approved |

### 4. Context Management

Efficient handling of conversation history within token limits.

```typescript
interface ContextWindow {
  messages: Message[];
  systemPrompt: string;
  totalTokens: number;
  maxTokens: number;
}

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

**Compression Strategies:**

1. **Summarization** - Compress old conversation into summary
2. **Truncation** - Cut long tool outputs
3. **Selective retention** - Keep recent messages, system prompt
4. **Rolling window** - Fixed number of recent turns

### 5. Permission System

Safety layer controlling access to sensitive operations.

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

  private hasGrant(request: PermissionRequest): boolean {
    return this.grants.some(grant =>
      this.matchesPattern(request, grant)
    );
  }

  // Pattern matching for paths and commands
  private matchesPattern(request: PermissionRequest, grant: Permission): boolean {
    if (grant.type !== this.getRequestType(request)) {
      return false;
    }
    return minimatch(request.details, grant.pattern);
  }
}
```

**Permission Levels:**

| Level | Description | Examples |
|-------|-------------|----------|
| Auto-approve | Always allowed | File reads, safe commands |
| Session-approve | Ask once per session | File writes to specific dirs |
| Always-ask | Prompt every time | Arbitrary shell commands |
| Deny | Never allow | Destructive operations |

### 6. LLM Provider Abstraction

Support for multiple LLM backends.

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

// Anthropic Implementation
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

// OpenAI Implementation
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

### 7. Session Management

Persistence of conversation history and settings.

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

## Data Flow

### User Input Processing

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

## Error Handling

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

// Error recovery in agent loop
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

## Security Considerations

### File System Access

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

### Command Execution

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

## Performance Optimization

### Parallel Tool Execution

```typescript
class ToolExecutor {
  async executeParallel(calls: ToolCall[]): Promise<ToolResult[]> {
    // Group by dependency
    const independent = calls.filter(c => !c.dependsOn);
    const dependent = calls.filter(c => c.dependsOn);

    // Execute independent tools in parallel
    const independentResults = await Promise.all(
      independent.map(call => this.execute(call))
    );

    // Execute dependent tools sequentially
    const dependentResults: ToolResult[] = [];
    for (const call of dependent) {
      const result = await this.execute(call);
      dependentResults.push(result);
    }

    return [...independentResults, ...dependentResults];
  }
}
```

### Response Streaming

```typescript
class StreamingRenderer {
  private buffer = '';
  private inCodeBlock = false;

  async render(stream: AsyncIterable<string>): Promise<void> {
    for await (const chunk of stream) {
      this.buffer += chunk;

      // Render complete lines
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        this.renderLine(line);
      }
    }

    // Render remaining buffer
    if (this.buffer) {
      this.renderLine(this.buffer);
    }
  }

  private renderLine(line: string): void {
    // Detect code blocks
    if (line.startsWith('```')) {
      this.inCodeBlock = !this.inCodeBlock;
    }

    // Apply syntax highlighting in code blocks
    if (this.inCodeBlock) {
      console.log(highlight(line));
    } else {
      console.log(line);
    }
  }
}
```

## Extensibility

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

interface SlashCommand {
  name: string;
  description: string;
  execute: (args: string[], context: CommandContext) => Promise<void>;
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

## Deployment

### Configuration

```typescript
interface Config {
  // LLM Settings
  provider: 'anthropic' | 'openai' | 'google' | 'local';
  model: string;
  apiKey?: string;
  apiBaseUrl?: string;

  // Context Settings
  maxContextTokens: number;
  summarizationThreshold: number;

  // Safety Settings
  requireApprovalForWrites: boolean;
  requireApprovalForCommands: boolean;
  blockedCommands: string[];
  blockedPaths: string[];

  // UI Settings
  theme: 'dark' | 'light';
  colorOutput: boolean;
  streamOutput: boolean;

  // Session Settings
  sessionDirectory: string;
  saveHistory: boolean;
  maxHistorySize: number;
}

// Load from multiple sources
function loadConfig(): Config {
  const defaultConfig = loadDefaults();
  const globalConfig = loadJsonFile('~/.ai-assistant/config.json');
  const localConfig = loadJsonFile('.ai-assistant.json');
  const envConfig = loadFromEnv();

  return merge(defaultConfig, globalConfig, localConfig, envConfig);
}
```

### Distribution

```bash
# NPM package
npm install -g ai-code-assistant

# Or run directly
npx ai-code-assistant

# Or build standalone binary
npm run build:binary  # Uses pkg or similar
```

## Technology Choices

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Runtime | Node.js/Bun | JavaScript ecosystem, async I/O |
| Language | TypeScript | Type safety, IDE support |
| CLI Framework | Custom | Full control over UX |
| Terminal UI | Ink | React paradigm for CLI |
| LLM SDK | Provider SDKs | Official support |
| File watching | chokidar | Cross-platform |
| Testing | Vitest | Fast, TypeScript native |

## Future Enhancements

1. **Multi-file editing** - Coordinated changes across files
2. **Git integration** - Automatic commits, branch management
3. **IDE integration** - VS Code extension, JetBrains plugin
4. **Voice input** - Speech-to-text for hands-free coding
5. **Autonomous mode** - Run complex tasks with minimal interaction
6. **Team collaboration** - Shared sessions, pair programming
7. **Learning mode** - Track patterns, improve suggestions
8. **Offline mode** - Local LLM fallback

## References

- [Anthropic Tool Use Documentation](https://docs.anthropic.com/claude/docs/tool-use)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Ink - React for CLI](https://github.com/vadimdemedes/ink)
- [aider Architecture](https://aider.chat/docs/architecture.html)
