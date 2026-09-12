# AI Code Assistant — Frontend System Design

*A 45-minute conversation about the terminal interface for a coding agent.*

This is a proposed design. The repository implements a simpler readline CLI with
complete-response output; streaming, diff approval, and task cancellation below
are design choices to explain, not claims about existing features.

## 📋 Clarify the workflow — 5 minutes

> “I would start with a developer asking the assistant to fix a failing test.
> They need to understand what it is doing, inspect proposed changes, and regain
> control if it gets stuck. The interface is a terminal, so my frontend concerns
> are input ownership, readable output, and truthful task state.”

I would establish three assumptions with the interviewer:

1. The developer works in a local checkout and can also edit files outside the CLI.
2. A task can contain several model calls and local tool operations.
3. Some operations require approval, and the developer can cancel an active task.

The first version supports text requests, incremental replies, tool status,
change previews, and resuming a saved task. I would postpone split panes, embedded
images, and a plugin widget system until the basic workflow is dependable.

The key experience is a sequence the user can follow:

- The request was accepted.
- The agent is gathering evidence or waiting for the provider.
- A concrete operation needs a decision, if applicable.
- An operation succeeded, failed, or has an uncertain outcome.
- The task ended with an explanation of changes and validation.

A spinner only communicates activity. It cannot establish that a file was changed
or a test passed. Those statements must come from tool outcomes.

I would target immediate local acknowledgement, within roughly 100 milliseconds.
Provider first-output latency is measured separately. The frontend cannot promise
that a remote model will always begin responding in half a second.

For accessibility, text labels carry status even without color. We need a usable
plain-output mode and testing with actual terminal/screen-reader combinations.
Terminal title escape sequences are not a general accessibility announcement API.

## 🏗️ Draw the interface boundary — 5 minutes

I would draw one small diagram:

```
┌──────────────┐       ┌──────────────────┐       ┌─────────────────┐
│ Input owner  │──────▶│ Task controller  │──────▶│ Agent runtime   │
└──────────────┘       └────────┬─────────┘       └────────┬────────┘
                               │                          │ events
                               ▼                          ▼
                      ┌──────────────────────────────────────────┐
                      │ Transcript state + terminal renderer     │
                      └──────────────────────────────────────────┘
```

The runtime decides what has happened. The frontend turns its events into a
transcript and sends user decisions back. Neither a renderer nor an approval
button gets to declare a tool successful.

The input owner knows whether keystrokes belong to the composer, an approval,
or a cancellation decision. Independent components must not compete for stdin.

The task controller tracks identity and lifecycle. Every runtime event includes
the task it belongs to, so late events from an interrupted task cannot change the
status of a newly started one.

The transcript stores assistant text, tool events, and decisions as different
kinds of records. Rendering them all as undifferentiated chat would make generated
claims look like authoritative execution evidence.

The renderer owns stdout and transient terminal controls. Workers publish events;
they do not print directly over an input prompt.

I would begin with a scrolling transcript and one active input region. A full TUI
framework can support richer interaction, but it adds layout and focus decisions
that this initial workflow does not require.

## 💾 State and event contracts — 4 minutes

The interface has durable task facts and temporary presentation state.

| State | Owner | Example |
|-------|-------|---------|
| Task outcome | Runtime | Running, completed, cancelled, budget exhausted |
| Operation outcome | Runtime | Pending approval, running, failed, unknown |
| Transcript | Event-backed client state | Text and linked tool results |
| Draft input | Input owner | A partially typed request |
| Active approval | Input owner plus runtime identity | Proposal ID and displayed revision |
| Rendering buffer | Renderer | Partial line and incomplete formatting |

I would keep rendering buffers out of the durable transcript. A crash should not
restore half an ANSI escape sequence or a spinner frame as conversation content.

A minimal event contract contains task ID, event sequence, event kind, and its
payload. Tool events also contain an operation ID. The sequence supports replay
without duplicating completed transcript entries.

Text arriving from the model is provisional until that response finishes. The UI
can display it immediately while retaining its interrupted/completed status.

Approval responses identify the proposal and its revision. A plain unqualified
“yes” crossing an asynchronous boundary is not a sufficient execution contract.

For a local in-process prototype, these events need no network protocol. The same
separation still prevents rendering code from accumulating execution policy.

## 🔧 Deep dive 1: Stream useful text without taking over the terminal — 10 minutes

> “I would use incremental transcript rendering with bounded buffering. The goal
> is for the user to read progress while retaining normal terminal scrollback.
> I would avoid redrawing the entire conversation for every arriving fragment.”

Provider chunks are not semantic units. A chunk can end halfway through a word,
a formatting marker, or a tool argument. Rendering cannot assume one event equals
one line or one complete action.

I would accumulate text into a small active buffer and flush on a short interval
or a completed line. This makes output responsive without requiring one terminal
write per token.

The renderer tracks incomplete fences and inline formatting. Completed lines can
be committed to scrollback. A small active tail may be repainted while its format
is still ambiguous.

There is an explicit limit on that tail. A model could emit a very long line or
never close a code fence. We fall back to readable plain text instead of retaining
an unbounded formatting buffer.

Syntax highlighting is an enhancement. An unrecognized language or malformed
fence should still produce readable code. I would not block the entire response
waiting for a perfect parse.

For a large markdown table, terminal width limits matter more than faithfully
recreating browser formatting. A readable row-oriented presentation is an
acceptable fallback when columns will not fit.

### Compare the alternatives

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Incremental transcript | Early reading, normal scrollback | Limited revision of old output |
| ❌ Wait for complete response | Simple formatting | Long silence during generation |
| ❌ Full-screen interface for the first version | Rich navigation and panels | More focus, layout, and terminal-state complexity |

The full-screen alternative does not inherently flicker, and a framework is not
inherently slow. It is less attractive here because our first workflow is mostly
a sequential conversation. If users need persistent file panes and many concurrent
tasks, I would revisit that choice.

The cost of committing text to scrollback is that earlier formatting cannot always
be repaired. A response interrupted halfway through a sentence also remains
visible. I would mark it interrupted instead of pretending it never appeared.

### Handle slow output and large logs

A local terminal is usually fast, but an SSH connection or redirected pipe can be
slow. If we ignore output backpressure, queued text can grow without bound even
though individual chunks are small.

The renderer batches output and respects the destination's ability to accept it.
Repeated transient progress updates can be coalesced. Approval requests, errors,
and final operation outcomes must retain their ordering and identity.

Large tool logs need a separate policy: show a short bounded preview and provide
a path to the complete local artifact. The transcript records that truncation
occurred. It must not silently turn “first ten lines shown” into “all tests passed.”

Display limits and model-context limits are different. Hiding a log in the UI
should not imply that sending the entire log to the model is acceptable.

### Terminal capability and untrusted output

Detect whether the output is interactive before using cursor movement or spinners.
Plain output should contain stable text records, useful in a saved transcript.
Color and Unicode can improve display but need fallbacks.

Measure display width rather than string length: wide characters, combining
characters, and embedded styling affect cursor placement. On resize, repaint the
active region within the new width without rewriting all historical scrollback.

Treat model text and command output as untrusted terminal content. Filter control
sequences so a log cannot move the cursor and impersonate an approval prompt.
Only the renderer should emit the terminal controls used for UI structure.

The performance question is therefore about bounded work and output ownership,
not a speculative token-per-second threshold at which terminals stop working.

## 🔧 Deep dive 2: Make an approval mean one understandable thing — 9 minutes

Consider an edit to the authentication module. A prompt that shows only the file
path leaves the developer unable to evaluate the change.

I would display the operation, target, relevant diff, and approval scope. If the
diff is large, the user can inspect the full proposal before deciding. Truncation
must be visible, and hidden content must remain inspectable.

For a command, show the command, working directory, and requested access. A label
such as “run tests” is insufficient because repository scripts can do more than
their names imply.

The available decisions should have distinct meanings:

- Approve this exact proposal once.
- Grant a clearly described scope for the current task or session.
- Deny the proposal.

A broader grant is an explicit choice, not an interpretation of “yes.” The user
should be able to inspect and revoke it later.

### Own the prompt, not necessarily every background operation

While an approval is active, it owns interactive input and the visible decision
region. Ordinary progress from independent work can be buffered or summarized.
The user must not see a different proposal silently replace the one they read.

The runtime can continue independent authorized reads if they do not invalidate
the proposal. There is no fundamental need to halt all computation merely because
stdin is waiting for a decision.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ One visible, identified approval | Clear decision and scope | Serializes human decisions |
| ❌ Overlapping unqualified prompts | Easy to emit from workers | Keystrokes can approve the wrong operation |
| ❌ Prompt for every small read | Simple policy presentation | Repetition encourages habitual approval |

An asynchronous queue can be correct if it preserves identity and focus. The
problem is uncontrolled overlapping prompts, not asynchronous programming itself.

### Revalidate what the user saw

Suppose the user opens the file in an editor while reading the proposed diff.
The frontend sends approval for the displayed revision. The runtime checks that
the operation still matches and the target has not changed underneath it.

If it changed, the proposal becomes stale and must be refreshed. The old approval
cannot silently authorize a different replacement.

This matters even with a single agent. The human editor, a formatter, or a build
watcher can modify the workspace independently.

A resolved approval event closes the prompt. Duplicate keypresses or replayed
responses cannot execute the proposal twice; the runtime enforces the transition.
The UI disables a resolved decision and presents the resulting operation status.

### Keep the policy boundary visible

The frontend presents and collects a decision. It does not replace enforcement.
A malicious repository can contain text asking the model to access credentials;
that text never becomes a user approval just because it appears in the transcript.

The trade-off is additional state around proposal identity and revision. For an
interface that can change the user's files, this state is part of correctness,
not merely dialog styling.

## 🔧 Deep dive 3: Cancellation and recovery must describe actual effects — 8 minutes

> “Cancel is a request to stop future work. It is not a promise that the workspace
> returned to its starting state. The UI needs to explain that distinction through
> concrete operation outcomes.”

I would define a first interrupt as cancellation of the active task. A separate
exit action can close the application. Exact key behavior should be visible in
help and consistent across the supported terminal adapters.

The task enters a cancelling state while the runtime stops model requests and
owned child processes. The UI stays responsive, but it does not immediately mark
all operations cancelled.

Some operations may already have finished. Others may have produced effects before
being terminated. A network command can even have an unknown outcome after its
local process disappears.

| Situation | What the UI should say |
|-----------|------------------------|
| Edit completed before cancellation | File changed; show the recorded diff |
| Proposal never executed | Cancelled before execution |
| Test process stopped midway | Test run interrupted; no passing result |
| Command outcome cannot be established | Outcome unknown; inspect before retrying |

An optimistic “everything cancelled” message is simple but can hide work that
already happened. Waiting forever for certainty is also poor interaction. Present
known outcomes and identify remaining uncertainty.

### Resume from facts rather than repainting an old screen

On resume, reconstruct the task from stored events. Restore its workspace identity,
request, completed operations, and outstanding state. Recompute the terminal layout
for the current window.

Old pending approvals need revalidation. Files and policies may have changed since
the session was saved. The interface should show a new proposal when needed.

A resumed transcript is historical evidence. It does not mean old file contents
are current or an old test run validates today's working tree.

If the runtime cannot restore context, the UI should not claim seamless resume.
Showing an archive is still useful, but continuing the task requires the original
constraints and operation state to reach the agent.

### Error handling without losing the next request

Provider errors leave the user's draft and visible transcript intact. A retry
starts a new response attempt linked to the same task, rather than silently
appending duplicated text to the prior attempt.

Output after cancellation is tagged to its original task. New user input cannot
inherit an earlier task's approval or completion event.

For plain input from a pipe, interactive approval cannot depend on a hidden prompt.
The runtime should report that a decision is required or use an explicitly supplied
policy; end-of-input is never interpreted as consent.

These choices cost more state than a simple readline loop, but they make failures
understandable and prevent an interface event from triggering the wrong effect.

## 🧪 Verification and growth — 4 minutes

I would test the boundaries where rendering and execution can disagree:

1. Split formatting markers and long lines across arbitrary stream chunks.
2. Slow stdout while tool completion and approval events arrive.
3. Resize during output, including wide and combining characters.
4. Deliver two proposals and repeated input; only the intended one is approved.
5. Change a file while its diff is awaiting approval.
6. Cancel during an edit or command, then restore the task from its saved record.
7. Replay events and confirm that text and operation outcomes are not duplicated.
8. Use plain output, keyboard-only interaction, and actual screen-reader setups.

A mock event source makes these scenarios deterministic. It does not replace
end-to-end testing of the real provider adapter and executor.

The first growth issues are likely large outputs, long transcripts, and interrupted
state transitions. I would measure memory, prompt responsiveness, rendering delay,
and cancellation completion before adding a richer interface.

A future GUI could reuse the task events and approval contract. Its components and
virtualization would differ, but the execution facts should remain the same.

## ⚖️ Decisions to leave on the whiteboard

| Decision | Choice | Cost accepted |
|----------|--------|---------------|
| Rendering | ✅ Incremental transcript | Limited correction of historical formatting |
| Approval | ✅ One identified proposal in focus | Serial human decisions |
| Cancellation | ✅ Reconcile individual outcomes | More states than success/failure |
| Portability | ✅ Plain text baseline | Rich features depend on capabilities |

> “My frontend makes the agent understandable without treating generated text as
> proof. One input owner keeps approvals precise, bounded rendering preserves a
> usable terminal, and operation-based recovery tells the developer what changed.
> Those contracts matter more than how elaborate the terminal decoration becomes.”
