# AI Code Assistant - Development with Claude

## Project Context

This document tracks the development journey of implementing an AI-powered CLI coding assistant similar to Claude Code, GeminiCLI, or opencode.

## Key Challenges to Explore

1. Agentic loop design and tool orchestration
2. Context window management and summarization
3. Safe file system and shell access
4. Streaming responses and terminal UI
5. Multi-provider LLM abstraction
6. Session persistence and history
7. Permission and safety systems

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Deliverables:**
- Detailed architecture document (architecture.md)
- System design interview answer (system-design-answer.md)
- Core component specifications
- Technology stack decisions

**Key decisions made:**
- TypeScript + Node.js for runtime
- String-based file editing (not line numbers) for robustness
- Layered permission system for safety
- Mock LLM provider for demo mode

### Phase 2: Initial Implementation
*In Progress*

**Completed:**
- Project structure and configuration (package.json, tsconfig.json)
- Type definitions (src/types/index.ts)
- CLI interface with colors and streaming (src/cli/)
- Tool system with 6 core tools:
  - Read: File reading with line numbers
  - Write: File creation
  - Edit: String-based file modification
  - Bash: Shell command execution with safety patterns
  - Glob: File pattern matching
  - Grep: Content search with regex
- Mock LLM provider with pattern-based intent detection (src/llm/)
- Agent controller with agentic loop (src/agent/)
- Permission manager with blocked patterns (src/permissions/)
- Session manager with persistence (src/session/)
- Main entry point with CLI argument parsing

**Focus areas:**
- Implement core functionality
- Get something working end-to-end
- Validate basic assumptions

**To do:**
- Add more sophisticated intent parsing to mock provider
- Implement context window management with summarization
- Add comprehensive error handling
- Write tests for tools and agent loop

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer
- Optimize tool execution
- Implement load balancing for multiple LLM providers
- Add monitoring

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

## Design Decisions Log

### 2024 - Initial Implementation

**Decision: Use string replacement for file editing instead of line numbers**
- Rationale: Line numbers change as files are edited, making them unreliable
- String matching forces the LLM to provide enough context for unique matches
- Trade-off: Fails if string is not unique (but can use replace_all flag)

**Decision: Layered permission system**
- Auto-approve: Safe read operations
- Session-approve: Write operations (approved once per session)
- Always-ask: Potentially dangerous commands
- Never-allow: Blocked patterns (rm -rf /, .ssh, credentials)

**Decision: Mock LLM provider for demo**
- Allows testing the full agentic loop without API keys
- Pattern-based intent detection simulates LLM behavior
- Easy to swap for real provider (AnthropicProvider, OpenAIProvider)

**Decision: Streaming responses**
- Better UX - user sees progress in real-time
- Character-by-character streaming with small delay for demo effect
- Real LLM providers would stream actual tokens

## Iterations and Learnings

### Iteration 1: Core Structure
- Created modular architecture with clear separation of concerns
- Each component (CLI, Agent, Tools, LLM, Permissions, Session) is independent
- TypeScript interfaces define contracts between components

### Iteration 2: Tool Implementation
- Implemented 6 core tools following the Tool interface
- Each tool handles its own validation and error cases
- Permission checking is done in ToolContext

## Questions and Discussions

### Open Questions
1. How to handle very large files (>10MB)?
   - Current approach: Truncate output, allow offset/limit parameters
   - Future: Streaming file reads, lazy loading

2. How to manage context window efficiently?
   - Current: Simple message array
   - Future: Summarization of old messages, selective retention

3. How to handle concurrent tool execution safely?
   - Current: Auto-approved tools run in parallel, approval-needed run sequentially
   - Future: Dependency graph for tool execution order

### Resolved Questions
- **Q: Line numbers vs string replacement for edits?**
  A: String replacement - more robust to changes

- **Q: How to handle dangerous commands?**
  A: Layered system with blocked patterns, safe patterns, and approval prompts

## Resources and References

- [Anthropic Tool Use Documentation](https://docs.anthropic.com/claude/docs/tool-use)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [aider Architecture](https://aider.chat/docs/architecture.html)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Test and iterate
- [ ] Add context window management
- [ ] Add real LLM provider support
- [ ] Add comprehensive tests

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*
