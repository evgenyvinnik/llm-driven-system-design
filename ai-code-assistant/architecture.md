# AI Code Assistant — Architecture

## System Overview

A coding assistant translates a developer's request into model conversations and
local file or command operations. The model proposes actions; an execution system
must determine what is authorized, apply changes without losing user work, and
report what happened. The learning goals are agent orchestration, context
selection, permissions, terminal interaction, and recovery across interruptions.

**Scope of this document:** requirements and the high-level architecture describe
a proposed production-quality local assistant. The final Implementation Notes map
that design to this repository's `evylcode` prototype. The current application is
one Node.js process, with no database service or browser frontend. Production
quality here means dependable operation on developer machines, not adding a fleet
of microservices to a local CLI.

## Requirements

### Functional requirements

1. Accept a coding request and preserve its constraints through multiple model calls.
2. Read and search authorized project content with bounded output.
3. Propose file changes, obtain any required approval, apply them, and report checks.
4. Execute bounded commands with controlled filesystem and network access.
5. Show incremental progress and allow cancellation and later recovery.
6. Support provider adapters while retaining each provider's message semantics.

### Non-functional requirements

| Requirement | Proposed target or invariant |
|-------------|------------------------------|
| Responsiveness | Local acknowledgement within 100 ms; measure provider first-output latency separately |
| Correctness | No execution from incomplete tool arguments or a stale approval |
| Recovery | Persist every completed side effect before treating the task as safely checkpointed |
| Resource bounds | Explicit budgets for model calls, context, execution time, and output |
| Containment | Enforce authorized resources outside the model's instruction-following behavior |
| Portability | Tested terminal and execution adapters for each supported OS |

These are acceptance criteria, not measured capabilities of the current CLI.
No universal subsecond provider response or fixed model context size is assumed.

## Capacity Estimation

The primary scaling unit is a local task. Suppose a task makes 20 model requests
with an average 20,000 input tokens: that is 400,000 input tokens processed across
the task, even if its final conversation is much smaller. A per-request context
limit alone does not bound total cost.

For a hypothetical 128,000-token model context, reserve 8,000 for output, 8,000 for
system/tool instructions, and 12,000 for uncertainty and upcoming results. This
leaves 100,000 for selected history and source evidence. Actual limits and token
accounting belong to the selected provider; character counts are only estimates.

A 100,000-file repository calls for ignored-directory filtering and targeted
search. Cap the work and bytes read, not only the number of lines displayed after
a full traversal. Large logs should live in local output artifacts with references
in the conversation. Most machines should comfortably run one active task; higher
parallelism needs explicit process and memory limits.

## High-Level Architecture

Proposed production architecture; the execution boundary is absent from the local
prototype.

```
┌──────────────┐       ┌───────────────────┐       ┌────────────────┐
│ Terminal UI  │◀─────▶│ Task coordinator  │◀─────▶│ Model adapter  │
└──────────────┘       └────────┬──────────┘       └───────┬────────┘
                               │                          ▼
                    ┌──────────▼──────────┐       ┌────────────────┐
                    │ Policy + scheduler  │       │ Provider API   │
                    └──────────┬──────────┘       └────────────────┘
                               ▼
                    ┌─────────────────────┐       ┌────────────────┐
                    │ Restricted executor │◀─────▶│ Workspace      │
                    └──────────┬──────────┘       └────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │ Task journal        │
                    └─────────────────────┘
```

The coordinator owns task ordering and budgets. Policy makes authorization
choices; the executor enforces granted capabilities. The journal records task and
operation outcomes. None of these responsibilities is delegated to generated text.

## Core Components / Request Flows

### Task and model flow

1. Assign a task identity and record the user request and explicit constraints.
2. Select relevant history and file evidence within the provider's input budget.
3. Translate system instructions, messages, and tool definitions into provider format.
4. Stream displayable text while assembling tool calls by call identity.
5. Validate complete arguments and persist the requested calls, even when there is
   no accompanying assistant prose.
6. Apply policy, schedule independent work, and obtain approvals where required.
7. Persist outcomes and send matching tool results back to the model.
8. Stop on completion, cancellation, exhausted budget, or repeated failure.

Provider errors, truncated output, denied operations, and successful completion
need distinct states. A maximum-token stop is not evidence that the task finished.

### Tool execution

Use file reads, directory search, exact-text edits, full-file writes, and commands
as small primitives. Validate types, lengths, output limits, and operation-specific
preconditions at the executor boundary. A schema sent to a model is not runtime
validation.

Parallelize only operations with known independent inputs and effects. A read
followed by an edit of the same file may be order-sensitive even when the read
needs no approval. Command effects are usually too broad to infer from their names;
treat unknown effects conservatively. Serialize terminal approval presentation
without requiring every unrelated computation to stop.

### Edit flow

Prepare the proposed replacement against a known file revision and show the actual
diff. An approval binds to that revision, target, and replacement. Recheck before
applying; if the file changed, prepare a new proposal. A per-file lock coordinates
assistant writers, but does not stop an external editor that ignores the lock.
For concurrent human editing, prefer isolated workspaces and a conflict-aware
apply step rather than claiming a hash comparison removes every race.

Write a prepared replacement to a temporary file on the same filesystem and
rename it into place. Preserve intended metadata and define a flush policy if
power-loss durability is required. Atomic replacement protects against partial
content; it does not make a multi-file refactor transactional.

### Terminal flow

Render task events through one output owner. Keep the prompt stable, buffer ordinary
progress during an approval, and distinguish assistant text from authoritative tool
status. A slow output destination needs backpressure or bounded display coalescing.
Never drop approval or completion events just to keep up with text rendering.

## Database Schema

### Current persisted document

There is no SQL database. [SessionManager](./src/session/manager.ts) writes one
plaintext JSON document under `~/.ai-assistant/sessions/<uuid>.json`.

| Field | Actual contents |
|-------|-----------------|
| id | Random UUID |
| workingDirectory | Directory supplied when creating the record |
| startedAt | Creation date serialized as text |
| messages | Role, text, timestamp, optional tool calls/results |
| permissions | Permission records; runtime does not populate this array |
| settings | Theme/output/confirmation/history preferences; many are not wired |

Model, temperature, and token limit are not fields of the current SessionSettings.
Session loading restores date objects but does not initialize controller history.

### Proposed durable records

| Record | Key and contents | Constraint |
|--------|------------------|------------|
| Task | Task ID, workspace identity, request, status, revision | One authoritative owner per running task |
| Event | Task ID + sequence, type, payload reference | Ordered append with unique sequence |
| Operation | Local operation ID, provider call ID, arguments hash, state | Same ID cannot be reused for different intent |
| Approval | Operation ID, target revision, scope, decision | Execution must match the approved proposal |
| Artifact | Content hash, path, size, retention | Referenced outputs survive transcript compaction |

A local transactional store is an option once ordered events and recovery queries
justify it. It does not require Redis or a network database. Raw model call IDs
alone are insufficient: regeneration may assign new IDs to the same action.

## API Design

### Actual CLI interface

| Input | Behavior |
|-------|----------|
| `--directory`, `-d` | Resolve the base path from current CLI arguments |
| `--api-key`, `-k` | Anthropic credential, otherwise environment |
| `--model`, `-m` | Model string, otherwise pinned source default |
| `--demo` | Use mock provider with real local tools |
| `--resume`, `-r` | Load full-UUID JSON record, with incomplete restoration |
| `--list-sessions` | Display summaries with shortened IDs |
| `/clear` | Clear message arrays, not permission grants |
| `/exit` | Save current record and close readline |

The [README](./README.md) lists remaining flags, commands, and setup details.

### Tool and provider contracts

| Tool | Principal arguments | Current result |
|------|---------------------|----------------|
| Read | file_path, offset, limit | Numbered text and line counts |
| Write | file_path, content | Creation message, size, line count |
| Edit | file_path, old_string, new_string, replace_all | Replacement count or mismatch error |
| Glob | pattern, path | Sorted paths and total matches |
| Grep | pattern, path, glob_pattern, case_insensitive | Matching lines and search metadata |
| Bash | command, timeout, working_directory | Output or error and command metadata |

[Types](./src/types/index.ts) define completion, streaming, and token-estimation
methods. Anthropic and Mock implement them; no other provider is implemented.
Production adapters should advertise supported capabilities and preserve system
instructions, tool-result linkage, and stop reasons without silently dropping data.

## Key Design Decisions

### Explicit policy plus containment

Approvals answer whether an action is intended. Execution restrictions answer what
it can access. Both matter: prompting on every read creates fatigue, while approving
an arbitrary test script grants execution of whatever that repository defines.
Permit ordinary work within a scoped environment and require explicit expansion
for additional access. Deny-pattern matching alone cannot describe all equivalent
shell expressions or indirect file access.

The cost is an OS-specific execution layer and occasional blocked workflows that
need narrower, explainable resource grants. The current project has interactive
checks but none of that containment.

### Context selection plus a durable history

Preserve the task's constraints and evidence references separately from the model's
working context. Old file contents can often be fetched again; a rejected approach
or user restriction cannot safely be reconstructed by guessing. Summaries are
fallible and must not acquire the authority of system instructions.

This costs retrieval work and summary evaluation. Keeping every byte until the
provider rejects the request is simpler but creates abrupt failure and repeatedly
pays to resend irrelevant content. Context selection also reduces that repeated
input cost; response caching does not solve stale workspace facts.

### Recoverable operations before automatic replay

Persist operation intent and outcomes, then classify recovery by effect. Reads can
be repeated against current state. File replacements can compare before/after
revisions and identify a previously applied result. A command that may have sent a
network request cannot be safely repeated merely because no result was recorded.

The journal adds writes and recovery states. An in-memory result cache is simpler,
but disappears at the exact crash where evidence is needed. Even a durable journal
cannot atomically commit arbitrary external shell effects together with its record;
uncertain outcomes must remain explicit.

## Consistency and Idempotency

| Boundary | Proposed guarantee | Current behavior |
|----------|--------------------|------------------|
| Task history | Ordered, durable event/checkpoint state | Two message arrays; direct whole-file saves |
| File replacement | Revision-bound proposal and atomic file replacement | String match followed by direct write |
| Multi-file task | Per-file outcomes with conflict-aware recovery | Independent writes, no rollback |
| Command retry | Repeat only with known-safe semantics or explicit decision | No application replay ledger |
| Approval | Bound to operation content and scope | In-memory path/glob or command-prefix grants |
| Context summary | Versioned derivative of history | No summarization |

A matching old string prevents some misdirected edits. It does not prove that the
file is unchanged since the model read it. There is no checksum cache or tool-call
result cache in the current implementation.

## Security / Auth

The local developer is the intended user; there is no login or tenant service.
Production design must account for untrusted source files, tool output, and model
arguments. Reading a repository can expose instruction-like text; that text must
remain evidence rather than authorization to read secrets or run commands.

The current process inherits host privileges. Bash uses a shell with the inherited
environment and no network restrictions. File reads and search results enter the
conversation sent to Anthropic and are saved locally in plaintext. Do not describe
this as a sandbox or as a system that keeps all code local.

Actual path checks use globs, not canonical resource confinement. Reads generally
allow non-blocked paths outside the working directory. Search checks only the root;
Grep does not recheck each file before reading it. Symlink targets are not resolved
for policy. Execute grants use string prefixes, and any write grant enables the
additional working-directory string-prefix condition in `hasGrant`.

The UI's `y` and `always` choices are indistinguishable booleans; both create a
session grant. Blocked patterns are checked by individual tools after the approval
path, so a displayed approval does not guarantee the tool will run.

## Observability

Proposed task events should include task/operation identity, state transition,
duration, result status, and bounded usage information. Measure provider waiting,
user approval waiting, tool execution, and rendering separately. Record unknown
command outcomes distinctly from confirmed failures.

Avoid logging raw source, credentials, or unrestricted shell output as default
telemetry. The local implementation uses colored console output and spinners;
there are no Prometheus metrics, structured trace spans, audit files, or LRU caches.
Verbose mode displays at most ten lines of successful tool output, cut to 80
characters each; this display limit does not bound model context or session size.

## Failure Handling

| Failure | Current handling | Proposed behavior |
|---------|------------------|-------------------|
| Tool throws | Registry/tool returns an error result | Typed error plus bounded recovery policy |
| Provider fails | Print error, end current run | Classify retryable errors and account for partial output |
| Context exceeds provider limit | Ordinary error; no recovery | Select/compact context before retrying |
| Ten iterations reached | Print limit message and save | Explicit budget-exhausted state with completed effects |
| Session write fails | Error propagates to caller | Preserve last valid checkpoint and report unsaved state |
| Process interrupted | SIGINT exits without explicit save | Cancel work, reconcile outcomes, checkpoint |
| Command exceeds timeout | exec rejects and returns error | Terminate owned process tree and report partial effects |

The application does not configure a three-attempt 1/2/4-second retry policy.
Any Anthropic SDK request retries follow the installed SDK's behavior; they are
separate from tool replay. The source permits a configurable command timeout,
defaulting to 120 seconds, and uses a 10 MiB exec buffer. Successful command output
is cut to roughly 50,000 characters; failure output is not passed through that same
truncation path. No overall task deadline or abort signal is wired.

## Scalability Considerations

Bound repository traversal, file bytes, concurrent reads, model context, and total
request cost before adding parallelism. The present controller runs all
non-prompted calls concurrently without a configured concurrency cap, then all
prompted calls sequentially. It does not analyze read/write dependencies.

A team service could later centralize policy and billing, but that changes the
privacy and isolation model. Remote tool servers or plugins are additional trust
boundaries, not just names added to a tool registry. Neither is implemented here.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Deployment | Local coordinator and restricted executor | Hosted workspace service | Start from local developer workflow |
| Authorization | Scoped policy plus enforced capabilities | Command denylist alone | Bound indirect effects |
| Editing | Revision-bound exact-text replacement | Unversioned line offsets | Detect stale intent before applying |
| Recovery | Durable operation journal | Session result cache | Retain evidence after crashes |
| Context | Selected evidence plus task summary | Unbounded transcript | Bound cost without discarding intent |
| Rendering | Incremental transcript with single output owner | Independently printing workers | Stable prompts and ordered status |

## Implementation Notes

### Patterns actually implemented

- **Bounded agent loop:** [controller.ts](./src/agent/controller.ts) permits ten
  completion iterations, executes registered tools, and sends their results back.
  This bounds iteration count, though not tools per iteration or overall cost.
- **Tool errors as data:** [registry](./src/tools/index.ts) catches execution failures
  so the model can observe an error and try another approach.
- **Exact-text editing:** [edit.ts](./src/tools/edit.ts) rejects zero matches and
  ambiguous non-global replacements. It writes directly and has no prior revision.
- **Permission prompts:** [manager.ts](./src/permissions/manager.ts) tracks grants
  and denials. Its broad matching and conflicting Bash checks limit guarantees.
- **Session records:** [session manager](./src/session/manager.ts) saves JSON on
  creation, successful run completion, and `/exit`; no atomic checkpoint is used.
- **Provider substitution:** [Anthropic](./src/llm/anthropic-provider.ts) and
  [Mock](./src/llm/mock-provider.ts) share an interface and use the same tool loop.

### Wiring gaps that affect behavior

1. The controller calls `complete`, never `stream`; streaming UI claims are false.
2. Anthropic conversion discards system messages without passing a top-level system
   parameter. The controller's guidance does not reach the real provider.
3. An assistant message is recorded only when text is nonempty. Tool-only responses
   can therefore leave tool results without their corresponding tool-use message.
4. Resume loads SessionManager, but the controller initializes empty history and
   uses the current CLI directory. Session permissions are neither populated nor
   restored by the runtime. Short IDs in listings are not accepted as prefixes.
5. Bash's auto-approval classifier bypasses prompting, while execution still needs
   a grant. Fresh-session commands labeled safe fail permission checks.
6. `/clear` clears messages but retains permission grants; SIGINT exits directly.
7. Tool schemas are exposed to the model but not validated by the registry. The
   optional abort signal in types is not supplied or honored by the execution path.
8. Read's offset is zero-based in code despite a one-based schema description. Grep
   checks its 200-match threshold between files, so the last file can overshoot it.
9. The mock handles edit intent by reading only. Its continuation aggregates all
   historical tool results, so prior errors can contaminate later status messages.

### Simplified or omitted

There is no execution sandbox, atomic save, operation journal, conflict-aware
multi-file apply, context compression, tokenizer enforcement, output artifact
store, provider routing, plugin loader, MCP client, tracing, or production metrics.
The CLI uses Commander, readline, Chalk, and Ora; it has no advanced markdown parser,
resize layout engine, approval diff viewer, persistent command history, or tested
screen-reader announcement protocol.

The pinned default model is retired according to Anthropic's
[model lifecycle page](https://platform.claude.com/docs/en/about-claude/model-deprecations),
checked 2026-09-09. Select a supported model explicitly; adapter correctness still
needs separate repair. [README](./README.md) contains executable setup paths and
known limitations. This audit was based on source, not live API or terminal tests.
