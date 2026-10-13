# Cloud IDE — System Design Answer (Frontend Focus)

*45-minute system design interview format — Frontend Engineer Position*

> Reported prompts (OpenAI, candidate-reported): "Cloud IDE that edits and runs code in browser-accessible workspaces", "Multi-tenant cloud IDE: isolation, workspaces, run/build, failure modes", "Cloud development environment platform like an online IDE", "Devbox service for on-demand remote development environments".

## 🎯 Introduction (2 minutes)

"Thanks. I'll design the browser side of a Codespaces-style IDE: the editor, the terminal, the file tree, language intelligence, port previews, and the experience of opening a workspace that may be asleep. The backend is a fleet of Linux workspaces behind a gateway; I'll treat it as a black box but specify the contracts I need from it."

"Three things make this harder than a normal web app. First, the important state lives on a remote machine, but the user expects laptop latency: a keystroke in the terminal has to echo in under 100 ms. Second, the connection *will* break, from Wi-Fi changes, gateway deploys, and host failures, and the user must not lose a keystroke or a saved file. Third, the page is huge: a code editor, terminals, and language servers in one tab for eight hours, so memory and main-thread time are real budgets."

---

## 📋 Requirements Clarification (5 minutes)

### Clarifying Questions

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| Desktop only, or mobile too? | Monaco and terminals on touch are a different product | Desktop browsers; mobile gets a read-only view |
| One user per workspace, or co-editing? | Co-editing needs CRDT/OT in the editor | One owner; co-editing out of scope |
| Do processes survive a suspend? | Decides what "resume" restores in the UI | Disk survives; processes restart, so terminals restart too |
| Can a user open the same workspace in two tabs? | Shared terminals, save conflicts | Yes; terminals are shareable sessions, saves are version-checked |
| How long can the network drop before we give up? | Reconnect policy | Retry forever while the tab is open; distinguish "network" from "workspace stopped" |
| Previews: inline or new tab? | Origin and auth design | Both; previews are untrusted user code |

### Functional Requirements

1. Workspace list and open/resume with visible progress
2. Monaco editor with tabs, dirty markers, save, diagnostics, completions, go-to-definition
3. Multiple xterm.js terminals per workspace that survive refresh and reconnect
4. File tree that reflects changes made by terminal commands (`git checkout`, `npm install`)
5. Port detection with one-click preview, plus sharing controls
6. Idle warning before auto-suspend; a clear "suspended" screen with resume
7. A run button that executes the template's run task in a terminal

### Non-Functional Requirements

| Property | Target | Why |
|----------|--------|-----|
| Keystroke echo (terminal) | p95 < 100 ms within a region | Above ~100 ms typing feels laggy |
| Editor input latency | Same frame, never waits on network | Typing in the editor is local |
| Resume time-to-interactive | p95 < 5 s | Several resumes per day |
| Reconnect after a blip | < 2 s, no lost input or output | Wi-Fi changes and gateway deploys are routine |
| Memory | < 1 GB per tab after 8 hours | Developers keep tabs open all day |
| Saved-file durability | Never lose a save the server acknowledged | Host loss loses up to 60 s of disk writes server-side |

---

## 📐 Numbers That Shape the Client (3 minutes)

I'll reuse the backend's sizing so we agree on the world.

| Fact | Number | Client consequence |
|------|--------|--------------------|
| Peak running workspaces | 300K | ~400K concurrent sockets at 1.3 tabs per workspace |
| Gateway nodes | 24, so ~17K sockets each | A node restart reconnects 17K clients at once; jitter matters |
| User-to-region RTT | <= 60 ms, plus ~5 ms server-side | Echo budget fits under 100 ms without prediction, mostly |
| Resume paths | 2.4 s warm, 8.5 s image cached, 28.5 s cold | The UI must handle all three honestly |
| Terminal flow window | 256 KB unacked | 256 KB / 0.06 s = 4.3 MB/s max per terminal |
| Agent replay buffer | 1 MB per terminal | Short disconnects replay exactly; long ones show a gap marker |
| xterm.js scrollback cost | ~12 bytes per cell | 10,000 lines x 200 cols = 24 MB per terminal |
| Snapshot cadence | Every 60 s | The client must keep saved content until it's durable |
| Idle timeout | 30 min of no input | Warning at T−5 min |

> "The scrollback number surprised me the first time: four terminals at 10,000 lines is ~96 MB before Monaco loads a single file. So I default scrollback to 5,000 lines, 12 MB each, and let users raise it."

---

## 🏗️ High-Level Architecture (6 minutes)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ BROWSER TAB (IDE origin)                                                 │
│                                                                          │
│ ┌──────────────┐ ┌───────────────────────┐ ┌──────────────┐ ┌──────────┐ │
│ │ File tree    │ │ Editor area (Monaco)  │ │ Terminals    │ │ Ports +  │ │
│ │ virtualized  │ │ models · tabs · LSP   │ │ xterm.js     │ │ preview  │ │
│ └──────┬───────┘ └──────────┬────────────┘ └──────┬───────┘ └────┬─────┘ │
│        │                    │                     │              │       │
│ ┌──────┴────────────────────┴─────────────────────┴──────────────┴─────┐ │
│ │ Workspace store (Zustand): lifecycle · connection · open files ·     │ │
│ │ terminal sessions · ports · durable-save watermark                   │ │
│ └──────┬───────────────────────────────────────────────────┬───────────┘ │
│ ┌──────┴───────────────────────────────┐ ┌─────────────────┴───────────┐ │
│ │ Connection manager                   │ │ Lifecycle client            │ │
│ │ one WebSocket · channel mux · acks   │ │ REST + SSE progress         │ │
│ │ backoff · resume · token refresh     │ │ start · stop · connect      │ │
│ └──────┬───────────────────────────────┘ └─────────────────┬───────────┘ │
│ ┌──────┴──────────────┐                                    │             │
│ │ IndexedDB: pending  │                                    │             │
│ │ saves · tree cache  │                                    │             │
│ └─────────────────────┘                                    │             │
└────────┬───────────────────────────────────────────────────┼─────────────┘
         │ WSS (terminal, lsp, fs, ports, ctl)               │ HTTPS
         ▼                                                   ▼
┌─────────────────────────┐                     ┌───────────────────────────┐
│ Workspace gateway       │                     │ Control plane API         │
│ → host → in-VM agent    │                     │ lifecycle · tokens · SSE  │
└─────────────────────────┘                     └───────────────────────────┘
  Preview iframe / tab ──▶ https://{port}-{id}.<separate preview site>
```

| Module | Responsibility | Why separate |
|--------|----------------|--------------|
| Connection manager | Owns the single socket, frames channels, flow control, reconnect and resume | One place knows the connection is down; panes just see "paused" |
| Lifecycle client | REST + SSE for start/stop/connect | The workspace may not be running; the socket doesn't exist yet |
| Workspace store | Cross-pane state in Zustand with narrow selectors | Tree, tabs, and status bar read the same facts |
| Editor area | Monaco models, LSP client, save protocol | Heaviest code; lazy-loaded |
| Terminals | xterm.js instances, one per session, WebGL renderer | Session lifetime outlives the component |

> "Keystroke-level state never goes through the store. Monaco owns its text model and xterm owns its buffer. The store holds facts that several panes need: is the file dirty, is the connection up, which ports are open. If every keystroke went through Zustand, every subscribed pane would re-render while the user types."

---

## 💾 State Model (4 minutes)

| State | Owner | Lifetime | Notes |
|-------|-------|----------|-------|
| Workspace lifecycle (pending, starting, running, stopping, stopped) | Store, from SSE | Page | Server is authoritative; UI never guesses |
| Connection state | Connection manager | Page | connecting → open → reconnecting → resyncing → open; or → workspace-stopped |
| Open file (path, model, base version, dirty, conflict) | Editor area + store | Tab session | `baseVersion` is the content hash the buffer was loaded from |
| Pending saves (path, saveSeq, content) | IndexedDB | Until durable | Dropped when the server's durable watermark passes `saveSeq` |
| Terminal session (id, last acked seq, title, exited) | Store + xterm | Server session | Survives refresh: the session lives in the workspace agent |
| File tree nodes | Store (lazy) + IndexedDB cache | Page; cache across visits | Children loaded on expand |
| Ports (port, process, visibility) | Store, from `ports` channel | Running workspace | Drives toasts and the ports panel |
| Layout (pane sizes, open tabs) | localStorage | Across visits | Restored on resume so the workspace "looks the same" |

```
              open                       socket closed
 ┌────────────┐     ┌──────┐  (network, deploy)  ┌──────────────┐
 │ connecting │────▶│ open │────────────────────▶│ reconnecting │◀─┐ backoff
 └────────────┘     └──▲───┘                     └──────┬───────┘──┘
                       │ replay done                    │ socket open
                  ┌────┴──────┐                         │
                  │ resyncing │◀────────────────────────┘
                  └───────────┘
   SSE says stopped / 409 on /connect ──▶ workspace-stopped (show resume)
```

---

## 🔌 Interface: Server Contracts (4 minutes)

```
GET    /api/v1/workspaces                  → list with state, machine class, last used
POST   /api/v1/workspaces                  → create from template (Idempotency-Key)
POST   /api/v1/workspaces/:id/start        → 202; follow /events
POST   /api/v1/workspaces/:id/stop         → 202
GET    /api/v1/workspaces/:id/events       → SSE: queued, placing, restoring, starting services, running
POST   /api/v1/workspaces/:id/connect      → 5-min signed token (includes generation) + gateway URL
PUT    /api/v1/workspaces/:id/ports/:port  → visibility private | org | public
WSS    /ws/workspaces/:id?token=…          → multiplexed channels below
```

| Channel | Client → server | Server → client | Contract detail I need |
|---------|-----------------|-----------------|------------------------|
| `term:{id}` | open (cols, rows, resume-from seq), input, resize, ack | output with byte seq, exit | Byte sequence numbers so replay is exact |
| `lsp:{lang}` | JSON-RPC requests, notifications | responses, diagnostics | Document version echoed in responses |
| `fs` | list, read, write with base version and saveSeq | contents with version, change events (coalesced) | Writes rejected on version mismatch |
| `ports` | — | opened, closed, process name | Detected from listening sockets |
| `ctl` | ping | pong, durable watermark, moved, idle warning, stopping | Lets the client explain *why* things change |

> "The single most important contract detail is the durable watermark. Every save gets a `saveSeq`. When the server commits a snapshot, it tells the client the highest `saveSeq` that snapshot covers. Until then, the client keeps that save in IndexedDB."

---

## 🔧 Deep Dive 1: One Socket, Reconnection, and Latency Hiding (9 minutes)

**The decision.** One WebSocket per tab carrying every channel, owned by a connection manager with an explicit state machine, a resume protocol per channel, and flow control on terminal output.

**Why one socket works.** A tab has 2–4 terminals, 1–3 language servers, file events, and port events. Separate sockets would each pay a TLS handshake and a gateway slot, and each would fail and reconnect independently, so the UI could show a live terminal next to a dead LSP with no single "connection" fact to display. One socket gives one status indicator, one token refresh, and one resume sequence.

**How per-channel sockets break.** Browsers cap concurrent connections per host for HTTP/1.1 fallbacks, gateway capacity is counted in sockets (400K at peak becomes 1.5M+), and reconnect storms multiply: when a gateway node with ~17K tabs restarts, five sockets per tab means ~85K simultaneous handshakes instead of 17K.

**What one socket costs, and the fix.** Head-of-line blocking: `cat` of a huge log can fill the socket and delay a completion response. I bound it with per-channel flow control. The agent stops reading a PTY once 256 KB is unacknowledged; the client acks every 64 KB *after* xterm.js has parsed the data (its write callback), not when the frame arrives. At a 60 ms RTT that's 4.3 MB/s per terminal, faster than anyone reads, and the socket always has room for LSP and input frames. Ctrl+C still works because input flows the other way and the blocked process receives the signal.

**Reconnection, step by step.**

1. Socket closes. Panes go "paused": terminals dim and buffer typed input locally (bounded to 4 KB, then input is refused with a visible hint), the editor keeps working because edits are local
2. Backoff with full jitter: 0.5 s, 1 s, 2 s, 4 s, capped at 10 s. Jitter is what turns 17K reconnects into a spread instead of a spike
3. Before reconnecting, check the lifecycle: if SSE or `/connect` says the workspace is stopped or recovering, switch to the lifecycle screen instead of hammering the gateway
4. Fetch a fresh token if the old one is within 60 s of expiry or the generation changed
5. On open, resync each channel: terminals send `resume-from` their last acked byte; the agent replays from its 1 MB ring buffer, or answers "gap" if the client fell further behind, and the client prints a dim "output truncated" marker. LSP re-initializes and re-sends `didOpen` for open models. The file tree re-lists expanded directories; open files compare their `baseVersion` with the server's version
6. Flush buffered terminal input; mark panes live

A gateway deploy sends a `moved` control frame first, so the client reconnects immediately rather than waiting for a timeout.

**Latency hiding.** The editor is local-first: typing, undo, selection, and syntax highlighting never touch the network. LSP responses that arrive for an older document version are dropped. The terminal is the hard case. Local echo is wrong in general because the remote side decides what to echo: passwords aren't echoed, and vim interprets keys as commands. I'd ship no prediction by default, since at a 60 ms RTT the echo is ~65 ms, and enable mosh-style predictive echo only when the measured RTT exceeds 80 ms: predicted characters are drawn underlined, confirmed when the real echo arrives, and prediction turns off when the terminal is in the alternate screen buffer or echo stops matching.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ One multiplexed socket + per-channel resume + flow control | One status, one handshake, exact replay | Must build mux, acks, fair scheduling |
| ❌ Socket per channel | Simple per-feature code | 4–5x sockets and reconnect storms; inconsistent status |
| ❌ Reconnect without resume (fresh terminal each time) | Trivial | Lost output and lost sessions on every Wi-Fi blip |
| ❌ Always-on local echo | Feels instant | Echoes passwords; corrupts vim and readline |

**What we give up.** A real protocol to maintain on both sides (sequence numbers, acks, gap handling), a 1 MB per-terminal memory cost in the agent, and output lost beyond that buffer during long disconnects.

---

## 🔧 Deep Dive 2: Editor, Files, and LSP Over the Wire (8 minutes)

**Loading Monaco.** Monaco plus its language workers is the largest thing on the page. It's code-split and bundled with the app (no CDN dependency for the core editor), and its download starts as soon as the user clicks "open", in parallel with the workspace boot, so a 2.4 s resume isn't followed by an editor spinner. Each open file is a Monaco model; closing a tab disposes the model but keeps its view state (cursor, scroll) in memory for quick reopen.

**The decision: who owns a file.** The disk in the workspace is the truth; the browser holds buffers with a `baseVersion`. A save sends content plus `baseVersion` plus a `saveSeq`. The agent writes only if the file's current version matches.

**Why this works.** Files change underneath the editor constantly: `git checkout`, formatters, code generators, `npm install` rewriting a lockfile. With version-checked saves, a clean buffer whose file changes on disk reloads silently, and a dirty buffer gets a conflict bar with "compare", "keep mine", and "take disk". Nothing is overwritten without the user seeing it.

**How the alternative breaks.** Last-writer-wins saves are the default in naive implementations. The user edits `package.json`, runs `npm install` in the terminal (which rewrites it), then hits Cmd+S: the editor silently reverts the install's changes, and the user discovers it two commits later. The opposite mistake, auto-reloading dirty buffers from disk, throws away typing.

**Durable saves.** The server acks a save when it's on the workspace disk, but the disk is only durable after the next snapshot, up to 60 s later. So the client keeps each saved content in IndexedDB until the `ctl` durable watermark passes its `saveSeq`. If the host dies and the workspace recovers from an older snapshot, the client compares and offers "re-apply 3 saves from before the interruption", applied as normal version-checked saves.

**The file tree.** Directories load lazily on expand. The tree renders with `@tanstack/react-virtual` because a single expanded `node_modules` can have tens of thousands of entries. File events are coalesced in the agent (100 ms) and again in the client per directory, so `npm install` produces "these 40 directories changed" rather than 50,000 events; collapsed directories just get marked stale. `node_modules`, `.git`, and build output are excluded from watching by default. The last tree is cached in IndexedDB so a resume can paint it immediately, grayed until confirmed.

**LSP.** Language servers run inside the workspace, where the toolchain and dependencies are, and speak JSON-RPC over the `lsp` channel. In-browser language servers (WASM) only exist for a few languages and can't see the workspace's installed dependencies. Requests carry the document version; completion requests are cancelled when the user keeps typing; diagnostics for a model older than the current version are ignored.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Disk is truth; version-checked saves; client keeps saves until durable | No silent overwrites; survives host loss | Conflict UI to build; IndexedDB bookkeeping |
| ❌ Last-writer-wins saves | Simplest | Silently reverts terminal-made changes |
| ❌ Browser as source of truth, sync whole tree | Instant file access | Impossible for multi-GB workspaces and generated files |
| ✅ LSP in the workspace over the socket | Any language, real dependencies | Every completion pays a round trip (~65 ms) |
| ❌ LSP in the browser | Zero latency | Few languages; can't see installed packages |

**What we give up.** Completions pay a round trip, so I prefetch on trigger characters and keep the list filterable locally while the next request is in flight. And the conflict dialog is a real UX surface that needs design time.

---

## 🔧 Deep Dive 3: Start/Resume UX and Port Previews (7 minutes)

**The decision.** Open the IDE shell immediately and drive it from the server's real progress events; never fake readiness.

**Why it works.** The same click can take 2.4 s (warm VM), 8.5 s (image cached), or 28.5 s (cold). A generic spinner makes the 28.5 s case feel broken. The SSE stream gives named steps (placing, restoring disk, starting services, connecting), so the UI shows a stepper with the step that's slow. While that runs, the client downloads Monaco, restores the saved layout, and paints the cached file tree grayed. When the socket opens, the tree un-grays, previously open tabs load, and terminals reattach or restart.

**How the alternative breaks.** "Optimistic open" (let the user type into cached files before the workspace runs) sounds fast but creates edits against a disk the client hasn't seen. If the workspace recovered from a snapshot, or a prebuild changed the files, those edits conflict before the session even starts. I only allow viewing until the socket is live.

**Suspend and idle.** At T−5 min the `ctl` channel sends an idle warning; the UI shows a banner with "keep working", and any keystroke resets it anyway. When the workspace stops, the page doesn't navigate away: it overlays a "suspended" panel over the frozen layout with one "resume" button, so resume brings back the same tabs and pane sizes. Because processes don't survive suspend, terminals show "session ended at suspend" and the template's postStart tasks rerun.

**Port previews.** The agent detects listening sockets and the `ports` channel announces them. The UI shows a toast ("Port 5173 is open: Preview"), and the ports panel lists them with visibility controls. Previews load from `https://{port}-{id}.<preview site>`, a separate registrable domain, because the dev server is the user's own arbitrary code. Inside an iframe on the IDE origin, a same-site preview could read IDE cookies, call IDE APIs with the user's session, or plant cookies on sibling subdomains. Auth uses a redirect bounce that sets a cookie for that single preview host. Inline previews use a sandboxed iframe, and "open in new tab" is always available because some apps (OAuth flows, service workers) misbehave in iframes. Hot-module-reload WebSockets go through the same preview proxy.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Real progress steps + shell painted from cache, view-only until live | Honest; fast-feeling on all three paths | Needs SSE steps and a tree cache |
| ❌ Generic spinner | Trivial | 28.5 s cold start feels broken |
| ❌ Optimistic editing before the workspace runs | Feels instant | Edits against an unseen disk; conflicts on start |
| ✅ Previews on a separate site with per-host auth cookie | User code can't reach IDE credentials | Extra redirect on first open; iframe quirks |
| ❌ Previews on an IDE subdomain | One login, simple | Untrusted code inside the IDE's site boundary |

**What we give up.** The cold path is still 28.5 s; good UX makes it legible, not fast. And first preview opens cost an extra redirect.

---

## ⌨️ Keyboard, Accessibility, and the Run Button (2 minutes)

- **Shortcut conflicts.** Ctrl+W, Ctrl+T, and Ctrl+N belong to the browser. A `beforeunload` guard protects dirty buffers; installing the IDE as a PWA lets it receive more shortcuts
- **Focus management.** Explicit pane focus with a visible ring and shortcuts to move between tree, editor, and terminal; the terminal must not trap Tab forever (Ctrl+Shift+M toggles Tab-trapping, matching common editors)
- **Screen readers.** Monaco's accessibility mode and xterm.js's screen reader mode are enabled from settings; connection state changes announce through a polite live region
- **Run button.** Runs the template's run task in a dedicated terminal, reusing it if one exists; the button shows running/stop state from the terminal session, and the ports panel lights up when the dev server starts listening

---

## 📈 Performance and What Breaks First (2 minutes)

- **Main thread.** xterm.js uses the WebGL renderer; terminal writes are batched per animation frame; LSP diagnostics are applied per model, not re-rendered globally
- **Memory over 8 hours.** Scrollback caps, disposing closed models, and capping the IndexedDB tree cache. I'd watch heap growth per hour as a release metric
- **What breaks first** is the experience on bad networks. At 150 ms+ RTT, echo exceeds 100 ms and completion lists lag; predictive echo and local filtering help, but the real fix is server-side: placing the workspace in the nearest region at creation

---

## ❓ Follow-up Questions (3 minutes)

**"10x more users?"** The client barely changes: static assets come from a CDN, so 10x users is mostly 10x gateway sockets (4M). The client-side risk is synchronized reconnect storms, so jittered backoff and `moved` frames that stagger reconnects over a few seconds matter more at 10x.

**"A data center goes down?"** If the workspace's host or zone dies, the user sees "reconnecting", then the lifecycle switches to "recovering" with a progress stepper, ~35 s for a host loss. After reconnect, the client offers to re-apply saves newer than the durable watermark. For a full region loss, the UI explains the workspace is unavailable and offers to restore it in another region from its last replicated snapshot, with a latency warning.

**"Two-week MVP?"** Workspace list, open with a stepper, Monaco with version-checked saves, one terminal with reconnect-and-replay, and port previews in a new tab. I'd skip LSP, predictive echo, and the durable-save watermark at first, but keep the single multiplexed socket because retrofitting it later touches every feature.

**"Same workspace in two tabs?"** Terminals are server sessions, so both tabs can attach and see the same output. Saves are version-checked, so the second tab to save gets a conflict instead of clobbering. A `BroadcastChannel` keeps dirty markers in sync between tabs.

**"Offline?"** No. The machine is remote. We keep the layout and unsaved buffers, and the editor stays usable for typing, but saves queue visibly until reconnect.

**"Run and build?"** They're terminal commands. The UI's job is the run button, port detection, and making build output fast to render (WebGL renderer, flow control) without freezing the tab.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Rationale |
|----------|----------|---------------|-----------|
| Transport | One multiplexed socket | Socket per channel | One status, fewer handshakes, smaller reconnect storms |
| Reconnect | Resume by byte sequence | Fresh session | No lost output on blips |
| Terminal echo | Server echo; prediction only above 80 ms RTT | Always local echo | Correct for passwords and full-screen apps |
| File ownership | Disk truth + version-checked saves | Last-writer-wins | No silent reverts of terminal changes |
| Save durability | Keep saves until durable watermark | Trust the server ack | Survives host loss |
| LSP | In workspace over the socket | In-browser WASM | Any language, real dependencies |
| File tree | Lazy + virtualized + coalesced events | Full tree eagerly | `node_modules` scale |
| Boot UX | Real SSE steps, view-only until live | Spinner / optimistic edits | Honest across 2.4–28.5 s |
| Previews | Separate registrable domain | IDE subdomain | Untrusted code isolation |
| State | Zustand for cross-pane facts only | Everything in the store | Keystrokes stay out of React renders |

---

## 📝 Summary

"To summarize: the browser runs a local-first editor and a set of terminals over one multiplexed WebSocket, owned by a connection manager with an explicit state machine. Terminals resume by byte sequence from a server-side replay buffer, with flow control acked after xterm.js parses, so a flood of output can't freeze the tab or starve language-server traffic. The workspace disk is the source of truth; saves are version-checked to avoid silently reverting terminal changes, and kept in IndexedDB until the server says a snapshot covers them, so even a host failure doesn't lose a saved file. The start experience streams real progress across the 2.4-second warm, 8.5-second cached, and 28.5-second cold paths without pretending to be ready, and previews run on a separate site because they're untrusted code. The common thread is being honest about where state lives and what the connection is doing."
