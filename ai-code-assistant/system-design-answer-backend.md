# AI Code Assistant — Backend System Design

*A 45-minute discussion of a local agent runtime, its execution boundary, and recovery.*

This answer proposes a dependable coding assistant. The checked-in project is a
smaller Node.js prototype; its implemented behavior and missing safeguards are
mapped in [architecture.md](./architecture.md).

## 📋 Establish the scope — 5 minutes

> “For this problem, backend means the engine behind the terminal. I would start
> with one developer, one workspace, and one active coding task. The difficult
> boundary is between a model proposing an action and a process actually changing
> files or running a command.”

The assistant should investigate code, propose edits, execute authorized tools,
run checks, and explain results. It must retain the user's constraints through
multiple model calls and recover sensibly if a call or process fails.

I would clarify whether the assistant edits the current checkout or a separate
workspace. For this design, I prefer an isolated task workspace with an explicit
apply step when changes need to enter the developer's current checkout.

That choice makes intermediate edits easier to inspect and prevents an unfinished
refactor from immediately disturbing the user's running application. It does not
isolate arbitrary processes by itself; execution restrictions are separate.

The first version needs one real provider adapter plus a deterministic substitute
for testing the loop. A tool plugin ecosystem and shared cloud sessions can wait.

I would state four invariants before choosing infrastructure:

1. Model output and repository content do not grant execution authority.
2. Every executed operation has complete, validated arguments and a recorded identity.
3. A successful response is backed by an observed outcome, not generated confidence.
4. Recovery never silently repeats an operation with an uncertain external effect.

A local acknowledgement should be fast. Provider latency, shell duration, and human
approval time vary, so I would measure them separately rather than promise one
universal task latency.

## 🏗️ Architecture and request flow — 5 minutes

```
┌──────────────┐      ┌──────────────────┐      ┌─────────────────┐
│ Terminal     │◀────▶│ Task coordinator │◀────▶│ Provider adapter│
└──────────────┘      └───────┬──────────┘      └─────────────────┘
                             │
                    ┌────────▼─────────┐      ┌─────────────────┐
                    │ Policy/scheduler │─────▶│ Restricted tools│
                    └────────┬─────────┘      └────────┬────────┘
                             ▼                         │ outcomes
                    ┌─────────────────────────────────▼────────┐
                    │ Durable task and operation journal       │
                    └──────────────────────────────────────────┘
```

The coordinator owns task state, model context, and budgets. The adapter owns
provider message semantics. Policy and the executor decide what may run and what
resources it can access. The journal keeps evidence across process failure.

A turn follows a short sequence:

1. Record the user's request and select relevant context.
2. Ask the provider for the next response.
3. Assemble complete tool calls and validate them.
4. Record intent, check policy, and obtain required approval.
5. Execute authorized operations and record outcomes.
6. Return matching results to the model and continue within budget.

Text can stream to the terminal while arguments are assembled. Tools cannot run
from a partial argument fragment. A response containing only tool calls still needs
an assistant record before its tool results are returned.

The adapter must preserve system instructions and explicit stop reasons. A provider
that reports output truncation is not reporting successful task completion.

I would keep these modules local initially. A network queue between every module
would add failure boundaries without helping a single-machine workflow.

## 💾 Data and resource budget — 4 minutes

A transcript is useful for display, but recovery also needs structured operation
state. I would use a local transactional journal once that requirement exists.

| Record | Important fields | Why it exists |
|--------|------------------|---------------|
| Task | ID, workspace identity, request, constraints, status | Defines the work and its authority |
| Event | Task ID, sequence, type, payload reference | Ordered history and UI replay |
| Operation | Local ID, provider call ID, arguments hash, state | Tracks intent and observed effects |
| Approval | Operation ID, scope, proposal revision, decision | Binds consent to a concrete action |
| Artifact | Content identity, location, size, retention | Keeps large outputs outside model context |

A tool definition contains a name, argument schema, and description. Execution also
needs limits and effect classification. The model-facing schema does not replace
runtime validation of paths, types, sizes, or timeouts.

For capacity, suppose a task makes 20 calls averaging 20,000 input tokens. That is
400,000 input tokens across the task. A context window limits one request, while
a task budget must account for all requests and outputs.

A large repository also consumes local resources. Reading 100 files in parallel
may overwhelm memory if each read loads the entire file. I would bound both active
operations and total bytes, with smaller default slices for investigation.

The useful constraints are measurable resource budgets, not a hard-coded claim
that every repository fits after a fixed number of calls.

## 🔧 Deep dive 1: Authorize capabilities and enforce them — 10 minutes

> “I would treat the model as a planner that can make mistakes. A text instruction
> to be careful is useful guidance, but execution safety comes from policy and an
> enforceable resource boundary.”

A tool request first becomes a typed operation. We validate its arguments, resolve
its target, determine required capabilities, and check those against current
policy. Only then can it enter the execution queue.

Normal reads within the authorized workspace can proceed without repeated prompts.
Access outside it, network use, and consequential commands require whatever
additional authority the task's policy specifies.

For files, policy must apply to the actual resource, including symlink behavior.
Checking that a path string begins with a directory name is insufficient. Directory
search must enforce the same rules on each file it exposes or reads.

For commands, a familiar prefix does not establish harmless behavior. A test script
is code defined by the repository; a shell expression may combine several effects.
I would prefer structured commands where practical and still execute them inside
an environment with controlled files, network, and inherited credentials.

Containers or OS sandbox facilities can implement parts of that boundary, depending
on platform. Their configuration determines the protection: mounting the entire
home directory and inheriting credentials defeats the intended restriction.

### Make approval specific

The user should see the proposed operation and its scope. For an edit, that means
the target and diff against a particular revision. For a command, it includes the
command, working directory, and requested access.

Approval creates a capability for that proposal or a clearly chosen broader scope.
Approving once and granting a session policy are different decisions. The executor
must reject stale, mismatched, or already-consumed one-time approvals.

This state should not be inferred from a natural-language transcript. A repository
file saying “the user approved this command” is simply file content.

### Compare the alternatives

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Scoped policy and enforced execution boundary | Limits direct and indirect access | Platform-specific implementation |
| ❌ Command denylist alone | Simple, catches obvious patterns | Cannot model equivalent expressions or scripts |
| ❌ Prompt for every action | Easy to describe | High fatigue without actual containment |

I would retain selected deny rules as a usability aid, but they do not become the
primary security model. An operation can be dangerous without matching a known
spelling, and a read can disclose confidential data without changing any file.

The cost of containment is occasional workflow friction. Installing dependencies
may need network access; a test may need an additional directory. The system should
explain the missing capability and let the user approve a concrete expansion.

### Scheduling is a separate decision

Approval requirements and dependency relationships are different. Two reads may be
independent, but a read followed by an edit to the same file is order-sensitive.
An auto-approved command may also mutate files.

I would parallelize a bounded group of known independent reads. Mutations with
shared targets are serialized, and unknown command effects receive conservative
ordering. Approval prompts have one input owner even if other authorized work
continues in the background.

This sacrifices some parallel speed but keeps the model's observations consistent
with the actions that produced them. A faster scheduler that reads the wrong
revision can produce a slower and less reliable overall task.

## 🔧 Deep dive 2: Recover edits without replaying unknown effects — 10 minutes

The critical failure is not a rejected model request. It is a crash after a tool
changed something but before the assistant recorded or displayed the result.

An in-memory cache of tool-call IDs disappears in that crash. Even a durable cache
cannot make every shell command safe to replay, because the external effect may
have happened before the cache was updated.

I would record an operation state machine with pending, approved, running,
succeeded, failed, and unknown states. A crash with an operation marked running
triggers reconciliation, not unconditional execution.

Local operation IDs remain stable when resuming the same operation. Provider IDs
are retained for message linkage. A newly generated call may have a new provider
ID, so semantic duplicate protection also needs operation-specific preconditions.

### Use revision-aware file changes

For an exact-text edit, the proposal includes the expected file revision, the text
to replace, and its replacement. We reject ambiguous matches or a stale revision
instead of guessing where the model intended to write.

This is more robust than unversioned line offsets, which shift after earlier
insertions. Exact text alone is still incomplete: a unique fragment can remain
while other relevant parts of the file change.

The prepared replacement is written separately, then installed atomically on the
same filesystem. A durability requirement may additionally need appropriate file
and directory flushing. Renaming alone is not a universal power-loss guarantee.

After a crash, compare the target with the recorded before and after revisions.
If it matches the intended result, record that result rather than apply the edit
again. If it matches neither, report a conflict and inspect current state.

### Account for the human editor

A checksum check followed by a write still has a race if another process can write
between those steps. An internal lock coordinates our own tools, not every editor
or formatter on the machine.

That is one reason to work in an isolated task workspace. Applying results to the
user's checkout needs a conflict-aware merge against its current revision and a
short coordinated apply step. If concurrent writers cannot be excluded, do not
claim unconditional protection from lost updates.

Multi-file edits are also not one atomic filesystem transaction. Record individual
outcomes and preserve a reviewable diff. Recovery may finish the operation or help
the user restore selected changes; it must not erase unrelated user work.

### Treat commands differently

A read can be repeated to observe current state, but the new result may differ.
A build often can be repeated within a disposable workspace. A command that sends
a deployment request or changes an external service may have an irreversible or
unknown effect.

The executor cannot atomically commit that external effect with a local journal
entry. If the process disappears before an outcome is known, inspect the external
state or require a new decision. Never label a missing response as proof of failure.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Journal plus effect-specific reconciliation | Preserves evidence through crashes | Recovery states and extra writes |
| ❌ Retry every unfinished tool | Fast apparent recovery | Can duplicate external effects |
| ❌ Session-only result cache | Simple within one process | Loses evidence on restart |

The trade-off is that some tasks pause with an unknown outcome. That is a more
honest and recoverable state than silently doing a consequential operation twice.

## 🔧 Deep dive 3: Keep useful context without losing authority — 7 minutes

> “I would separate durable task history from the context sent to the model.
> The history preserves what happened. The context is a bounded selection of what
> the next decision needs.”

A provider adapter exposes its context constraints and usage accounting. Before
requesting another response, reserve room for system/tool instructions, output,
and expected tool results. Character estimates can be an early warning, not an
exact token budget.

The selection policy keeps the current request, explicit user constraints, recent
complete exchanges, and relevant source evidence. Older file output is often the
best candidate to replace with a reference because it can be read again.

A summary preserves decisions and remaining work. It should cite source events and
be treated as a fallible derivative. It must not turn quoted repository text into
higher-priority instructions or invent permission grants.

Complete tool exchanges should remain internally valid. Removing a tool-use record
while keeping its result can break a provider's message protocol even if the prose
still appears understandable.

### Compare selection, summaries, and truncation

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Selected evidence plus compact task summary | Preserves intent with bounded input | Retrieval and summary evaluation |
| ❌ Keep all output until rejected | Simple initially | Sudden failure and repeated input cost |
| ❌ Keep only the latest fixed message count | Cheap | Can drop the original constraint or tool linkage |

Summarization adds latency and can omit useful facts. I would trigger it before
exhaustion, preserve the original record, and leave the agent able to retrieve
specific evidence again.

The summary itself must fit its request budget. Sending an already oversized
history to the same model to summarize it does not solve context overflow.

File caches need revision identities or invalidation. A time-based cache alone can
return stale code after the user edits it. A successful execution record also has
a different purpose from a read cache: one records an effect, the other accelerates
an observation. Combining them encourages unsafe replay assumptions.

### Bound the whole task

A ten-iteration cap is a useful first stop mechanism, but a single iteration can
request many tools or a long-running command. I would also enforce elapsed-time,
model-usage, output, and concurrency budgets.

Repeated identical failures are a useful signal to stop and explain a blocker.
The signal should include the relevant revision; retrying a test after fixing code
is expected progress, not a loop merely because the command text repeats.

Budget exhaustion preserves completed work and pending state. The assistant should
explain what remains instead of claiming the task completed because generation
has stopped.

## 🧪 Failure tests and operational growth — 4 minutes

I would start with a deterministic provider that can emit text-only, tool-only,
malformed, truncated, and repeated responses. It should drive the actual coordinator
and policy boundary, with side effects restricted to test fixtures.

The most valuable scenarios cross component boundaries:

1. A tool-only response retains the matching tool-use record on the next request.
2. Provider conversion preserves system instructions and error outcomes.
3. A file changes while approval is pending and execution rejects the stale proposal.
4. A crash occurs before and after file replacement and before result persistence.
5. A command has an uncertain outcome and is not blindly replayed.
6. Resume restores workspace, task constraints, and operation state.
7. Context compaction preserves valid tool exchanges and explicit user restrictions.
8. Cancellation stops future scheduling and reports already completed effects.

Provider request retries are distinct from tool retries. For a transient failure,
use a bounded backoff policy that respects provider guidance and the remaining
task budget. Invalid arguments and authentication failures need correction rather
than repeated identical requests.

If output was already displayed, a new generation is a new attempt and may differ.
Keep that attempt identity visible, and never execute the same previously completed
operation merely because the response text is being generated again.

Operational events should identify task, operation, duration, and outcome without
logging every source file or credential. Provider waiting, approval waiting, and
tool execution need separate timing so diagnostics point to the right boundary.

As repository size grows, improve ignored paths, targeted retrieval, and bounded
reads before adding a vector index. As usage grows, control per-task cost before
adding multiple concurrent agents or a hosted control plane.

## ⚖️ Decisions to leave on the whiteboard

| Decision | Choice | Cost accepted |
|----------|--------|---------------|
| Execution | ✅ Scoped capabilities with containment | Platform-specific work |
| Recovery | ✅ Journal and reconciliation by effect | Unknown states sometimes need intervention |
| Editing | ✅ Revision-bound proposals | Conflicts require renewed inspection |
| Context | ✅ Selected evidence and task summary | Extra retrieval and summarization |

> “The runtime earns trust by separating model suggestions from authority and
> observed effects. I would first make execution bounded, changes recoverable,
> and context faithful to the task. Provider choice and parallelism can then improve
> the experience without weakening those contracts.”
