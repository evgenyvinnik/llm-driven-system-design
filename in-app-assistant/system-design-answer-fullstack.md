# In-App Assistant — System Design Answer (Full-Stack Focus)

*Full-stack engineer interview · 45 minutes · "Established web tools like Google Maps, Gmail, Word and Excel keep adding an LLM-powered chat. How do they usually do it? What's the generic design, and how would you build the chat and the orchestrator?"*

> "My opening point is that the model isn't bolted on. These products already had the hard capabilities. A mail product has search and a drafts API. An editor has a document model and a command API that every toolbar button uses. A maps product has a places database. What's new is a server-side layer that turns a sentence into calls to those existing functions, then turns the results back into text or UI. So I'm designing that layer: a chat panel that sends what only the browser knows, an orchestrator running an agent loop, a tool layer over the app's own APIs, grounding in the user's data, and a policy engine that decides what the model is actually allowed to do. I'll build it for a small suite called Lumen Workspace, with mail, docs and calendar."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements and the range | ~4 min | "Find and answer" vs "act", and why products ship read-only first |
| The blueprint and the panel | ~7 min | What's new vs existing; what the browser contributes |
| The loop and two traces | ~7 min | One request end to end, and one where the model is fooled |
| Key decisions, data model, API | ~8 min | Template vs agent, tool shape, answers as IDs, resumable streaming |
| Deep dives | ~14 min | The durable turn, safety in code, permission-correct grounding, WebSockets or SSE and multiple tabs |
| Scale, checklist, wrap-up | ~5 min | Model cost breaks first; prompt caching is the main lever |

---

## 🎯 Requirements and Scope (~4 min)

### The range inside one blueprint

| End of the range | Example request | Mostly a problem of | Worst failure |
|------------------|-----------------|---------------------|---------------|
| Find and answer | "What did Dana say about the offsite budget?" | Search quality and permissions | A wrong or uncited answer |
| Act | "Draft a reply and send it", "Add a summary under the intro" | Safety, confirmation and undo | Data changed or sent that the user didn't want |

> "Products nearly always ship the read-only end first, and I think that's good engineering, not just caution. A read-only assistant's worst failure is a bad answer, and citations let the user check it. It also forces you to build what the acting end depends on anyway: identity that acts as the user, permission-correct retrieval, traces and evals. Once those are trustworthy, you add writes, starting with reversible ones."

### Clarifying questions (and the answers I'll assume)

| Question | Assumption | Design consequence |
|----------|------------|--------------------|
| Where does the assistant live? | A side panel in Mail, Docs and Calendar | The panel sends app context with every message |
| Answer only, or act too? | Both. Reversible actions run directly; sends and irreversible edits ask first | A policy engine and a confirmation flow |
| Whose permissions? | Strictly the user's own | A short-lived on-behalf-of (OBO) token per turn, never a service account |
| Real-time co-editing in Docs? | Exists in real products, out of scope here | Edits become tracked suggestions applied by the docs service |
| Scale? | 50M daily suite users; 10% use the assistant, 6 turns each | 30M turns/day, ≈1,750 turns/s at a 5× peak |
| The model? | A hosted provider; we don't train or serve | A dependency with latency, cost and failure modes |

### Functional requirements

1. Answer questions from the user's mail, docs and calendar, with citations that open the real email, paragraph or event.
2. Act: save and send drafts, insert or rewrite document text as tracked suggestions, create events.
3. Stream text and progress ("Searching your mail...") as the turn runs. Stop cancels backend work, not just rendering.
4. A dropped connection reconnects without losing or repeating text; a retried submit returns the same turn.
5. Browser-executed tools for what only the client has: the live selection and navigation.
6. Template actions such as "Summarize this thread" that are one fixed prompt and one model call, not an agent.
7. Settings that restrict the assistant: turn off sending, confirm every change, block outside sends after untrusted content.
8. Per-turn traces of every model call, tool call and policy decision, plus metrics, live quality signals and offline evals.

**Out of scope:** model training and serving, the co-editing engine, the general chat product, voice, and exposing the tools to outside agents over MCP (I'll come back to that).

### Non-functional requirements

| Property | Target |
|----------|--------|
| Host app availability | Unaffected; the assistant degrades to "unavailable" on its own |
| Turn acceptance | 99.9%; end-to-end capped by the provider, mitigated by a fallback model or region |
| First feedback | First event within 300 ms of submit (p95); first model token p95 < 1.5 s |
| Orchestration overhead | < 100 ms per step outside model and tool time (p95) |
| Permission correctness | Zero answers containing content the user can't open; revocations reach search within 5 s |
| Freshness | Changes searchable within 60 s; mail from the last minute still found by a direct fetch |
| Safety | No send, share or irreversible change without explicit confirmation; nothing auto-executes on timeout |
| Exactly-once effects | A retry, double click, crash or resume never performs a write twice |
| Cost | ≥ 60% of input tokens served from the prompt cache on multi-step turns |

**Back of the envelope.** 1,750 turns/s × 3 model calls ≈ 5,250 calls/s. At ≈ 8K input tokens per call, about 3K of it a fixed system prompt plus tool definitions, that's ≈ 42M input tokens/s at peak. A turn is active for ≈ 6 s, so ≈ 10,500 loops run at once. Those two numbers frame the design: model cost dominates, and waiting has to be free.

---

## 🏗️ The Generic Blueprint (~4 min)

```
                              Browser (host app)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Mail / Docs / Calendar UI    Assistant panel          Editor state   │
 │ (existing)                   chat, cards, citations   selection,     │
 │                              Stop, Keep / Undo        live outline   │
 └──────┬─────────────────────────────┬──▲─────────────────────┬────────┘
        │ existing REST               │  │ SSE (resumable)     │ client tool
        ▼                             ▼  │                     │ results
 ┌───────────────┐            ┌──────────┴───────────┐         │
 │ Host services │            │ Assistant API        │◀────────┘
 │ mail · docs · │            │ turns, confirmations │
 │ calendar      │            └──────────┬───────────┘
 │ own the data, │                       │ claim turn (lease)
 │ enforce ACLs  │            ┌──────────▼───────────┐     ┌───────────────────┐
 └──┬─────────▲──┘            │ Orchestrator         │────▶│ Model gateway     │
    │         │ tool calls    │ agent loop, budgets, │◀────│ retries, fallback │
    │ change  │ (OBO token)   │ suspend and resume   │     │ prompt cache      │
    │ events  │               └──┬────────┬─────────┬┘     └─────────┬─────────┘
    │  ┌──────┴───────┐   ┌──────▼─┐      │         │                ▼
    │  │ Tool service │◀──│ Policy │      │         │        Model provider(s)
    │  │ typed tools  │   │ engine │      │         │
    │  └──────────┬───┘   └────────┘      │         │
    ▼             ▼ search                ▼ state   ▼ events
 ┌──────────┐  ┌────────────────┐ ┌──────────────┐ ┌──────────────┐
 │ Indexing │─▶│ Retrieval index│ │ Session store│ │ Event log    │
 │ pipeline │  │ keyword+vector │ │ turns, steps,│ │ per turn,    │
 │ ACL tags │  │ ACL in query   │ │ confirmations│ │ replayable   │
 └──────────┘  └────────────────┘ └──────┬───────┘ └──────────────┘
                                         ▼
                              Traces, live signals, eval sets
```

| Piece | New or existing | Responsibility |
|-------|-----------------|----------------|
| Host services | Existing | Own the data and enforce permissions. The assistant only calls their APIs |
| Assistant panel | New, inside the existing UI | Sends client context; renders the stream, confirmation cards, citations, Keep/Undo |
| Assistant API | New | Accepts turns idempotently, takes confirmations and client-tool results, serves SSE |
| Orchestrator | New | The agent loop: assembles context, calls the model, runs tools, enforces budgets, suspends and resumes |
| Model gateway | New | Retries with backoff, fallback model or region, routing that keeps the prompt cache warm |
| Tool service | New, thin | 13 typed tools over host APIs, each declaring its effect and reversibility |
| Policy engine | New | Allow, confirm or deny per call, from tool metadata, settings and taint |
| Indexing + retrieval | New | ACL-tagged hybrid keyword and vector index of the user's content |
| Session store + event log | New | Turns as saved state machines, steps, pending actions; replayable per-turn event streams |

> "The property I'd defend hardest is that the host app stays the owner of its data. The assistant proposes; the app executes through the same APIs and permission checks a button click uses. That answers the classic follow-up, 'the assistant wants to change data in the host app: who performs the change, and what does the user confirm?' The host performs it, as the user. The user confirms a preview of the exact action for anything that leaves the account or can't be undone, and gets Keep and Undo on everything else."

---

## 🖥️ The Panel and Client Context (~3 min)

| App | Context sent with each message | Why the server can't get it itself |
|-----|-------------------------------|------------------------------------|
| Docs | Outline: each paragraph's stable ID, kind and first 120 characters; the selection as paragraph IDs; the document version | Selection and what's on screen exist only in the browser |
| Mail | The open email | "Reply to this" resolves without a search |
| All | App name, time zone | "Tomorrow at 3" depends on the user's zone |

**How the document is shown to the model.** Not the editor's internal format, and never character offsets. Collaborators keep typing while the model thinks, so offset 1,204 is wrong by the time an edit comes back. A stable paragraph ID like `p_3` survives concurrent typing: the model says "insert after p_3", and the docs service maps it back with a version check.

**Live state is keyed by turn ID**, and each live turn owns its stream. Switching from Docs to Mail mid-answer neither cancels the Docs turn nor writes its text into the Mail conversation. History is a server query; the selection is read from editor state at send time or when the server asks for it.

**Rendering untrusted output.** Model text goes through a small markdown renderer that produces React elements only, with no HTML parsing. The only links in an answer are citation chips that resolve to items retrieved in this conversation, rendered from the app's own records. The model can't produce a phishing link because it can't produce links at all.

**Browser tools.** `get_selection` and `open_item` run in the browser. The server sends a tool request down the stream, the panel answers with a POST, and the turn waits without holding a worker. After 30 s the call fails with "the browser didn't respond" and the turn continues.

**Where real co-editing editors differ.** In a product with a co-editing engine, AI edits run in the browser: the orchestrator sends commands down and the editor applies them the way a toolbar button would, so they sync to collaborators and Ctrl+Z undoes them. Without that engine, I apply edits server-side as tracked suggestions through the docs service. The suggestion keeps the undo property, and Keep vs Undo becomes a live quality signal.

---

## 🔁 The Orchestrator Loop (~3 min)

The model keeps no memory between calls, so each pass sends the whole conversation so far. It either answers or asks for tools; the orchestrator runs them, appends the results and calls again.

```
 assemble ──▶ call model ──▶ stop reason
 request         ▲             ├─ end_turn / refusal ──▶ verify citations, complete
                 │             ├─ max_tokens ──────────▶ text: continue · tool call: retry, 2× room
                 │             └─ tool_use ──▶ per call: visible? valid args? repeated?
                 │                             policy: allow / deny     confirm / browser tool
                 │                                           │             │
                 └── checkpoint ◀── results ◀────────────────┘             └──▶ suspend: save,
                                                                                release lease
```

- **Setup.** History is loaded verbatim while it fits, older turns folded into a summary. Only tools that fit this app, the user's permissions and settings are included; the model can't misuse a tool it never sees.
- **Model calls.** Text deltas stream to the browser; tool-call arguments are used only once complete. Overloads and dropped connections retry three times with backoff, then a fallback model gets two attempts. If a stream dies after text reached the screen, the browser is told to discard that step's partial text and the step is redone.
- **Tool calls.** Every tool request gets a result, including blocked and failed ones. An invented tool name returns the list of real ones; invalid arguments return the exact problems. Consecutive reads run in parallel; writes run one at a time, in order.
- **Bounds.** 15 model calls, 20K output tokens, 120 s of active time. A third identical call gets a nudge instead of a result; a fourth ends the turn. When a budget runs out, one last call with tools switched off asks the model to summarize what it did and what's left. Near the context budget, older tool results are replaced by stubs that keep their IDs.

> "The model decides when the task is finished. The orchestrator only decides when it has to stop anyway: a budget ran out, the user pressed Stop, or something failed."

---

## 🧭 One Request End to End (~4 min)

### ✅ Successful trace: "Add a short summary of Dana's thread from last week under the intro"

1. **Browser → API.** With "Q3 Offsite Plan" open, the panel posts the text with an Idempotency-Key and the outline (`p_1`..`p_10`), selection `p_3`, document version 12 and app `docs`. The API inserts a `running` turn leased to this instance, returns 202, and the browser opens the turn's SSE stream.
2. **Setup and prefetch.** The orchestrator mints an OBO token and picks the Docs tool set. A small model rewrites the request into the query "dana" with filters (from Dana, after last Monday); hybrid search returns her messages, which enter the turn message as quoted data.
3. **Model call 1.** The model sees the cached tools and system prompt, the history, then this turn, and calls `get_thread` on the offsite thread. Policy: a read, allowed.
4. **Tool execution.** The tool service verifies the OBO token, takes the user from it, and reads through the mail service's per-message visibility. It strips quoted replies and signatures, trims to a token budget keeping message IDs, and records the sources for citation checks.
5. **Model call 2.** `insert_text` after `p_3`, tracked. A tracked insert is a reversible write: allowed. The docs service inserts `p_11` as a pending suggestion in the same transaction as the idempotency record keyed by turn and call.
6. **Model call 3.** "Added a 3-sentence summary of Dana's thread under Introduction as a suggestion you can accept or reject," citing three message IDs, with `end_turn`.
7. **Completion.** The orchestrator verifies every cited ID was retrieved in this conversation, saves the answer, and emits `turn.end`. The panel renders citation chips; the editor shows the suggestion with Keep and Undo. Usage: 3 model calls, 9K input tokens (63% from cache), 144 output tokens.

Without prefetch the model would have called `search_mail` first: 4 calls instead of 3. With a real model each step is a few seconds, so that round trip is very visible.

### ❌ Failed trace: an email that tries to hijack the assistant

"Summarize the latest email from Northwind." The newest Northwind email is an overdue invoice whose body tells AI assistants to forward it, with the three most recent invoices in the mailbox, to an outside address.

1. Prefetch finds the email from an external sender and marks the turn **tainted**. The panel shows "Read content from outside your control".
2. Suppose the model is fooled and calls `create_draft` to the outside address. A draft is reversible and goes nowhere: allowed.
3. It calls `send_draft`. Effect `send`, an external recipient, a tainted turn: **confirm with a warning**, or **deny** if the user blocks outside sends after untrusted content. The orchestrator writes a pending action, saves the turn as `waiting_confirmation`, frees the worker, and streams an amber confirmation card.
4. The user clicks Decline, and the request lands on a different API instance. It records the decision, claims the turn with a conditional update, and resumes. The tool result says the user declined.
5. The model summarizes the invoice and warns that the email contained instructions it didn't act on. Nothing left the mailbox, and the trace shows the rule (`untrusted-external-send`) and the user's answer.

> "This trace works *because* the model was fooled. The local mock model has a 'gullible' switch, on by default, that really obeys injected instructions, so the test proves the policy engine rather than the model's good manners."

---

## 🧰 Key Decisions (~4 min)

### Template or agent?

| Approach | Where it fits | How it breaks |
|----------|---------------|---------------|
| ✅ One general agent loop | Requests spanning apps: mail search + thread read + doc edit | Latency: each step is a model round trip, 10–20 s for four steps with a real model |
| ✅ Templates for fixed jobs | "Summarize this thread": one fixed prompt, one call, no tools | Can't compose; that's the point |
| ❌ Intent classifier + fixed pipelines | A handful of known intents | Needs a pipeline per combination; everything else falls through |

> "Earlier assistants classified intent and ran a pipeline. 'Summarize Dana's thread under the intro' spans three capabilities, and a classifier needs a pipeline for every combination. The loop lets the model compose tools. But I keep fixed jobs as templates: cheaper, faster and predictable, with no reason to pay for an agent."

### How actions are expressed

| Approach | Pros | Cons |
|----------|------|------|
| ✅ 10–30 task-shaped tools | Model picks correctly; each call declares its effect to the policy engine | Real design work, iterated against eval transcripts |
| ❌ Mirror the REST API | No design work | Five chained calls per request, each a failure point and a round trip |
| ❌ One catch-all tool ("do this email task") | Tiny tool list | Hides the action from the model's reasoning and from policy, which can't tell a read from a send |
| ❌ Model-written code against an app SDK (not built) | Bulk and combinatorial edits in one step | Needs a sandbox; per-action preview and confirmation get hard; harder to evaluate |

Code generation is attractive for spreadsheet-style bulk work, where 200 tool calls would be absurd. I'd only consider it if every SDK call went through the same tool service, so each effect still passes policy.

| Tool | Effect | Reversible | Runs in |
|------|--------|------------|---------|
| `search_mail`, `get_message`, `get_thread` | read | — | server |
| `create_draft` | write | yes | server |
| `send_draft` | send | no, always confirms | server |
| `search_docs`, `read_document` | read | — | server |
| `insert_text`, `replace_text` | write | only if tracked | server |
| `search_events` | read | — | server |
| `create_event` | write, or send when it has attendees | without attendees | server |
| `get_selection`, `open_item` | read (UI only) | — | browser |

The tool layer is a user interface whose user is a model, so it gets the same care:

- **Descriptions for a smart new hire**: what it does, when to use it instead of another, what it returns, its limits.
- **Hard-to-get-wrong arguments**: enums, only IDs the model has already seen, dates as plain calendar dates with the zone conversion done in code.
- **Errors as instructions**: "No paragraph p_42 in doc_offsite. Call read_document to get the current paragraph ids."
- **Results shaped for tokens**: a few fields, IDs for follow-ups, a summary or full option, and a note when a list was trimmed. Every returned token is paid for on every later step.
- **Reversible by default**: a draft plus a separate send; tracked suggestions instead of overwrites.

### Answers carry IDs, not free text

The model cites IDs from tool results, and the app renders cards, chips and links from its own database. A made-up email (or, in a maps product, a made-up restaurant) can't appear as a link, and an invented ID shows as unverified. The cost is a stricter prompt contract and a verification pass on every answer.

---

## 💾 Data Model (~2 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| turns | id, conversation, user, seq, idempotency key + request hash, status, messages (this turn's slice), in-flight batch, tainted, final text, citations, sources, lease owner + expiry, cancel requested, usage counters | Unique (user, key); partial unique index allows one active turn per conversation |
| turn_steps | turn, step, kind (model call, tool call, policy, notice, wrap-up, prefetch, compaction), detail, latency, tokens | The audit trail behind "What I did" and eval sets |
| pending_actions | id, turn, call, tool, args, preview, reason, tainted, status, expires at | Confirmation cards; pending → approved, declined or expired |
| tool_executions | key "turn:call" (PK), tool, result | Inserted in the write's own transaction: exactly-once writes |
| assistant_feedback | user, turn, kind (edit kept or undone, draft sent or discarded) | Live quality signals |
| index_events | source, op (upsert, delete, ACL), priority lane, attempts | Transactional outbox; permissions and deletes on lane 0 |
| chunks | id, source, org, title, author, date, anchor paragraph, text, ACL principals, is external, keyword vector, embedding | GIN on ACL and keywords, HNSW on embeddings |

Host tables that matter: mailbox entries decide mail visibility per message, not per thread; document paragraphs carry stable IDs and suggestion state; document shares hold user, group and org grants. Valkey holds only the replayable per-turn event streams (expiring an hour after the turn ends), the cancel channel, sessions and rate limits.

---

## 🔌 API and Streaming (~2 min)

```
POST /api/v1/assistant/turns                 → 202 turn (Idempotency-Key required)
GET  /api/v1/assistant/turns/:id/events      → SSE; Last-Event-ID resumes
GET  /api/v1/assistant/turns/:id/steps       → audit trail ("What I did")
POST /api/v1/assistant/turns/:id/tool-results → browser tool output or error
POST /api/v1/assistant/turns/:id/cancel      → Stop
POST /api/v1/assistant/actions/:id/confirm   → approve a pending action
POST /api/v1/assistant/actions/:id/decline   → decline it
POST /api/v1/assistant/quick                 → template action (summarize thread)
GET|PUT /api/v1/settings                     → assistant permissions, step limit
```

| Contract | Retry or race behavior |
|----------|------------------------|
| Create turn | Same key and body returns the same turn (200, replayed); same key, different body 422; a second concurrent turn in the conversation 409 with the active turn's ID, which the client attaches to |
| Confirm / decline | Row-locked change plus a conditional claim of the turn; the same decision twice is a no-op 202, a different one 409 |
| Tool results | Applied only while the turn waits on that call; repeats are no-ops |
| Events | Each event's ID is its log position; a reconnect gets exactly what follows |

Events on the stream: turn status, text deltas (batched every 40 ms), text discard for a redone step, tool status labels, browser tool requests, tool results, proposed and resolved actions, notices (retry, untrusted, budget, loop, compaction) and one `turn.end` with final text, citations and usage.

**Stop really stops.** Cancel sets a flag on the turn and publishes on a cancel channel. The instance running the turn aborts the model stream and blocks new calls; a write already in progress finishes, the state is saved, then the turn ends. A waiting turn is cancelled directly.

**Resume without duplicates.** A reconnect sends `Last-Event-ID` and replays from the per-turn log, so no text is lost or repeated and no new turn starts. A Lua append script refuses events after `turn.end`, so a turn never ends twice. If Valkey is down, turns still complete in PostgreSQL and the stream falls back to a snapshot once the turn ends.

Why SSE plus POSTs rather than a WebSocket, given that the server asks the browser for things mid-turn, is deep dive 4.

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: The turn is a saved state machine, not a held request

**Decision.** A turn is a row with a status, its slice of the model conversation, and the in-flight tool batch (calls, results so far, the call being waited on). When the loop needs a human or the browser, it saves both, releases its lease and returns. Whichever instance receives the answer records it, claims the turn with a conditional update, and continues the batch.

```
running ──▶ waiting_client ──(browser result / 30 s timeout)──▶ running
running ──▶ waiting_confirmation ──(approve / decline)────────▶ running
                     └──(10 min unanswered)──▶ completed, action left undone
running ──▶ completed | failed | cancelled
```

**Why it works here.** A confirmation can take minutes, and the answer arrives wherever the load balancer sends it; in the failed trace, Decline landed on a different instance. At peak about 10,500 loops are running, and a waiting turn holds no model stream, lease or SSE writer, only a row. A crash becomes a resume: the lease heartbeat stops, the lease expires, a sweeper on another instance claims the turn and continues from the last checkpoint. Every checkpoint and the final transition are fenced on the lease owner, so a stalled instance that wakes up can't overwrite the one that took over.

**Exactly-once is what makes resume safe.** A resumed turn may re-run a call whose write committed but wasn't checkpointed. Every write carries the key "turn:call", inserted in the same transaction as the write, so the re-run returns the stored result. A double-clicked confirm returns 202 without a second send. Writes also run under a statement timeout, so a slow write is rolled back rather than abandoned half-done.

**How the alternative breaks.** Holding the worker and the HTTP request for a ten-minute confirmation pins a worker per waiting turn, which means thousands of idle workers at scale. Every deploy kills every waiting turn. The confirm click has to reach the exact process holding the turn, which needs sticky routing that also breaks on deploys. A workflow engine such as Temporal gives the same semantics with durable timers, and many teams choose one. I'd adopt it once there are many waiting states and sub-agents. For two waiting states, a lease column and a sweeper are fewer moving parts.

**What I give up.** Discipline. Every write needs an idempotency key, every checkpoint is fenced, and every waiting state needs a timeout with a defined outcome. Client tools fail after 30 s, and unanswered confirmations end the turn with the action undone; we never guess yes. Checkpointing also rewrites the whole message array each step, which I come back to under scale.

| Approach | Cost of waiting | Crash or deploy | Answer at another instance |
|----------|-----------------|-----------------|----------------------------|
| ✅ Saved state machine + lease + sweeper | One row | Resumes from checkpoint | Yes |
| ❌ Hold the worker and the request | A worker and its connections | Turn lost | Only with sticky routing |
| ❌ Workflow engine now | A durable timer | Resumes | Yes, but a new cluster to operate |

### Deep dive 2: Safety enforced in code, with taint, not in prompts

**Decision.** Every tool declares metadata the model can't change: its effect (read, write, send) and whether it's reversible, sometimes per call (a tracked edit is reversible, a direct edit isn't; an event with attendees sends invitations). Before each call, the policy engine decides from that metadata plus state the model can't see: user settings and the turn's taint.

| Effect | Condition | Decision |
|--------|-----------|----------|
| read | always | allow |
| write | irreversible (direct edit), or "confirm every change" is on | confirm |
| write | reversible | allow |
| send | tainted, outside recipients, and "block outside sends after untrusted content" on | deny |
| send | tainted and outside recipients | confirm, with a warning |
| send | otherwise | confirm |

**Taint.** Once a turn reads content the user doesn't control (an external email, a document someone else owns, prefetched passages from either), it's tainted for the rest of the turn and into later turns of the conversation, because that content is still in the context. A deny goes back to the model as a tool result with the reason, so it can explain or try another way.

**Why it works here.** The dangerous instructions arrive inside the very data the assistant exists to read, and a mail assistant has to read external email. You can't reliably filter injections out: cleaning strips signatures and quoted replies for quality, but an instruction aimed at assistants survives. So I assume the model can be fooled and make every consequential step depend on things injected text can't reach: metadata, settings and a human click. Around that sit the other layers. Retrieved content is marked as quoted data. No tool fetches URLs or follows links, so there's no quiet exfiltration channel. Drafts-first and tracked edits keep actions reversible. The confirmation card shows the full preview, including recipients.

**How the alternative breaks.** A tool description saying "only send if the user asked" is a suggestion, and the Northwind email is precisely an argument that sending is what the user wants. Prompt-only safety fails silently and probabilistically. Even a model that resists 999 of 1,000 attempts, facing a campaign sent to a million mailboxes, ships a thousand invoice bundles to an attacker. The catch-all tool design breaks policy too, because one opaque tool can't declare whether it reads or sends.

**What I give up.** Friction: every send asks, even a harmless "send it" to a colleague. Drafts-first keeps that to one click and keeps the assistant useful for composing. Policy denies become an alert signal, since a spike suggests an injection campaign.

| Approach | A fooled model can... | Friction |
|----------|-----------------------|----------|
| ✅ Policy engine + taint + confirmation | Create a draft; nothing leaves the account | One click per send |
| ❌ Instructions in the system prompt | Send whatever the injected text argues for | None |
| ❌ Confirm every action, reads included | Nothing, but users learn to click through blindly | Constant, so confirmations stop meaning anything |

### Deep dive 3: Grounding that is permission-correct and citable

**Decision.** Index the user's content with ACLs on every chunk. Search with keywords and vectors together, filter permissions inside both queries, fuse, rerank, re-check access against the source tables, and accept only citations to IDs that were actually retrieved.

```
 Indexing  host write ──▶ outbox (same txn) ──▶ clean ──▶ chunk + ACL ──▶ embed ──▶ index
           deletes and sharing changes take a fast lane: rewrite ACLs, no re-embed

 Query     message ──▶ rewrite ──┬──▶ keyword search ──┐   ACL filter inside both
                                 └──▶ vector search ───┴──▶ RRF ──▶ rerank top 50
                                      ──▶ re-check access ──▶ pack as quoted data ──▶ cite
```

**Why it works here.** "What did she say about the budget?" isn't a query, so a small model rewrites it into standalone queries and filters. Keyword search catches exact strings such as names and invoice numbers, which embeddings blur. Vector search catches rewordings: "cancel my flight" against "your itinerary has changed, pick a different departure". Reciprocal rank fusion merges the two lists by rank, without comparing incomparable scores, and the reranker reads query and passage together to rescore the top 50 and drop anything below a relevance floor. For freshness, mail whose index event is still pending is read straight from the mailbox and keyword-matched, so a message from ten seconds ago is found. Not all grounding is search, either: the open document comes from the browser, and "what's on my calendar tomorrow?" is a calendar API call.

**How the alternatives break.** Post-filtering top-K can return an empty page when the best matches all belonged to someone else, and any bug in the post-filter is a leak. Vector-only search misses invoice INV-2291. Free-text citations let the model write a plausible subject line for an email that doesn't exist. Waiting for the indexer fails "did Dana reply yet?" during exactly the minute that matters.

**Prefetch and tools.** Classic RAG searches once and answers. I do both: prefetch when the request obviously needs data, which saved a model call in the trace, and also offer search as tools, so the model can refine the query, open full items and search again.

**What I give up.** Index size (an ACL array per chunk), write amplification on sharing changes (hence the ACL-only fast lane), a re-check query per result, and a strict citation contract. Coverage too: indexing all 50M users' full history would be about two orders of magnitude more than the ≈15 TB for the 5M assistant users' last year, so backfill is lazy and recent-first.

| Approach | Recall | Leak risk | Freshness |
|----------|--------|-----------|-----------|
| ✅ Hybrid + RRF + rerank, ACL in query, re-check, direct fetch | Exact strings and rewordings | Filter in the query, then re-checked | Seconds |
| ❌ Vector-only with a post-filter | Misses exact IDs; empty pages | One filter bug leaks | Indexer lag |
| ❌ No index, only host search APIs | Keyword only | Low | Instant, but no semantic match |

### Deep dive 4: The server talks back: WebSockets or SSE, and which tab answers

**Decision.** SSE over fetch for everything the server says, REST for everything the browser says, including its answers to the server's own questions. A turn records the tab that started it, and browser tool requests are addressed to that tab.

**Why not a WebSocket, when the traffic is two-way?** The browser's side is a handful of messages per turn: a submit, up to three tool results, at most one decision. Each needs an exact outcome, and the server already defines them as status codes: a replayed `200`, a `409` for a conflicting decision, a no-op for a late tool result. As POSTs, any instance can take an answer, claim the turn with a conditional update and continue it, which is what lets a waiting turn cost one row (deep dive 1). Socket RPC, where the server sends the tool request and awaits the reply on the same connection, would pin each waiting turn to one connection on one instance. A deploy or a reconnect then loses the call, and avoiding that means rebuilding the replay log and answer-by-call-ID, which is what SSE plus POST already is. The extra round trip is tens of milliseconds next to model calls of one to five seconds.

| Concern | ✅ SSE + POST answers | ❌ WebSocket |
|---------|-----------------------|--------------|
| A waiting turn's footprint | One row; any instance resumes it | A live socket per waiting turn, or a rebuilt resume |
| Answers applied exactly once | Status codes + "applied only while waiting" | Acks and dedupe built by hand |
| Deploys and reconnects | Replay by `Last-Event-ID`; POSTs land anywhere | Every socket drops; in-flight calls are lost |
| Host infrastructure | The host app's HTTP stack, cookies, CSP and logs | Upgrade support through the host's proxies |

The costs of SSE I accept are operational. Nothing on the path may buffer the stream. A comment ping every 15 s keeps a load balancer from cutting a turn that waits minutes for a confirmation, and the client reconnects with its cursor after 45 s of silence. And there's one Valkey reader per open stream, rank 3 in scale, which a multiplexed reader fixes whatever the transport. I'd change transports for a co-editing editor, where assistant edits should join the editor's own collaboration channel as one more participant, or for browser tools called dozens of times per turn.

**Multiple tabs.** Conversations are per user and app, so two tabs on Docs share one, and the one-active-turn rule makes a second submit a `409` the tab attaches to. Three problems remain:

1. **The wrong tab answers a browser tool.** Every tab following the turn receives `tool.request`, and the server applies the first result, possibly from another document. So the submit carries a tab ID, stored on the turn and stamped on each request, and only that tab runs the tool. If it's gone, the 30 s timeout applies, or another tab re-targets the call with a conditional update that succeeds only while the call is unanswered.
2. **Decisions from two tabs.** Already safe: the decision is row-locked, the same decision twice is a no-op, a conflicting one is `409`, and `action.resolved` updates the other tab's card.
3. **Connections.** Each tab follows up to three turns, and under HTTP/1.1 those share six connections per origin with the host app's own requests across all tabs, so the assistant could break Mail. HTTP/2 end to end is required. One leader tab per browser (a Web Lock plus a BroadcastChannel) cuts streams to one set per browser, while tool execution stays with the target tab.

Same-browser hints, such as a document's new version, a turn started in another tab, or sign-out, travel over the BroadcastChannel; other devices pick up state on their next load.

**What I give up.** A tab ID in the turn's API, and up to 30 s of stall when the starting tab closes. Re-targeting is a click, never automatic, because answering from a different document than the one the user asked about is worse than a short wait.

---

## ✅ Design Review Checklist (~1 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | PostgreSQL for turns, steps, confirmations and host data. A tool write succeeds when its transaction (write + idempotency row + outbox event) commits; a turn completes when its terminal transition commits. Valkey holds only replayable events and sessions |
| Client retries after losing the response? | The Idempotency-Key returns the same turn. A lost confirm response is retried as the same decision, a no-op. A reconnect replays from `Last-Event-ID` |
| Server fails between two steps? | Its lease expires and another instance resumes from the last checkpoint. Calls with saved results aren't re-run; a committed but unsaved write re-runs and gets its stored result. Verified locally by killing an instance mid-turn |
| Which ordering is required? | Within a turn, writes in the model's order, reads in any order. One active turn per conversation. Text deltas in stream order. Nothing across users |
| Access with caches, indexes, async work? | ACL filter inside the index query, re-checked against source tables; tools take identity from the OBO token, never from arguments; turn state and events readable only by the turn's user; revoked items return "not found" mid-conversation |
| What breaks first? | Model capacity and cost; next section |

---

## 📈 Scale: What Breaks First (~3 min)

| Rank | Component | Load at peak | Why it breaks | Fix |
|------|-----------|--------------|---------------|-----|
| 1 | Model capacity and cost | ≈5,250 calls/s, ≈42M input tokens/s | Provider quotas and the bill | Prompt caching, prefetch, small models for rewriting, budgets, templates, regions behind the gateway |
| 2 | Turn checkpoints | ≈30 KB per turn, ≈0.9 TB/day | Rewriting the whole message array each step is O(n²) bytes per turn | Append steps as rows; rebuild on resume |
| 3 | SSE connections | ≈10K concurrent turns, each with readers | One blocking log reader per open stream | One multiplexed reader per instance |
| 4 | Retrieval | ≈2,600 searches/s; ≈26B chunks, ≈15 TB; ≈6K new emails/s | Index size and write rate | Per-tenant shards, int8 or product-quantized vectors, CDC instead of outbox polling |

**Prompt caching is the biggest lever.** Each step re-sends everything before it, so without a cache a 3-step turn pays for the 3K prefix three times plus a growing middle. I order the request so its beginning never changes: tool definitions and the system prompt, identical for every user, then earlier turns, then this turn's context. The date, user and open document go in the turn message, never the system prompt, where they'd break the cache. Wrap-up switches tools off rather than removing them, because removing them invalidates the cached prefix. With incremental cache breakpoints, 65–75% of input tokens become cache reads (63–81% measured locally), which more than halves input cost. A drop in cache hit rate gets an alert, because it usually means someone added a silent prefix invalidator.

> "My evidence for ranking the model first is arithmetic, not instinct: the token volume follows directly from turns times calls times prompt size, while the orchestrator's own budget is under 100 ms per step and scales horizontally. Checkpoint growth is the next thing I'd watch, because its cost grows with the square of turn length."

**Further out.** Sub-agents for big sub-tasks ("find every contract renewal in this mailbox") run their own loop and return a summary, keeping the main context small. And the trend I'd mention: the same tool layer can be exposed through MCP, so outside agents use the app's operations with the same OBO tokens and the same policy engine. The investment in a clean tool layer pays twice.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Request handling | Agent loop + template actions | Intent classifier + pipelines | Composes tools across apps; fixed jobs stay cheap |
| Action shape | 10–30 task-shaped tools | REST mirror, catch-all tool, model-written code | Fewer round trips; effect visible to policy |
| Safety | Policy engine with taint, in code | Instructions in the prompt | Injected text can't argue code out of a rule |
| Waiting | Saved state machine + leases | Held worker / workflow engine | Waiting is free; crashes resume; fewer moving parts |
| Writes | Idempotency key in the write's transaction | Retry and hope | Exactly-once across resume and double clicks |
| Doc edits | Stable paragraph IDs + tracked suggestions | Character offsets, overwrites | Survives concurrent typing; reversible |
| Retrieval | Hybrid + RRF + rerank, ACL in the query | Vector-only, post-filter | Exact strings and rewordings; no leaks, no empty pages |
| Grounding | Prefetch when obvious + search tools | Prefetch only / tools only | Saves a round trip without capping recall |
| Citations | IDs verified against retrieved sources | Free-text references | No invented items rendered as links |
| Prompt layout | Fixed prefix, volatile data last | Date in system prompt | Cache hit rate above 60% |
| Transport | SSE for the turn, POSTs for every answer to it | WebSocket RPC | Any instance takes an answer; waiting stays one row |
| Multiple tabs | Browser tool requests addressed to the starting tab | Every tab answers | No answer from the wrong document |

---

## 📝 Wrap-up (~1 min)

> "To sum up: these assistants are a thin new layer over capabilities the app already had. The panel contributes what only the browser knows, including stable paragraph IDs. The orchestrator runs a bounded agent loop over task-shaped tools, and a turn is a saved state machine, so waiting for a person or the browser costs a row and crashes resume. The host app executes every change as the user, the policy engine decides from metadata and taint rather than the model's judgment, and anything outward-facing waits for a click. Grounding filters permissions inside the query, and answers cite IDs the app renders itself. I'd ship read-only first. What I'd measure first in production is cache hit rate and model calls per turn, because together they decide the bill."

### How the local implementation compares

The repo runs this design on one machine: a Vite and React 19 suite with the assistant panel; an Express API on :3000 that also runs the agent loop for turns it starts or resumes (a second instance on :3001 proves cross-instance resume); PostgreSQL 16 with pgvector for host data, turns and the index; Valkey for event streams, sessions and cancel; and an outbox-polling indexer. A mock model service speaks the provider's streaming wire format with a deterministic planner and on-demand failures (overload, mid-stream disconnect, max tokens, invented tools, loops, refusals, the gullible mode), and setting an API key switches to Claude with no code change. Simplifications: mock embeddings from hashed concept groups, HMAC-signed OBO tokens instead of an OAuth token exchange, server-applied suggestions instead of client-applied editor commands, and one org instead of per-tenant shards. Co-editing, sub-agents, MCP exposure, routing by complexity, maps-style structured results and tab-addressed browser tools are not built. The eval runner replays 10 scenarios through the real orchestrator: 10/10 pass against the mock, right first tool 90%, about 2.1 calls and 7.9K tokens per task.
