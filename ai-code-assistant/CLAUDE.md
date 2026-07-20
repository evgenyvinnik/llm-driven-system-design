# evylcode (AI Code Assistant) — Development with Claude

## Project Context

Every other project in this repo is a *service*. This one is a *client*: a terminal coding agent (`evylcode`) that wraps an LLM in an agentic loop with filesystem and shell access. There is no server, no database, no Docker — the entire system is one Node process, and the interesting engineering is entirely about the loop and the blast radius.

The hard problem is not "call the API." It's that the model emits tool calls the process must actually execute against a real filesystem and a real shell, and the model is not a trusted principal. Every design decision below falls out of two constraints: the loop must terminate (a model that keeps calling tools will run forever and bill forever), and a compromised or confused model must not be able to `rm -rf ~` or read `~/.ssh/id_rsa`. Everything else — session persistence, provider abstraction, colored output — is scaffolding around those two.

The second interesting property is that the agent must work *without* an API key. `--demo` swaps in a mock provider that pattern-matches user input to tool calls, which means the loop, the permission prompts, the tool implementations, and the CLI can all be exercised offline and for free. That turns the LLM into a pluggable component rather than a hard dependency.

**Learning goals:** agentic loop design and termination, tool schema design for LLM consumption, layered permission systems for untrusted tool calls, provider abstraction behind a single interface, and session persistence for resumable conversations.

## Architecture at a Glance (what actually runs)

One process. `npm run dev` → `tsx src/index.ts`; installed as the `evylcode` bin.

| Component | File | Role | Why this one |
|-----------|------|------|--------------|
| **CLI + REPL** | `src/index.ts`, `src/cli/interface.ts` | Commander argument parsing, slash commands (`/help`, `/clear`, `/session`, `/sessions`, `/tools`, `/exit`), readline prompt loop | `commander` for parsing, `chalk` for color, `ora` for the "Thinking…" spinner — no TUI framework, because the render model is append-only lines |
| **Agent controller** | `src/agent/controller.ts` | The loop: LLM → tool calls → results → LLM, capped at **10 iterations** | Owns the system prompt and conversation state; the only place that knows the loop exists |
| **Tool registry** | `src/tools/index.ts` | 6 tools: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep` | Registry maps name → implementation and exposes `getDefinitions()` as JSON Schema for the API |
| **Permission manager** | `src/permissions/manager.ts` | Blocked-path globs, blocked-command regexes, session-scoped grants, denial memo | `minimatch` for path globs; regex for commands |
| **LLM providers** | `src/llm/anthropic-provider.ts`, `src/llm/mock-provider.ts` | Both implement `LLMProvider` (`complete`, `stream`, `countTokens`) | `@anthropic-ai/sdk` for the real one; the mock is 516 lines of regex intent-matching |
| **Session store** | `src/session/manager.ts` | JSON files in `~/.ai-assistant/sessions/<uuid>.json` | Flat files, not SQLite — a session is one document, always read and written whole |

Contracts live in `src/types/index.ts` (`Tool`, `ToolResult`, `LLMProvider`, `Message`, `Permission`, `Session`). No API key means the CLI prints setup instructions and exits unless `--demo` is passed; `--resume <sessionId>` rehydrates a saved conversation.

## Key Design Decisions

### 1. String-replacement edits, not line numbers — and the edit fails loudly on ambiguity
`Edit` takes `old_string` / `new_string` and refuses when the match count is 0 (`String not found`) or >1 without `replace_all` (`String appears N times… provide more context`). Line-number edits look simpler but break the moment the model's view of the file drifts from disk — and it *always* drifts, because the model read the file several tool calls ago and has since edited it. A line-based edit against a stale offset doesn't error; it silently corrupts a different line, and neither the model nor the user finds out until much later. String matching converts that silent corruption into a hard error the model can recover from by re-reading and supplying more surrounding context. The cost is real: the model must include enough context to be unique, which burns output tokens on every edit, and multi-site changes need either `replace_all` or one call per site.

### 2. A hard iteration cap (10) instead of trusting the model to stop
`executeLoop()` counts iterations and aborts with "Maximum iterations reached." The alternative — loop until the model returns no tool calls — has no upper bound on cost or wall-clock time. A model that misreads a tool result can retry the same failing `Read` indefinitely; each retry is a full-context API call, so a 20-message conversation loops at ~$0.05 a turn with no natural stopping point and no signal to the user that anything is wrong. The cap makes runaway loops cheap and visible. What we give up is legitimate long tasks: a genuine 15-step refactor is truncated mid-work with no resumption of the loop, and the user has to re-prompt. A production agent would replace the fixed count with a token/cost budget plus loop-detection on repeated identical tool calls.

### 3. Auto-approved tools run in parallel; approval-gated tools run sequentially
`executeTools()` partitions each batch by `requiresApproval` and `Promise.all`s the auto-approved half. Reads are commutative — three `Read`s in one turn have no ordering relationship, and serializing them adds latency proportional to file count for nothing. Writes are not: two `Edit`s to the same file executed concurrently would interleave a read-modify-write, and the second write would silently clobber the first. Sequencing them also keeps the permission prompts intelligible — a user cannot answer three overlapping y/n prompts. The trade-off is throughput on write-heavy turns, which is the correct thing to trade: a wrong edit costs far more than a slow one.

### 4. Two independent safety layers — deny-list patterns and grant-based permissions
`Bash` blocks `rm -rf /`, `mkfs`, `dd if=`, fork bombs, `sudo`, and `chmod 777` outright, and the permission manager blocks reads of `**/.ssh/**`, `**/.env*`, `**/*.pem`, `**/credentials*` regardless of any grant. Deny-lists alone are insufficient (`rm -r ~` with a space, or `bash -c 'rm -rf /'`, slip past regexes), and grants alone are insufficient because a user who has approved one `rm` in a session should not have thereby approved every destructive command. Layering them means a bypass needs to defeat both. What we give up is a clean security model: this is defense-in-depth over a regex, not a sandbox, and the honest statement is that the only real containment would be running tool execution in a container with a read-only mount.

### 5. The mock provider is a first-class provider, not a test double
`MockLLMProvider` implements the same `LLMProvider` interface as `AnthropicProvider` and is selected by `--demo`. Guarding the loop with `if (testMode)` branches would mean the code path exercised offline is not the code path that runs in production — the classic way a demo mode passes while the real thing is broken. Because the mock satisfies the interface, `--demo` runs the *actual* controller, the *actual* permission prompts, and the *actual* tool implementations; only token generation is substituted. That makes offline development of tools and permissions genuinely meaningful. The cost is that the mock is 516 lines of regex intent-matching that must be maintained alongside the tools, and it drifts: it knows how to trigger tools, but not how to react intelligently to their output.

## Current State

Works end to end as an interactive REPL: `npm run dev` (or `evylcode` after `npm run build`) starts the loop, `--demo` runs it with no API key, `-d/--directory` sets the working directory, `-m/--model` overrides the model, `--list-sessions` and `--resume <id>` cover persistence. All six tools are implemented with their own validation: `Read` supports offset/limit and returns numbered lines, `Bash` truncates output above 50KB (head + tail) with a 120s timeout and a 10MB buffer, `Grep`/`Glob` back onto `glob`/`minimatch`, `Edit` enforces uniqueness. Sessions serialize messages, permission grants, and settings to JSON and restore `Date` objects on resume. There are **no credentials** because there is no server and no login — the only secret is `ANTHROPIC_API_KEY` from the environment or `--api-key`.

Deliberately not built: context-window management (the message array grows unbounded until the API rejects it — no summarization, no compaction), any provider besides Anthropic and the mock, and automated tests (`vitest` is wired into `package.json` but zero test files exist). `AnthropicProvider.stream()` is fully implemented but the controller only calls `complete()`, so nothing streams today.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md with this structure. The old file's decision log claimed **"Decision: Streaming responses — real LLM providers stream actual tokens"** as a completed Phase 2/3 item; the controller calls `this.llm.complete()`, never `this.llm.stream()`, so the streaming path is dead code and the user watches a spinner until the full response arrives. It also listed "Add comprehensive tests" as a Phase 5 in-progress item when the test count is zero.
- **System prompt is silently dropped on the real provider (open bug):** `controller.ts` prepends a `role: 'system'` message with the tool-usage guidelines, but `AnthropicProvider.convertMessages()` skips system messages ("handled separately in Anthropic API") and `complete()` never passes a `system:` parameter. The guidance therefore reaches the mock provider and nothing else; the real model only sees tool *descriptions*. Fix is one line — hoist the system message out of `messages` and into `system` on `messages.create`.
- **Auto-approved bash commands are denied by the second layer (open bug):** `BashTool.requiresApproval` auto-approves `SAFE_PATTERNS` (`ls`, `git status`, `npm test`, …), so the controller never prompts and never records a grant — but `BashTool.execute()` then calls `permissions.canExecute()`, which requires an `execute` grant, and `index.ts` only grants `read`. Safe commands fail with "Permission denied" while *unsafe* ones succeed, because the approval prompt creates the grant they need. The two layers each assume the other is authoritative.
- **Model IDs are pinned to a deprecated generation:** the default is `claude-sonnet-4-20250514` (with `claude-opus-4-20250514` offered via `--model`), both of which are deprecated with a June 2026 retirement. Worth moving to a current alias.
- **CI:** the repo-wide smoke-test workflow was removed. It never applied here anyway — this project has no Docker services and no frontend, so `npm run type-check` is the whole verification story.

## Open Questions

1. The message array grows without bound. Is summarizing old turns the right compaction strategy for a *coding* agent, where tool output (file contents) dominates the context but is also the most re-derivable part — or is it better to drop stale tool results entirely and let the model re-`Read`?
2. The permission model grants per-exact-path and per-command-prefix. Prefix matching means approving `npm install lodash` also approves `npm install anything-else` — is prefix the right granularity, or should grants be per-argv-token with an explicit widening prompt?
3. `maxIterations = 10` bounds cost but doesn't distinguish "genuinely long task" from "stuck in a retry loop." Is loop *detection* (same tool + same params twice) a better termination signal than a fixed count, and can it be made cheap enough to run every iteration?
4. Auto-approved reads run in parallel, but nothing checks whether a parallel `Read` and a sequential `Edit` in the same batch touch the same file. Does the partition need a per-path dependency check, or is the model reliably not doing that?

## Resources

- [Anthropic tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) — the tool schema and result format this project targets
- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) — `messages.create` / `messages.stream` shapes used in `anthropic-provider.ts`
- [Anthropic text editor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool) — the reference `str_replace` semantics that decision 1 mirrors
- [Model Context Protocol](https://modelcontextprotocol.io) — the standard way to make the tool registry pluggable across hosts
- [Aider: repository map](https://aider.chat/docs/repomap.html) — a different answer to the context-window question in Open Question 1
