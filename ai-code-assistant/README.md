# evylcode — AI Code Assistant

A TypeScript learning project that puts a language model inside a local coding
agent. The terminal accepts a request, the model proposes file or shell operations,
and the controller executes tools and returns their results to the model.

The interesting design problems are controlling side effects, preserving useful
context, and making tool execution understandable to the developer. This is one
Node.js process with an Anthropic adapter and an offline mock provider. There is
no web frontend, HTTP backend, database, or Docker infrastructure to start.

**Implementation status:** the basic completion/tool loop and six tools exist.
Streaming, reliable session resumption, filesystem containment, context compression,
and crash-safe editing are not complete. Read the limitations below before using
it on a working checkout. Demo mode uses the real tools and can modify files.

## What you can explore

- Ask the Anthropic provider to explain code or propose changes using tool calls.
- Read files with numbered output, find paths, and search file contents.
- Create or overwrite files, replace matching text, and invoke shell commands.
- Inspect permission prompts and observe tool results feeding another model call.
- Exercise the same controller without an API key using keyword-based demo input.
- Save conversation records to local JSON files and inspect session metadata.

The CLI displays a spinner during model completion, then prints the complete text.
The provider has a streaming method, but the controller does not call it.

## Start locally

Requires Node.js 20+ and npm. Both development and compiled execution use native
Node.js; there are no infrastructure services requiring Docker or Homebrew setup.

From the repository root:

```bash
cd ai-code-assistant
npm install
npm run dev -- --demo
```

Try `Read the file package.json`, `Find **/*.ts`, `/tools`, and `/session`.
Use `/exit` to save and close the session. The demo recognizes a limited set of
patterns; it does not perform general reasoning. Its edit intent reads the target
file and stops rather than generating an actual edit.

To run against a disposable directory instead of the project source:

```bash
mkdir -p /tmp/evylcode-demo
npm run dev -- --demo --directory /tmp/evylcode-demo
```

The directory flag sets the base path for tools. It does **not** confine filesystem
or shell access to that directory.

### Anthropic mode

Provide `ANTHROPIC_API_KEY` in the environment, or use the supported `--api-key`
flag. The environment avoids placing the credential in command arguments. There
is no automatic `.env` loader.

```bash
export ANTHROPIC_API_KEY='your-api-key'
export EVYLCODE_MODEL='your-supported-model-id'
npm run dev -- --model "$EVYLCODE_MODEL"
```

Replace both placeholders. The source still defaults to
`claude-sonnet-4-20250514`. As checked on 2026-09-09, Anthropic lists that model as
retired on June 15, 2026; select a supported model from its
[model lifecycle documentation](https://platform.claude.com/docs/en/about-claude/model-deprecations).
Changing the model flag does not repair the adapter/controller limitations listed
below. This documentation review did not make a paid API request.

### Compile and run

```bash
npm run type-check
npm run build
npm start -- --demo
```

Development uses `tsx src/index.ts`; it does not enable watch mode. To install the
local `evylcode` command, build first and then run `npm link`. Without that optional
link, use the npm commands above or `node dist/index.js`.

## Commands and tools

| Option | Actual behavior |
|--------|-----------------|
| `--demo` | Selects the mock provider; tools still execute locally |
| `-d, --directory <path>` | Base working directory, default current directory |
| `-k, --api-key <key>` | Overrides `ANTHROPIC_API_KEY` |
| `-m, --model <model>` | Overrides the pinned Anthropic model identifier |
| `-r, --resume <sessionId>` | Loads a saved JSON record; agent context restoration is incomplete |
| `-v, --verbose` | Shows a short preview of successful tool output |
| `--list-sessions` | Lists saved session summaries without requiring an API key |
| Initial positional prompt | Runs that request, then enters the interactive prompt |

| Slash command | Purpose |
|---------------|---------|
| `/help` | Show help; aliases `/h`, `/?` |
| `/clear` | Clear in-memory conversation messages; does not revoke grants |
| `/session` | Show current record metadata |
| `/sessions` | List up to ten saved session summaries |
| `/tools` | List the six registered tools |
| `/exit` | Save and exit; aliases `/quit`, `/q` |

Input is readline-based and submits on Enter. There is no implemented multiline
composer, persistent input history, slash-command autocomplete, or task-only
cancellation. Ctrl+C exits the process without an explicit session save.

| Tool | Implemented behavior | Caveat |
|------|----------------------|--------|
| Read | Read UTF-8 text with numbered lines and optional slice | Reads the whole file before slicing; offset is effectively zero-based despite its schema description |
| Write | Create parent directories and write full content | Overwrites existing files directly |
| Edit | Replace exact text; reject missing or ambiguous matches | No expected-version check or atomic replacement |
| Bash | Run a shell command, capture output, apply timeout | Host process privileges; no sandbox |
| Glob | Find paths, ignore node_modules and .git, display up to 500 | Checks search root permissions, not each result |
| Grep | Regex search with file filtering and limited displayed matches | Reads files without per-file permission checks |

Tool JSON schemas describe arguments to the model. The registry does not validate
those schemas at runtime; tools mostly cast arguments and catch execution errors.

## Permissions and data handling

The manager applies path block patterns and records grants and denials in memory.
Writes and commands can trigger a prompt. These checks are a teaching mechanism,
not a reliable security boundary:

- `y` and `always` produce the same session grant. There is no working distinction
  between approving once and approving similar future operations.
- After any write grant exists, the path-grant check also accepts targets whose
  text starts with the working-directory string. That is broader than an exact
  file grant and is not a valid directory containment check.
- Execute grants use the entire approved command as a string prefix. They are not
  parsed argument policies and do not account for shell semantics.
- Commands classified as auto-approved skip the prompt but still need an execute
  grant inside Bash. In a fresh session, commands such as `git status` therefore
  fail with permission denied.
- Reads are generally allowed outside the working directory. Path matching does
  not resolve symlinks, and directory searches do not enforce exclusions on every
  returned file. Shell commands can access data independently of file-tool guards.

Anthropic mode sends conversation text and tool results to the provider. Session
JSON files also contain those results in plaintext under
`~/.ai-assistant/sessions/`. Local persistence does not make remote inference
local-only, and the application does not implement redaction or encryption.

## Known implementation limitations

| Area | Current limitation |
|------|--------------------|
| Provider instructions | System-role messages are removed during conversion and never passed as the API's system parameter |
| Tool-only responses | The controller records assistant tool calls only when response text is nonempty, so a tool-only response can produce an unmatched tool result on the next API call |
| Session resume | The manager loads the JSON, but the controller starts with empty messages and current CLI directory; old context is not restored |
| Permission persistence | Grant APIs exist in the session manager, but runtime grants are not copied into it or restored |
| Session identifiers | Listings show eight-character prefixes; resume expects the full filename UUID and does not resolve prefixes |
| Crash recovery | Sessions and edited files use direct writes; there is no journal, atomic save, or completed-tool ledger |
| Context growth | No token-budget enforcement, summarization, or automatic overflow recovery |
| Tool scheduling | Non-prompted tools run together before prompted tools; approval classification does not establish dependencies |
| Completion limit | Ten model iterations per request; no overall cost budget or repeated-call detection |
| Demo reporting | Mock continuation considers historical tool results and may report an earlier failure or result |

To inspect saved records, list `~/.ai-assistant/sessions/`. Supplying a full UUID
with `--resume` selects that record, but should not be treated as reliable
conversation continuation until the context wiring is repaired.

## Development and verification

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start TypeScript source once |
| `npm run type-check` | Check TypeScript without emitting files |
| `npm run build` | Compile into dist |
| `npm start` | Run compiled CLI |
| `npm run lint` | Invoke ESLint; configuration must be available |
| `npm test` / `npm run test:watch` | Invoke Vitest; no test files are currently checked into this project |

Tools are registered explicitly in [src/tools/index.ts](./src/tools/index.ts).
Adding a tool requires implementing the shared interface and registering it there;
there is no dynamic plugin loader or MCP client.

This review checked documentation against source. It did not claim successful
live-provider execution, cross-platform terminal testing, or a passing test suite.

## Read next

- [Architecture](./architecture.md): proposed production design and verified implementation map.
- [Frontend interview](./system-design-answer-frontend.md): terminal interaction and rendering.
- [Backend interview](./system-design-answer-backend.md): orchestration, execution, and recovery.
- [Fullstack interview](./system-design-answer-fullstack.md): end-to-end task and permission flow.
- [Development history](./CLAUDE.md): prior iterations and open questions; current source takes precedence where it differs.
