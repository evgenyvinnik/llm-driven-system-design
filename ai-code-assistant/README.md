# AI Code Assistant - CLI Tool

A terminal-based AI coding assistant similar to Claude Code, GeminiCLI, or opencode. This project explores the system design of an intelligent CLI tool that helps developers write, debug, and understand code.

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

## Architecture Highlights

- **Agentic loop** - LLM decides which tools to use
- **Tool abstraction** - Pluggable tool system (Read, Write, Bash, etc.)
- **Context management** - Efficient token usage with summarization
- **Safety layer** - Permission system for sensitive operations

## Getting Started

### Prerequisites

- Node.js 20+
- An LLM API key (Anthropic, OpenAI, Google, etc.)

### Installation

```bash
cd ai-code-assistant
npm install
```

### Configuration

```bash
# Set your API key
export ANTHROPIC_API_KEY=your_key_here
# or
export OPENAI_API_KEY=your_key_here
```

### Running

```bash
# Start interactive session
npm start

# Or with a specific prompt
npm start -- "Explain the main function in src/index.ts"
```

## Project Structure

```
ai-code-assistant/
├── src/
│   ├── cli/              # CLI interface and argument parsing
│   ├── agent/            # Agentic loop and orchestration
│   ├── tools/            # Tool implementations
│   │   ├── read.ts       # File reading
│   │   ├── write.ts      # File writing
│   │   ├── edit.ts       # File editing
│   │   ├── bash.ts       # Command execution
│   │   ├── glob.ts       # File pattern matching
│   │   └── grep.ts       # Content search
│   ├── context/          # Context and memory management
│   ├── llm/              # LLM provider abstraction
│   ├── permissions/      # Safety and permission checks
│   └── utils/            # Shared utilities
├── tests/
├── architecture.md
├── system-design-answer.md
└── CLAUDE.md
```

## Documentation

- [architecture.md](./architecture.md) - Detailed system design and trade-offs
- [system-design-answer.md](./system-design-answer.md) - Interview-style architecture overview
- [CLAUDE.md](./CLAUDE.md) - Development notes and iteration history

## Technology Stack

- **Runtime:** Node.js / Bun
- **Language:** TypeScript
- **CLI Framework:** Commander.js or custom
- **LLM SDK:** Anthropic SDK, OpenAI SDK
- **Terminal UI:** Ink (React for CLI) or blessed
- **Testing:** Vitest

## Key Design Decisions

1. **Streaming-first** - All LLM responses stream to terminal
2. **Tool-use native** - Built around LLM tool calling
3. **Safety by default** - Explicit permissions for file writes and command execution
4. **Provider agnostic** - Abstract LLM interface for multiple providers
5. **Context efficiency** - Automatic summarization to stay within limits

## Related Projects

- [Claude Code](https://claude.ai/code) - Anthropic's official CLI
- [GeminiCLI](https://github.com/anthropics/anthropic-cookbook) - Google's CLI tool
- [aider](https://github.com/paul-gauthier/aider) - AI pair programming
- [Cursor](https://cursor.sh) - AI-powered IDE
