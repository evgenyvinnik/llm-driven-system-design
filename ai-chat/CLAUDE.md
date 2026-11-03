# AI Chat Client - Development with Claude

## Project Context

ROADMAP entry 2, renamed from "ChatGPT" (`chatgpt/`) to "AI Chat Client" (`ai-chat/`). The rehearsed interview round is a discussion-only frontend architecture design of a chat client like ChatGPT or Claude.ai, sometimes as a desktop app, sometimes as an assistant embedded in an existing product. So the client is the part built most carefully, and [system-design-answer-frontend.md](./system-design-answer-frontend.md) is the main deliverable. The server exists so that every client claim (resume, Stop, retry, two devices, branches) is backed by real behaviour rather than a mock.

All data is original and fictitious; the spec is written for this repository, not copied from any interview material.

The design is in [architecture.md](./architecture.md). This file records how it was built and what is still open.

## Architecture at a Glance (what actually runs)

| Process | Port | Entry point | Notes |
|---------|------|-------------|-------|
| API | 3000 | `backend/src/api/index.ts` | REST, generation SSE, device SSE |
| Executor | 3200 | `backend/src/executor/index.ts` | Claims generations, streams the model, checkpoints, runs the sweeper |
| Mock model | 3100 | `backend/src/model/index.ts` | Deterministic markdown answers; TTFT, tokens/s, error, disconnect, slot knobs |
| Frontend | 5173 | `frontend/src/main.tsx` | Vite proxies `/api` (target overridable with `API_PROXY_TARGET`) |
| PostgreSQL 16 / Valkey 7 | 5432 / 6379 | `backend/src/db/init.sql` | Host ports overridable (`AI_CHAT_PG_PORT`, `AI_CHAT_VALKEY_PORT`) |

## Development Phases

1. **Read the exemplar.** prompt-playground already had the run state machine, executor leases with attempt fencing, the append-once-ended Valkey log, SSE resume and the forward-only client merge. They were reused nearly as is (renamed run → generation, `queued` → `accepted`) rather than redesigned.
2. **Backend, verified with curl** against Docker before any UI: idempotent create and replay (200 + `Idempotent-Replayed`, 422 on key reuse), exact resume from a mid-stream `Last-Event-ID`, resume from a PostgreSQL checkpoint (checkpoint + later events = stored output), Stop aborting the model request (model active slots 1 → 0), the two-device race (one 202, one 409 naming the winner), edit / regenerate / branch switch, cross-user 404 on all eight conversation and generation routes, the model error and disconnect knobs, 8 forced browser-stream drops reassembling the exact text, path and sidebar pagination.
3. **Frontend, verified in a real browser.** Streaming, switching conversations mid-answer, refresh mid-answer, Stop, regenerate, edit, hostile markup, offline reload with the API down, automatic recovery, and a second tab receiving the first tab's live answer.
4. **Screenshots, smoke tests, docs.** 9 screenshots, 9/9 generated smoke tests, then the architecture document and the three interview answers.

## Key Implementation Decisions (and why)

- **Generation = one assistant message.** Regenerate creates a new assistant *message* (a sibling) with its own generation, rather than several generations under one message. The tree stays uniform (siblings of user messages are edits; siblings of assistant messages are regenerations), and ‹ 2/3 › needs no special case.
- **`output` on the generation, `content` on the message.** The checkpoint lives with the attempt; the message gets its text once, in the same transaction as the terminal status. History reads never need attempt data.
- **Checkpoints store the Valkey entry ID they cover.** Without it a refreshed client can't tell where the checkpoint ends in the stream, and would have to replay from the start.
- **One in-flight generation per conversation**, enforced by a row lock plus a partial unique index. Simpler for users than racing branches, and it turns the "two devices at once" question into a deterministic 409.
- **Latest leaf = newest message in the subtree.** Children are always newer than parents, so this needs no per-node bookkeeping and gives "the latest state of that branch".
- **Rendering without an HTML path.** marked is used only as a lexer; tokens become React elements. No sanitizer to keep current, and memoizing top-level blocks by source text makes "only the last block re-renders" fall out naturally.
- **Images in model output are never fetched.** A markdown image is the standard exfiltration channel for prompt injection, because the URL is fetched on render.
- **fetch-based SSE, not EventSource.** EventSource can't send `Last-Event-ID` on its first request, so it can't resume from a checkpoint loaded over REST.
- **Gateway errors mean "outcome unknown".** 502/503/504, and a bare 5xx without the API's error envelope (what Vite's proxy returns when the API is down), are treated like a failed connection: offline mode, and retries keep the idempotency key. Found when testing offline mode with the backend stopped. Without it the app showed "Could not load" instead of the offline copy.
- **Device events are hints.** Every (re)connect of `/events` starts with a `ready` event, and the client reconciles from REST, because pub/sub drops whatever was published while it was away.
- **Same stack as prompt-playground** (no TanStack Query, Valkey streams as the queue, `bcryptjs`), for the reasons recorded in its CLAUDE.md.

## Iteration & Repair Log

1. **"Building on what we said about the question" on a first message.** The mock generator fell back to placeholder keywords for an empty history and then treated them as earlier topics. Caught in a screenshot; fixed and covered by a test.
2. **Offline mode didn't engage with the API down behind the dev proxy** (above): Vite answers 500 with an empty body, which the client treated as an application error.
3. **Smoke test for the operator page signed in as the wrong user.** `scripts/generate-smoke-tests.mjs` ignored a screen's `loginAs`, so the generated admin test logged in as alice and failed. The generator now passes `loginAs` credentials to `login()`. It also writes `baseURL: process.env.SMOKE_BASE_URL || …`, so tests can target a frontend on another port. Eleven other projects use `loginAs`; their committed tests pick this up when regenerated.
4. **zustand v5 selector returning a new array** (pending sends filtered in the selector) would loop; moved the filter into `useMemo`.
5. **"Assistant is responding." was announced for background generations** (device sync follows answers in conversations not on screen). Announcements now only fire for the conversation being viewed.

## Verification Environment Notes

- Other sessions were running sibling projects on the default ports (5432/6379, 5442/6389, 5452/6399), so this stack ran on PostgreSQL 5462, Valkey 6409, API 3030, model 3130, executor 3230 and frontend 5193. Hence the port overrides in `docker-compose.yml`, `vite.config.ts` and the smoke-test config.
- The screenshot harness ran without `--start` against that running stack (`SCREENSHOT_FRONTEND_PORT=5193`), so it would not kill other projects' processes on 5173/3000. Every screen logs "networkidle timed out", because the device-sync SSE is open for the life of the page; the harness falls back to `domcontentloaded`.
- The desktop app's built-in browser pane refuses service-worker registration, so the offline-reload-through-SW path was verified with Playwright Chromium (`context.setOffline(true)`) against `vite preview`.

## Open Questions / Next Steps

- **Multiplexed SSE reader** per API instance (one `XREAD` over many keys) instead of one blocking Valkey connection per open stream; the main scaling limit.
- **Leader-tab connection sharing** (BroadcastChannel) so many tabs don't each hold a device stream and generation streams.
- **Tail-only markdown lexing** for very long answers, with a full re-lex at the end.
- **Queued offline sends.** The idempotency key already makes them safe to replay; the UX of a message composed against a stale leaf needs thought.
- **Checkpoint on size or time** (every 1 KB or 5 s) instead of a fixed interval, to cut PostgreSQL writes at scale.
- **`latest_leaf_id` per message** if subtree scans for branch switching get expensive.
- **Syntax highlighting** (lazy, completed code blocks only) and reduced-motion handling for the streaming caret.
- **Real provider adapter** behind an environment variable, keeping the mock as the default.
