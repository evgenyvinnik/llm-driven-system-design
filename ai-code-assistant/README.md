# AI Code Assistant - CLI Tool

A terminal-based AI coding assistant similar to Claude Code, GeminiCLI, or opencode. This project demonstrates the system design of an intelligent CLI tool that helps developers write, debug, and understand code.

## Overview

The AI Code Assistant is a command-line interface that provides:
- **Conversational coding help** - Ask questions, get explanations
- **Code generation** - Generate code from natural language descriptions
- **File operations** - Read, edit, and create files with AI assistance
- **Codebase understanding** - Analyze and navigate large codebases
- **Tool execution** - Run commands with AI orchestration

## Key Features

- Multi-turn conversation with context retention
- File system access with safety controls
- Shell command execution in sandboxed environment
- Streaming responses for real-time feedback
- Extensible tool/plugin system
- Session management and history

## Getting Started

### Prerequisites

- Node.js 20+
- npm or yarn

### Installation

```bash
# Navigate to the project directory
cd ai-code-assistant

# Install dependencies
npm install

# Run in development mode
npm run dev

# Or build and run
npm run build
npm start
```

### Quick Start

```bash
# Start interactive session in current directory
npm run dev

# Start in a specific directory
npm run dev -- -d /path/to/your/project

# Start with an initial prompt
npm run dev -- "Read the package.json file"

# Resume a previous session
npm run dev -- -r <session-id>

# List all saved sessions
npm run dev -- --list-sessions
```

## Usage

### Commands

Once the assistant is running, you can interact with it using natural language or slash commands:

**Slash Commands:**
- `/help` - Show available commands
- `/clear` - Clear conversation history
- `/session` - Show current session information
- `/sessions` - List all saved sessions
- `/tools` - List available tools
- `/exit` - Exit the assistant

**Example Prompts:**
```
Read the file src/index.ts
Find all TypeScript files in src/
Search for 'TODO' in the codebase
Create a new config.json file
Edit the main.ts to add error handling
Run npm test
Git status
```

### Tools

The assistant has access to the following tools:

| Tool | Description | Approval Required |
|------|-------------|------------------|
| **Read** | Read file contents with line numbers | No (auto-approved) |
| **Write** | Create new files | Yes |
| **Edit** | Modify existing files using string replacement | Yes |
| **Bash** | Execute shell commands | Pattern-based |
| **Glob** | Find files matching a pattern | No (auto-approved) |
| **Grep** | Search file contents with regex | No (auto-approved) |

### Permission System

The assistant uses a layered permission system:

1. **Auto-approved operations** - File reads, safe commands (ls, git status, npm run)
2. **Session-approved** - Operations approved once apply for the session
3. **Always-ask** - Destructive operations prompt every time
4. **Blocked** - Dangerous patterns are never allowed (.ssh, credentials, rm -rf /, etc.)

When an operation requires approval, you'll see a prompt:
```
┌─ Permission Required ─────────────────────────────────────────┐
│
│  Edit: Edit file content
│     Target: src/index.ts
│
└────────────────────────────────────────────────────────────────┘
Allow? [y/n/a] (a=always)
```

## Architecture

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

- **CLI Interface** (`src/cli/`) - Terminal UI with input handling, streaming output
- **Agent Controller** (`src/agent/`) - Agentic loop orchestrating LLM and tools
- **Tool System** (`src/tools/`) - Pluggable tools (Read, Edit, Bash, Glob, Grep)
- **LLM Provider** (`src/llm/`) - Abstraction for LLM backends (mock provider for demo)
- **Permission Manager** (`src/permissions/`) - Safety layer for sensitive operations
- **Session Manager** (`src/session/`) - Persistence of conversation history

## Project Structure

```
ai-code-assistant/
├── src/
│   ├── index.ts           # Main entry point
│   ├── types/             # TypeScript type definitions
│   │   └── index.ts
│   ├── cli/               # CLI interface
│   │   ├── index.ts
│   │   └── interface.ts
│   ├── agent/             # Agent controller (agentic loop)
│   │   ├── index.ts
│   │   └── controller.ts
│   ├── tools/             # Tool implementations
│   │   ├── index.ts       # Tool registry
│   │   ├── read.ts        # File reading
│   │   ├── write.ts       # File creation
│   │   ├── edit.ts        # File editing
│   │   ├── bash.ts        # Command execution
│   │   ├── glob.ts        # File pattern matching
│   │   └── grep.ts        # Content search
│   ├── llm/               # LLM provider abstraction
│   │   ├── index.ts
│   │   └── mock-provider.ts
│   ├── permissions/       # Permission system
│   │   ├── index.ts
│   │   └── manager.ts
│   └── session/           # Session management
│       ├── index.ts
│       └── manager.ts
├── package.json
├── tsconfig.json
├── architecture.md        # Detailed system design
├── system-design-answer.md # Interview-style overview
└── CLAUDE.md              # Development notes
```

## Demo Mode

This implementation uses a **mock LLM provider** that simulates AI responses for demonstration purposes. The mock provider:

- Parses natural language input to detect user intent
- Generates appropriate tool calls based on patterns
- Streams responses character by character
- Demonstrates the full agentic loop

To use with a real LLM provider, implement the `LLMProvider` interface:

```typescript
interface LLMProvider {
  name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  countTokens(text: string): number;
}
```

## Development

### Available Scripts

```bash
npm run dev        # Start with tsx (hot reload)
npm run build      # Compile TypeScript
npm run start      # Run compiled version
npm run lint       # Run ESLint
npm run type-check # TypeScript type checking
npm run test       # Run tests
```

### Adding New Tools

1. Create a new tool file in `src/tools/`:

```typescript
import type { Tool, ToolContext, ToolResult } from '../types/index.js';

export const MyTool: Tool = {
  name: 'MyTool',
  description: 'Description of what the tool does',
  parameters: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Parameter description' }
    },
    required: ['param1']
  },
  requiresApproval: false,

  async execute(params, context): Promise<ToolResult> {
    // Implementation
    return { toolId: 'mytool', success: true, output: 'Result' };
  }
};
```

2. Register in `src/tools/index.ts`:

```typescript
import { MyTool } from './mytool.js';

// In ToolRegistry constructor:
this.register(MyTool);
```

## Key Design Decisions

1. **Streaming-first** - All LLM responses stream to terminal for responsive UX
2. **Tool-use native** - Built around LLM tool calling with explicit tool definitions
3. **Safety by default** - Explicit permissions for file writes and command execution
4. **String-based edits** - Edit tool uses string replacement (not line numbers) for robustness
5. **Session persistence** - Conversations are saved for later resumption

## Related Documentation

- [architecture.md](./architecture.md) - Detailed system design and trade-offs
- [system-design-answer.md](./system-design-answer.md) - Interview-style architecture overview
- [CLAUDE.md](./CLAUDE.md) - Development notes and iteration history

## Technology Stack

- **Runtime:** Node.js
- **Language:** TypeScript
- **CLI Framework:** Commander.js
- **Terminal UI:** chalk, ora
- **Testing:** Vitest

## Related Projects

- [Claude Code](https://claude.ai/code) - Anthropic's official CLI
- [aider](https://github.com/paul-gauthier/aider) - AI pair programming
- [Cursor](https://cursor.sh) - AI-powered IDE

## License

MIT
