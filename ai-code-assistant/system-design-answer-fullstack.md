# AI Code Assistant — Fullstack System Design

*A 45-minute discussion connecting terminal interaction to model and tool execution.*

This is a proposed production-quality local assistant. The repository's prototype
implements the basic completion/tool loop. Its missing streaming, recovery, and
execution safeguards are documented in [architecture.md](./architecture.md).

## 📋 Frame the task — 5 minutes

> “I would use one concrete workflow: a developer asks the assistant to fix a
> failing test. The assistant investigates, proposes a change, applies authorized
> edits, runs validation, and explains the result. We need the terminal and runtime
> to agree about what actually happened at every step.”

I would confirm that we are designing a local coding agent, not an autocomplete
service or a shared browser IDE. The first version has one active task in a
workspace and uses a remote model through a provider adapter.

Local execution keeps integration with the developer's tools straightforward.
It does not imply that code stays local: selected source and tool output are sent
to the provider. That boundary must be clear in the product.

The main user needs are straightforward:

- Start with a natural-language request and see immediate acknowledgement.
- Follow meaningful progress through multiple model and tool calls.
- Review any operation that needs approval.
- Know which files changed and which checks actually ran.
- Stop a task and continue later without losing its intent or repeating effects.

I would exclude dynamic plugins, shared sessions, and advanced terminal layouts
from the initial scope. Each adds another trust or interaction boundary.

I would also establish whether edits affect the current checkout immediately.
My proposed default is a separate task workspace and a reviewable apply step.
A direct-edit mode is possible but needs explicit coordination with external
editors and clear partial-change behavior.

The quality bar is not “the model returns plausible code.” It is a traceable path
from request to authorized action to observed outcome.

## 🏗️ Draw the system — 5 minutes

```
┌──────────────┐      ┌──────────────────┐      ┌────────────────┐
│ Terminal UI  │◀────▶│ Task coordinator │◀────▶│ Model adapter  │
└──────────────┘      └────────┬─────────┘      └───────┬────────┘
                              │                        ▼
                    ┌─────────▼──────────┐      ┌────────────────┐
                    │ Policy + executor  │      │ Provider API   │
                    └─────────┬──────────┘      └────────────────┘
                              │
                    ┌─────────▼──────────┐      ┌────────────────┐
                    │ Task workspace     │      │ Task journal   │
                    └────────────────────┘      └────────────────┘
```

I would explain the arrows verbally. The coordinator sends context to the model,
receives text and proposed tools, and passes complete operations to the executor.
The executor checks policy, applies allowed effects, and returns observed results.

The coordinator and executor record task transitions in the journal. The UI renders
those events and sends input or identified approval decisions back to the runtime.

The journal is drawn separately from the workspace because a transcript save and
a file edit are different writes. A crash between them is a central recovery case.

The model adapter preserves provider-specific system instructions, tool-call IDs,
and stop reasons. It can normalize events without pretending every provider has
the same capabilities.

The terminal has one input owner and one output owner. Concurrent tools publish
events rather than competing to print over a prompt.

This architecture can begin within a small local application. The executor needs
an enforceable resource boundary; the other boxes do not need to become remote
microservices simply to justify the word fullstack.

## 💾 Shared state and contracts — 4 minutes

The UI and runtime should share a vocabulary for task and operation state.

| Object | Essential information | Meaning |
|--------|-----------------------|---------|
| Task | ID, workspace, request, constraints, status | The work the user authorized |
| Response attempt | Task ID, attempt ID, completion state | One provider generation, possibly interrupted |
| Operation | ID, tool, validated arguments, state | A concrete action with a trackable outcome |
| Proposal | Operation ID, target revision, scope | What the user can approve |
| Event | Task ID, sequence, type, payload reference | Ordered evidence for display and recovery |
| Artifact | Location, identity, size | Full log or diff outside a bounded preview |

A tool success comes from its execution result. Assistant prose explaining an
intended change is not a substitute. Likewise, “tests started” and “tests passed”
are separate events.

The model-facing transcript contains complete tool-use/result pairs. A response
with tool calls and no prose is still a real assistant response and must be saved.

The UI may retain more history than the next model request includes. Durable task
history, model context, and visible screen content have different lifetimes.

For scale, 20 requests averaging 20,000 input tokens consume 400,000 input tokens
across a task. Context selection, output limits, and task budgets therefore affect
both responsiveness and cost. No fixed model window is assumed in the core design.

## 🔧 Deep dive 1: A streamed proposal becomes an authorized change — 10 minutes

> “The first hard boundary is turning a partial model response into a real action.
> I would allow text to appear early, but I would only execute a complete validated
> operation that still matches the user's authority.”

The developer submits the failing-test request. The terminal immediately shows a
running task, while the coordinator selects relevant context and calls the model.
Text fragments can stream through a small renderer buffer.

Tool arguments may arrive in pieces. The adapter assembles them by call identity,
then the runtime validates types, sizes, target paths, and requested capabilities.
Incomplete or malformed arguments produce an error state, never a partial write.

The model first reads the relevant code and test output. Known independent reads
can run concurrently within byte and operation limits. A read followed by an edit
of the same file may be ordered; approval requirements do not establish independence.

The next response proposes a code replacement. The runtime prepares a concrete
diff against an identified file revision. The UI can now show what will change,
not merely the model's description of what it hopes to change.

### Design the approval contract

The prompt displays the target, diff, scope, and proposal identity. For a command,
it shows the actual command, working directory, and requested access.

A large diff may need a separate viewer, but the full proposal remains inspectable.
The interface labels any shortened preview so the user understands its limits.

Approving once binds to that proposal. A session grant is an explicit broader
choice. The runtime checks the decision's operation and revision before execution.
If the file changed while the user was reading, the proposal is stale.

The terminal gives one approval ownership of input. Independent authorized work
may continue, with progress buffered so it cannot replace or obscure the decision.
An asynchronous queue is fine if each response is tied to the displayed proposal.

### Enforce beyond the prompt

A user approval does not itself constrain the process. Tools need authorized file
roots, network policy, controlled environment variables, and bounded resources.
The particular OS mechanism can vary; its configuration must enforce the policy.

A separate Git workspace is useful for change isolation but is not a shell sandbox.
A command can still access other files or the network if the process is allowed to.

Repository content is also untrusted input. A file may contain instructions that
look relevant to the task. Those instructions are evidence for the model, not a
new permission grant from the developer.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Revision-bound proposal with scoped execution | Approval matches the applied action | More proposal and policy state |
| ❌ Ask only “allow file edit?” | Simple dialog | User cannot evaluate the actual change |
| ❌ Trust model-generated safety descriptions | Less execution machinery | No enforceable authority boundary |

The cost of the chosen design is friction when additional access is needed. The
system should explain the concrete missing capability so the user can make a
meaningful decision instead of repeatedly approving vague warnings.

### Apply and report

The executor records intent, applies the prepared change, and records the result.
The terminal updates from pending to running to succeeded or failed using those
operation events.

Exact-text replacement avoids fragile unversioned line offsets, but it still needs
revision checks. A unique substring can remain in a file that changed elsewhere.

In the task workspace, assistant writers can be coordinated. Applying to the user's
checkout needs conflict detection against current contents and a coordinated apply
step. An internal lock does not protect against an editor that ignores that lock.

The final assistant explanation can cite the observed change and validation. It
cannot claim success just because the edit proposal was approved.

## 🔧 Deep dive 2: Make long tasks usable without losing their meaning — 9 minutes

A long task stresses two different systems: the terminal accumulates output, and
the model repeatedly receives a growing conversation. Solving one does not solve
the other.

I would keep a durable record of the task and select a bounded working context for
each model request. The UI independently decides how much of that record to show.

For the model, retain the current goal, explicit constraints, recent complete
exchanges, and relevant file evidence. Large or stale tool outputs can become
references to local artifacts, with targeted retrieval when needed.

For the terminal, show a bounded preview of long logs and a way to inspect the full
artifact. State clearly whether output was truncated. A short preview cannot prove
that an unseen section contains no error.

### Preserve intent while reducing context

Suppose the user said at the beginning, “Keep the public API unchanged.” Twenty
messages later, a last-N-messages policy may discard that constraint while keeping
pages of build output.

A compact task summary can preserve that instruction and the decisions already
made. It should remain linked to the original history and be treated as fallible.
The runtime's permission state stays authoritative outside that summary.

The summary must not promote instructions found inside a source file into trusted
user instructions. It also must not discard tool-use records while leaving their
results orphaned in the provider conversation.

Summarization itself consumes a model call and context. Trigger it before the
request becomes oversized, and retain enough budget for the summary response.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Selected context plus durable task history | Bounded input with recoverable evidence | Retrieval and summary management |
| ❌ Send the entire transcript every time | Simple early implementation | Growing cost and abrupt context failure |
| ❌ Keep only a fixed recent message count | Cheap and predictable | Can forget user constraints and protocol links |

The selected-context approach may require rereading files. That is acceptable:
file contents are often re-derivable, whereas a lost user restriction is not.
Use current revisions when retrieving code; an old cached result is not today's
workspace just because the task still references the same path.

### Bound the renderer

An incremental transcript lets the user read early output without redrawing every
historical line. Buffer a small active tail for incomplete formatting and fall back
to plain text for malformed or oversized content.

Batch text writes and respect output backpressure. A slow terminal or redirected
pipe should not create an unlimited in-memory queue.

Transient spinner updates can be coalesced. Approval requests and authoritative
operation outcomes must retain their identity and order. Tool workers never emit
terminal controls directly into the active prompt.

Sanitize control sequences in model text and command logs. Otherwise untrusted
output could move the cursor and make generated text resemble an application prompt.

A full TUI framework remains an option if persistent panes or navigation become
requirements. It is not inherently too slow; a transcript is simply sufficient for
the initial sequential workflow and preserves familiar scrollback.

### Bound the task as well as each request

The coordinator enforces total model usage, elapsed time, tool concurrency, and
output budgets. A fixed iteration cap alone cannot bound a single huge read or a
long-running command.

Repeated failures can trigger a pause, but include the relevant input revision.
Running the same test after changing code is a useful new attempt.

The UI exposes budget exhaustion as an incomplete task with completed effects and
remaining work. It should not print a success banner merely because the model loop
stopped generating output.

## 🔧 Deep dive 3: Cancel, crash, and resume without inventing certainty — 8 minutes

> “I would define cancellation as stopping further work and reconciling what
> already happened. The task may have changed three files before the developer
> interrupts it. Those changes do not disappear when the spinner stops.”

An interrupt asks the runtime to cancel model requests and owned processes. The UI
enters a cancelling state while completed and running operations are reconciled.

Every event retains its task ID. A delayed result from the old task cannot complete
a new request or answer a different approval prompt.

The recovery record needs operation intent and state, not just chat text. Pending,
approved, running, succeeded, failed, and unknown are useful distinctions.

A crash with an operation marked running is the difficult case. We inspect effects
before deciding whether it can be retried.

### Recover a file edit

A proposed replacement records the before and after revisions. Write the prepared
content separately and install it atomically on the same filesystem. If durability
across power loss is required, define the necessary flushing behavior as well.

After restart, a file matching the intended after revision is evidence that the
replacement is present. A file matching neither revision requires conflict handling,
not blind overwrite.

Atomic replacement prevents partial single-file content. It does not turn a refactor
across ten files into one transaction. Record each outcome and preserve the diff.
Restoring assistant changes must not erase unrelated developer work.

### Recover a command

A read can be repeated as a fresh observation. A command may have modified a local
service or sent a network request before its response was lost.

A local journal cannot atomically commit arbitrary external effects. If the outcome
is unknown, inspect the external state or request a new decision before retrying.
An empty result is not proof that nothing happened.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Reconcile operations by effect | Avoids silently repeating consequential work | Some outcomes remain unknown |
| ❌ Retry every unfinished operation | Fast-looking recovery | May execute an effect twice |
| ❌ Restore only the transcript | Easy persistence | Runtime lacks authority and operation state |

The cost is that recovery sometimes pauses. That pause should explain what is known,
what is uncertain, and what evidence would resolve it.

### Reconstruct the task

On resume, load the workspace identity, user constraints, operation records, and
complete model exchanges. Revalidate pending proposals because files and policy
may have changed while the application was closed.

The frontend reconstructs its transcript from events and renders for the current
terminal width. It does not replay old spinner frames or assume historical test
results validate the current checkout.

Provider retries also need attempt identity. If some response text was shown before
a disconnect, a retry may generate a different continuation. Label the attempt and
retain the completed operation records instead of replaying tools from scratch.

This is why saving a JSON conversation and having a `--resume` flag are not enough.
The restored state must reach both the agent and the interface that reports its
progress.

## 🧪 Verify the boundaries — 4 minutes

I would use a deterministic provider for repeatable failure scenarios, then verify
the real adapter's protocol separately. A mock that always returns prose before a
tool call will never expose a bug in handling tool-only responses.

The most important end-to-end tests are:

1. Stream partial arguments; no tool runs until the complete operation is validated.
2. Return only a tool call; preserve its record and matching result on the next call.
3. Change the target while its proposal is displayed; reject the stale approval.
4. Interrupt after an edit but before result persistence; reconcile the saved state.
5. Lose a command response; retain an unknown outcome instead of automatic replay.
6. Compact a long task; preserve its explicit user constraints and valid exchanges.
7. Resume in another terminal; restore the correct workspace and task state.
8. Slow stdout or deliver late events; keep approvals and task identity correct.

I would also test plaintext output and keyboard-only use. Color improves scanning
but cannot be the sole indication that a tool failed or needs a decision.

Operational measurements separate provider wait, tool time, approval wait, and
rendering delay. Useful traces identify operations and outcomes without uploading
raw source or secrets as default telemetry.

For growth, improve targeted retrieval and resource bounds before introducing more
concurrent tasks or remote infrastructure. A later GUI can reuse the same event,
proposal, and recovery contracts with a different renderer.

## ⚖️ Decisions to leave on the whiteboard

| Decision | Choice | Cost accepted |
|----------|--------|---------------|
| Actions | ✅ Concrete proposals with enforced scope | More state than a simple confirmation |
| Long tasks | ✅ Selected context and durable history | Retrieval and summary overhead |
| Recovery | ✅ Per-operation reconciliation | Explicit unknown and conflict states |
| Interaction | ✅ Ordered events with one input owner | Deliberate prompt scheduling |

> “The end-to-end design connects user intent to a concrete proposal, authorized
> execution, and an observed result. Bounded context keeps the task coherent,
> a readable transcript keeps the developer informed, and recovery preserves the
> difference between what the model intended and what the tools actually did.”
