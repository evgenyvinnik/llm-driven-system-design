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

## References & Inspiration

### AI Code Assistant Products

- [GitHub Copilot](https://github.com/features/copilot) - GitHub's AI pair programmer powered by OpenAI Codex
- [Cursor](https://cursor.sh) - AI-first code editor built on VS Code
- [Codeium](https://codeium.com) - Free AI code completion and chat
- [Tabnine](https://www.tabnine.com) - AI code assistant with local and cloud models
- [Amazon CodeWhisperer](https://aws.amazon.com/codewhisperer/) - AWS AI coding companion
- [Sourcegraph Cody](https://sourcegraph.com/cody) - AI coding assistant with codebase context

### Research Papers

- [Evaluating Large Language Models Trained on Code](https://arxiv.org/abs/2107.03374) - OpenAI Codex paper introducing code-trained LLMs
- [A Systematic Evaluation of Large Language Models of Code](https://arxiv.org/abs/2202.13169) - Comprehensive benchmark of code LLMs
- [CodeBERT: A Pre-Trained Model for Programming and Natural Languages](https://arxiv.org/abs/2002.08155) - Microsoft's bimodal pre-trained model for code
- [InCoder: A Generative Model for Code Infilling and Synthesis](https://arxiv.org/abs/2204.05999) - Meta AI's unified generative model for code
- [StarCoder: May the Source Be with You](https://arxiv.org/abs/2305.06161) - BigCode's open LLM trained on permissively licensed code

### Documentation & Guides

- [Anthropic Tool Use Documentation](https://docs.anthropic.com/claude/docs/tool-use) - Building agentic systems with Claude
- [Model Context Protocol](https://modelcontextprotocol.io) - Anthropic's open protocol for connecting AI to tools and data
- [OpenAI Function Calling Guide](https://platform.openai.com/docs/guides/function-calling) - Connecting GPT models to external tools
- [LangChain Agents](https://python.langchain.com/docs/modules/agents/) - Framework for building agentic LLM applications

### Engineering Blogs

- [GitHub Blog: How GitHub Copilot is getting better at understanding your code](https://github.blog/2023-05-17-how-github-copilot-is-getting-better-at-understanding-your-code/) - Copilot architecture deep dive
- [Inside GitHub: Working with the LLMs behind GitHub Copilot](https://github.blog/2023-05-17-inside-github-working-with-the-llms-behind-github-copilot/) - Engineering decisions behind Copilot
- [Cursor Blog](https://cursor.sh/blog) - Technical posts on building an AI-native IDE
- [Codeium Blog: How Codeium Works](https://codeium.com/blog) - Engineering insights on AI code completion

### Open Source Projects

- [aider](https://github.com/paul-gauthier/aider) - AI pair programming in your terminal
- [Continue](https://github.com/continuedev/continue) - Open-source autopilot for VS Code and JetBrains
- [Tabby](https://github.com/TabbyML/tabby) - Self-hosted AI coding assistant
- [llama.cpp](https://github.com/ggerganov/llama.cpp) - Efficient inference of LLMs in C/C++
- [Ollama](https://github.com/ollama/ollama) - Run LLMs locally with simple API

### Prompt Engineering for Code

- [OpenAI Best Practices for Prompt Engineering](https://platform.openai.com/docs/guides/prompt-engineering) - Official guide to effective prompting
- [Anthropic Prompt Engineering Guide](https://docs.anthropic.com/claude/docs/prompt-engineering) - Techniques for getting better outputs from Claude
- [Microsoft Semantic Kernel](https://learn.microsoft.com/en-us/semantic-kernel/overview/) - SDK for integrating LLMs into applications
