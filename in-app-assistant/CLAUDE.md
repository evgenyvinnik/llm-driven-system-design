# In-App Assistant - Development with Claude

## Project Context

Built from a two-part design discussion about how established web tools (Gmail, Docs, Maps, Word, Excel) add an LLM chat that does things in the app: the generic blueprint (chat panel, orchestrator, tool layer, grounding, act-as-the-user auth, traces and evals), then the agent loop, the tool layer and the grounding layer in detail. The ask was to implement that design. It is closest to the sidebar variant of [ROADMAP entry 2](../ROADMAP.md#2-ai-chat-client), which the roadmap had left to the answers; this project builds it as its own entry (18).

The design is in [architecture.md](./architecture.md). This file records how it was built, what changed along the way, and what is still open.

## Architecture at a Glance (what actually runs)

| Process | Port | Entry point | Notes |
|---------|------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | Host REST + assistant API + SSE; runs the agent loop for turns it starts or resumes; runs the sweeper; `dev:server1/2` add 3001/3002 |
| Mock model | 3100 | `backend/src/model/index.ts` | Messages API wire format; planner in `model/planner.ts`; failure switches via `/admin/settings` |
| Indexer | 3200 | `backend/src/indexer/index.ts` | Outbox consumer (`indexer/worker.ts`) |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` to 3000 |
| PostgreSQL 16 + pgvector | 5432 | `backend/src/db/init.sql` | `npm run db:migrate`, `npm run db:seed` |
| Valkey 7 | 6379 | - | Service named `redis` in `docker-compose.yml` because the repo's scripts look for that name |

## Development Phases

1. **Data and retrieval first.** Schema, seed (a fictional company with dates relative to today, so "last week" always means something), cleaning, chunking, mock embeddings, hybrid search. Checked with a script before anything else existed: "cancel my flight" must find the itinerary email by vector only, Bob's thread with Dana must never reach Alice, relevance must fall off.
2. **Tools, then the mock model.** Thirteen tools with schemas and effect metadata, a tool service with OBO identity and idempotent writes, then the mock model service: a planner that reads the conversation it's sent and decides the next step, streamed in the Messages API event format so the official SDK can talk to it.
3. **Orchestrator.** The loop, the turn store with leases, suspension and resume, the sweeper, the policy engine, context assembly, prefetch. Exercised with scripted clients against the running stack: basic flows, then confirmation and client-tool flows, then every failure switch, idempotency, cancellation, and a crash test that kills a second API instance mid-turn.
4. **Template action and live signals.** Added mid-build after the user restated the design's two-part framing: "Summarize thread" as one fixed prompt with no loop, and kept/undone and sent/discarded feedback for AI output.
5. **Tests and evals.** 36 unit tests (policy, context assembly, citations, tools, retrieval, planner) and a 10-scenario eval run through the real orchestrator in process.
6. **Frontend, verified in a browser.** The suite, the assistant panel, settings and the Ops dashboard, driven through the headline request, the injection flow, the browser tool, event creation and the dashboard.
7. **Docs.** architecture.md, this file and the README; the three interview answers were written in parallel by subagents from architecture.md and the code, then checked against the no-code and length rules.

## Key Implementation Decisions (and why)

Build-time choices that aren't obvious from architecture.md.

- **The mock model speaks the Messages API wire format, and the orchestrator uses the official SDK.** The alternative was a bespoke `/v1/generate` like prompt-playground's. Matching the real format means `client.beta.messages.stream()` runs unchanged against the mock or Claude, the SDK's own partial-JSON assembly of `input_json_delta` is exercised, and switching to Claude is an environment variable. SDK retries are off (`maxRetries: 0`) so every retry is ours and visible in the trace.
- **The mock is a stateless planner, not a script.** Each call re-derives its next step from the tool calls and results already in the conversation. That is the property the orchestrator depends on (the model keeps no memory), and it makes resume after a crash and "continue where you left off" work without special cases.
- **The mock's failures are armed counts, not probabilities.** "Fail the next three primary requests with 529" makes a demo or a test deterministic, which a failure rate can't.
- **A gullible switch, on by default.** The mock obeys instructions found in emails, so the injection scenario proves the policy engine works when the model doesn't cooperate.
- **The agent loop runs inside the API process.** A separate worker fleet (like prompt-playground's executor) would add a queue and a hop. The lease and the sweeper already make any instance able to resume any turn, so in-process is enough here; architecture.md says when that changes.
- **Ajv for argument validation.** The tools' contract with the model is JSON Schema, so validating with a JSON Schema validator (rather than zod) means the schema the model sees and the schema enforced are the same object. Ajv's errors are rewritten into sentences the model can act on.
- **Wrap-up uses `tool_choice: none`, not an empty tool list.** Removing tools would change the cached prefix and, on current Claude models, invalidate replayed thinking blocks.
- **Thinking blocks are stripped only where history is rewritten** (folded turns, stubbed tool results, a changed tool set). Elsewhere the conversation is append-only and blocks are replayed unchanged.
- **Paragraph IDs are per document and counter-based** (`p_1`, `p_2`, `next_pid`), not random, because the model reads and copies them, and short sequential IDs are what it copies most reliably.
- **The editor reports a 120-character outline, not the document**, in the client context. Enough to anchor "under the intro"; `read_document` gets full text when needed.
- **A custom markdown renderer instead of react-markdown.** It handles the subset the assistant writes, builds React elements only, and gives citations first-class treatment (links only for verified IDs). One less dependency and no HTML path at all.
- **No TanStack Query.** Like prompt-playground, the only cross-page state is live turns, which need custom semantics (streams owned by the store, replay guards), so Zustand holds them and pages fetch directly.

## Iteration & Repair Log

Bugs found by running the stack, in the order found:

1. **"Under the intro" anchored to the selection.** The section regex listed `summary` among section words, and "Add a short **summary** of..." matched before "intro". Fix: take the word after "under/below/after/into".
2. **The forecast question answered with the wrong paragraph.** "What's the travel budget in the FY26 forecast?" matched the total-budget paragraph on "budget" and "FY26", words that identify the document, not the answer. Fix: drop document-title words from the query before picking a paragraph.
3. **The injection draft failed validation.** The extracted address kept the sentence's trailing period (`...example.`), so `create_draft` got an invalid email and the scenario failed for the wrong reason. Fix: the address pattern excludes a trailing dot; the planner also retries on validation errors.
4. **Greetings swallowed first sentences.** "Hello,\n\nOur records show..." became one sentence starting with "Hello", which the greeting filter then dropped, so summaries led with the second sentence. Fix: strip a salutation line before splitting sentences.
5. **A date inside a reply's content became a search filter.** "Draft a reply to Raj saying let's talk tomorrow" searched for mail sent *tomorrow* and found nothing. Fix: draft replies ignore dates in the content part.
6. **The mid-stream disconnect switch never fired on short replies.** It disconnected after half the output tokens, but counted stream pieces, which are fewer; the armed failure was consumed silently. Fix: count pieces for both. Re-verified: partial text, `text.discard`, retry, normal finish.
7. **The prefetch rewriter answered the previous request.** History was passed with its `<user_request>` tags intact, and the mock read the first tag in the prompt, so a rewrite request was prefetched as if it were the earlier summary request. Fix: history goes to the rewriter as "User:/Assistant:" lines, and the mock reads the last tag.
8. **"Tighten" produced a broken sentence.** Removing the filler phrase "single source of truth for" left "The goals, agenda, budget and logistics." Fix: only drop filler adverbs; shorten by cutting long sentences at a comma.
9. **Loading `/` signed out hit React's update-depth limit.** The root route rendered `<Navigate>` while the router was still settling the first location, which re-entered the router store. React recovered, but the error is real. Fix: auth redirects in an effect, and the index route redirects in `beforeLoad`.
10. **A Valkey outage would have failed turns.** Event appends threw, so a turn that could finish in PostgreSQL failed instead. Fix: appends are best-effort and logged; the SSE reader already falls back to a PostgreSQL snapshot.
11. **Refresh mid-turn showed rows twice.** Found by the subagent writing the frontend interview answer, by reading the store: an active turn was seeded from the REST copy (activity rows, the pending card) and its stream then replayed from the first event. Fix: active turns start as an empty shell and the replay rebuilds them. Verified by reloading with a confirmation pending: one card.
12. **A `409 TURN_IN_PROGRESS` attached to a turn the tab didn't have**, so its events were dropped. Fix: fetch the turn, add it to the app's slot, then follow it. Verified by starting a turn from a script in the same conversation and submitting in the browser.
13. **A crash test that didn't crash.** The first attempt killed the `npx` wrapper PID, not the node process listening on :3001, so the "dead" instance finished the turn itself. Kill the listener (`lsof -ti tcp:3001`) to test takeover. Takeover then took ~6 s with a 6 s lease, and re-ran only the call whose result hadn't been checkpointed.

## Verification Environment Notes

- Verified on macOS with Docker Desktop (pgvector/pgvector:pg16, valkey 7.2), Node 22. `psql` isn't installed on the host; use `docker exec in-app-assistant-postgres psql -U assistant -d in_app_assistant`.
- Scripted e2e clients (login, start turn, follow SSE, answer confirmations and client tools, arm failures) lived in the session scratchpad and aren't committed; `npm run eval` covers the same ground as a repeatable suite.
- When the indexer is running, `npm run db:seed` reports fewer sources indexed than queued, because the indexer process claims some backfill events concurrently (`SKIP LOCKED`). Not a bug; the index ends up complete.

## Open Questions / Next Steps

- **Append-only step storage.** Checkpoints rewrite the turn's whole message array; at scale, append steps as rows and rebuild on resume.
- **Client-applied document edits** for a co-editing editor, so assistant edits sync and undo like any other edit.
- **A real reranker and embeddings** behind the same interfaces, with a retrieval eval (queries with known correct passages) separate from the answer eval.
- **Sub-agents** for mailbox-wide tasks, returning summaries to keep the main context small.
- **Multiplexed SSE reader** per API instance instead of one blocking Valkey connection per open stream.
- **Exposing the tool layer over MCP** with the same OBO tokens and policy engine.
