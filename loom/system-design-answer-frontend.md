# 🎥 Loom (Async Video Messaging) — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Most of Loom's hard problems live in the browser. The recorder has to capture screen, camera and microphone for up to an hour without running out of memory, upload the recording *while* it's being made over a flaky laptop connection, and still produce a working link the moment you press Stop. Then the share page — the only part of the product most people ever see — has to start playing in about a second for someone who has never visited the site."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, performance budgets, browsers, accessibility |
| A — Architecture | 10 min | Pages, state ownership, the data layer, two key interactions |
| D — Data model | 4 min | Client entities, cache keys, the upload's local state |
| I — Interface | 4 min | The API as the client sees it; component contracts |
| O — Optimizations & deep dives | 18 min | Recording + streaming upload, playback + comments, the share page |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm who uses which part of the product, because the creator and the viewer have very different budgets."

### Functional requirements

1. **Record** screen, camera or both, with microphone; pause and resume; stop from our UI or the browser's own "Stop sharing" bar.
2. **Upload during recording** and show that it's happening; after Stop, let the creator name the video and copy the link right away.
3. **Library**: grid of recordings with status (uploading, processing, ready, failed), search, folders, delete.
4. **Player** with time-anchored comments: clicking a comment's timestamp seeks the video.
5. **Share modal**: create a link with optional password, expiry and download permission; revoke links.
6. **Public share page**: watch without an account, unlock with a password, read comments, sign in to comment.
7. **Analytics panel**: views, unique viewers, average watch time, completion, views per day.

Out of scope: editing and trimming, drawing on the video, transcripts, mobile recording (`getDisplayMedia` is desktop-only anyway).

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Stop → link ready | p95 < 2 s | The product promise |
| Share page LCP / first frame | < 1.5 s on a mid-range laptop over 4G | Recipients decide in a second whether to watch |
| INP | < 200 ms, including while recording | Encoding competes with the UI for the CPU |
| Recorder memory | Stable for a 60-minute recording | A crashed tab loses the recording |
| Initial JS | Share page < 100 KB gzipped; app shell < 170 KB | The share page is the public entry point |
| Browsers | Chrome, Edge, Firefox for recording; all modern browsers for playback | MediaRecorder and codec support vary |
| Accessibility | WCAG 2.2 AA; full keyboard use; progress and errors announced | Recording and playback must be usable without a mouse |

---

## 🏗️ A — Architecture (10 min)

"Rendering first. The app — library, recorder, analytics — is authenticated and has no SEO needs, so a client-rendered SPA with route-level code splitting is right. The share page is different: it's public, and when someone pastes a link into Slack, the unfurl needs the title and poster in the HTML. So I'd serve the share page's HTML shell from the edge with Open Graph tags filled in, and hydrate the same React route. I'm not server-rendering the player itself; the video is the slow part, not the markup."

```
 ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Routes (TanStack Router): /record · /share/$token · /videos/$id · / (library)                 │
 └───────────┬───────────────────────────────┬──────────────────────────┬────────────────────────┘
             │ /record                       │ /share, /videos          │ every page
             │                               │                          │
             ▼                               ▼                          ▼
 ┌───────────────────────────┐   ┌────────────────────────┐       ┌──────────────────────────────┐
 │ RecordingInterface        │   │ VideoPlayer            │ seek  │ Comments · Library           │
 │ MediaRecorder, 1 s chunks │   │ seek · view tracker    │◀──────┤ ShareModal · Analytics       │
 └───────────┬───────────────┘   └───────────┬────────────┘       └─────┬────────────────────────┘
             │ (1) chunk                     │ (2) playback URL         │ (2) queries
             ▼                               │                          ▼
 ┌───────────────────────────┐               │ (3) heartbeats     ┌──────────────────────────────┐
 │ Recording store           │               │                    │ TanStack Query: server data  │
 │ Zustand: upload snapshot  │               │                    │ URL: ?search ?folder         │
 └───────────┬───────────────┘               │                    └─────┬────────────────────────┘
             │ push, finish                  │                          │ fetch, invalidate
             ▼                               ▼                          ▼
 ┌───────────────────────────┐   ┌────────────────────────┐       ┌──────────────────────────────┐
 │ ChunkedUploader           │   │ <video> element        │       │ API client                   │
 │ 5 MiB parts, retries      │   │ sendBeacon on hide     │       │ fetch, typed ApiError        │
 └───────────┬───────────────┘   └───────────┬────────────┘       └─────┬────────────────────────┘
             │ (1) PUT part n,               │ (2) HLS · (3) POST       │ /api/*, cookies
             ▼ part URL, complete            ▼ /api/analytics/view      ▼
 ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Backend: object storage (presigned PUT) · CDN (playback) · Video API (/api/*)                 │
 └───────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Record (1).** `RecordingInterface` gets a chunk from MediaRecorder every second and pushes it into the recording store, which feeds `ChunkedUploader`. The uploader cuts 5 MiB parts and `PUT`s them straight to object storage with presigned URLs it gets from the API; on Stop it sends the last part and completes.
2. **Watch (2).** The share page or video page asks TanStack Query for the video; the response carries a playback URL that goes into the `<video>` element, which streams from the CDN. Clicking a comment's timestamp calls `seek(t)` on the player.
3. **Count (3).** The player's view tracker sends a heartbeat every 15 seconds watched, and a `sendBeacon` when the page is hidden.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Videos, comments, shares, analytics | TanStack Query | Server data: caching, dedupe, retries and invalidation without hand-written loading flags |
| Library search and folder | URL (`?search`, `?folder`) | Shareable, survives reload, works with Back |
| Recording upload progress | Zustand store holding the uploader's snapshot | Survives navigating away mid-upload; read by the recorder and a global "uploading" toast |
| Recorded chunks, parts, retries | The `ChunkedUploader` instance (outside React) | Blobs and in-flight requests don't belong in render state |
| Player time, open dialogs, form fields | Component state | Local and short-lived |

"The rule I'm applying: server data never lives in Zustand, and big binary state never lives in React state. Copying server data into a store means owning its staleness by hand; putting a growing array of blobs into React state means re-rendering on every chunk."

### Key interaction: recording with a streaming upload

```
 Creator   Recorder                Uploader                         Video API    Storage
    │          │                       │                                │           │
    │ 1 Start  │                       │                                │           │
    │─────────▶│                       │                                │           │
    │          │ 2 begin()             │                                │           │
    │          │──────────────────────▶│                                │           │
    │          │                       │ 3 POST /videos {uuid}; start   │           │
    │          │                       │───────────────────────────────▶│           │
    ······················ a MediaRecorder chunk every second ·······················
    │          │ 4 push(chunk)         │                                │           │
    │          │──────────────────────▶│                                │           │
    │          │                       │ 5 part URL n (5 MiB buffered)  │           │
    │          │                       │───────────────────────────────▶│           │
    │          │                       │ 6 PUT part n; retries                      │
    │          │                       │───────────────────────────────────────────▶│
    ····························· Creator presses Stop ······························
    │          │ 7 finish(duration)    │                                │           │
    │          │──────────────────────▶│                                │           │
    │          │                       │ 8 PUT tail part                            │
    │          │                       │───────────────────────────────────────────▶│
    │          │                       │ 9 POST /complete {partCount}   │           │
    │          │                       │───────────────────────────────▶│           │
    │          │ 10 done: link + Save  │                                │           │
    │          │◀──────────────────────│                                │           │
    │          │                       │                                │           │
```

"`begin()` runs as soon as capture starts, so the upload session is ready before the first part is. The video's ID is generated in the browser, which makes the create call safe to retry. Step 10 is what the creator experiences as 'it was instant': the uploader only had the tail left."

### Key interaction: opening a protected share link

```
Viewer             Share page                      Video API                     Player
   │                    │                              │                            │
   │ 1 open /share/{t}  │                              │                            │
   │───────────────────▶│                              │                            │
   │                    │ 2 GET /api/share/{t}         │                            │
   │                    │─────────────────────────────▶│                            │
   │                    │ 3 401 requiresPassword       │                            │
   │                    │◀─────────────────────────────│                            │
   │ 4 submit password  │                              │                            │
   │───────────────────▶│                              │                            │
   │                    │ 5 POST /unlock (pw in body)  │                            │
   │                    │─────────────────────────────▶│                            │
   │                    │ 6 video, URL; grant cookie   │                            │
   │                    │◀─────────────────────────────│                            │
   │                    │ 7 src, poster; comments load                              │
   │                    │──────────────────────────────────────────────────────────▶│
   │                    │                              │ 8 POST /views, first play  │
   │                    │                              │◀───────────────────────────│
   ····························· comment badge clicked ······························
   │                    │ 9 seek(t)                                                 │
   │                    │──────────────────────────────────────────────────────────▶│
   │                    │                              │                            │
```

"The password goes in a `POST` body — never the URL, which would end up in history, logs and `Referer` headers. After unlocking, the server sets a signed grant cookie, so a refresh or a later visit within the grant's lifetime doesn't ask again."

---

## 💾 D — Data Model (4 min)

| Entity | Shape | Where | Freshness |
|--------|-------|-------|-----------|
| `Video` | `id`, `title`, `status`, `durationSeconds`, `thumbnailUrl`, `viewCount`, `access` (owner or viewer) | `['video', id]`, and inside library pages | Polled every 5 s while `status` is `uploading` or `processing`; otherwise invalidated by mutations |
| `SharedVideo` | `Video` + `downloadUrl`, `allowDownload`, `author` | `['share', token]` | Refetched when the playback URL nears expiry |
| `UploadSnapshot` | `videoId`, `phase`, `recordedBytes`, `uploadedBytes`, `partsUploaded`, `partsTotal`, `error` | Zustand | Pushed by the uploader on every change |
| `Part` | `number`, `blob`, `state` (queued, uploading, done, failed), `loaded` | Inside `ChunkedUploader`; journaled to IndexedDB | Until the upload completes |
| `Comment` | `id`, `content`, `timestampSeconds` (nullable), `parentId`, `author` | `['comments', videoId]` | Optimistic insert; refetch on focus |
| `ViewSession` | `viewId`, `watchedSeconds`, `completed` | A ref in the view tracker | One per page view |

Two modeling decisions:

- **The upload's real state is the parts list, not a percentage.** A percentage can't be resumed; a list of numbered parts with states can. That's also what lets "retry" re-send only the parts that failed.
- **Viewer identity is two IDs.** A `viewId` per playback session makes heartbeats idempotent on the server, and a stable anonymous `viewerKey` in `localStorage` lets anonymous viewers count once in "unique viewers".

---

## 🔌 I — Interface (4 min)

### The API as the client sees it

```
POST  /api/v1/videos                       {id, title} → Video (retry-safe: same id, same video)
POST  /api/v1/videos/{id}/upload           → {uploadId, partSize}
POST  /api/v1/videos/{id}/upload/parts     {partNumber} → {url} presigned PUT, 15 min
POST  /api/v1/videos/{id}/upload/complete  {partCount} → Video | 409 {missingParts}
GET   /api/v1/shares/{token}               → SharedVideo | 401 {requiresPassword} | 404 | 410
POST  /api/v1/shares/{token}/unlock        {password} → SharedVideo + grant cookie | 401 | 429
GET   /api/v1/videos/{id}/comments         → Comment[]
POST  /api/v1/views                        {videoId, viewId, viewerKey, watchedSeconds, completed}
```

- Errors arrive as `application/problem+json`; the API client turns them into a typed `ApiError` with the status, so the share page can branch on 401 versus 404 versus 410 versus 429 instead of matching message strings.
- Part uploads go to storage, not the API, with `XMLHttpRequest`, because `fetch` has no upload progress events. The client never reads the `ETag` header — the server lists parts from storage at completion — so storage's CORS settings only need to allow `PUT`.

### Component contracts

| Component / module | Contract |
|--------------------|----------|
| `<RecordingInterface onRecordingStart onChunk onRecordingComplete uploadStatus>` | Owns capture and MediaRecorder; emits every chunk as produced; shows live "uploaded X of Y MB" |
| `ChunkedUploader` | `begin()`, `push(chunk)`, `finish(duration) → Promise<Video>`, `retry()`, `abort()`, `subscribe(snapshot)`; knows nothing about React |
| `<VideoPlayer videoUrl status onPlay onTimeUpdate onEnded seekRequest>` | Renders by status; `seekRequest` carries a nonce so the same timestamp can be requested twice |
| `<CommentSection videoId playerTime onSeek>` | Anchors new comments at `playerTime`; timestamp badges are buttons that call `onSeek` |
| `useViewTracker(videoId, enabled)` | Returns `onPlay`, `onTimeUpdate`, `onEnded`; sends the view, heartbeats and a final beacon |

---

## 🔧 O — Optimizations & Deep Dives (18 min)

### Deep dive 1: recording and uploading at the same time (8 min)

"The failure I'm designing against: someone records for twenty minutes, presses Stop, and waits a minute for an upload — or worse, their Wi-Fi drops and the upload fails at 95%. Both come from treating the recording as one file."

**Capture.** I call `getDisplayMedia` for the screen and `getUserMedia` for the microphone, combine the tracks into one `MediaStream`, and pick the first supported type from VP9, VP8 and plain WebM with `MediaRecorder.isTypeSupported`. I listen for the video track's `ended` event, because the browser's own "Stop sharing" button ends capture without going through my UI. MediaRecorder runs with a one-second timeslice, so it hands me a ~250 KB chunk every second instead of buffering the whole recording internally.

**Streaming.** Each chunk goes to the uploader immediately. The uploader buffers chunks until it has 5 MiB — the multipart minimum for every part except the last — then cuts a numbered part and uploads it in the background, up to two at a time. Each attempt asks for a fresh presigned URL, because an expired URL is one of the most common reasons a retry is needed, and backs off exponentially from half a second to eight. Part numbers follow recording order, so storage reassembles exactly the bytes MediaRecorder produced.

**Stop.** `finish()` cuts whatever is buffered into a final, smaller part, waits for every part, and calls complete with the part count. Because parts left during recording, Stop has at most 5 MiB to send — about a second on typical uplinks — and the preview screen can show "Uploaded" while the creator is still typing a title.

**When the network fails.** A part that exhausts its retries moves the uploader to an `error` phase; recording continues and new parts queue up. The UI shows "Upload paused — will retry" during recording, and a Retry button after Stop that re-sends only failed parts. A `beforeunload` prompt warns before closing the tab with parts still in flight.

**Memory.** The parts are held as `Blob`s, which browsers can keep outside the JavaScript heap. For long recordings I'd journal each part to IndexedDB as it's cut and drop it from memory once storage acknowledges it; if the tab crashes, the next load finds the journal, asks the server which parts it already has, and resumes. That's the piece that makes an hour-long recording genuinely safe.

| Approach | Verdict |
|----------|---------|
| ✅ Upload 5 MiB parts during recording | Link ~1 s after Stop; a failure costs one part, not the recording |
| ❌ Record, then upload the whole file | Upload time grows with recording length; one failure loses everything |
| ❌ Stream chunks over a WebSocket to our servers | Our servers carry every byte; reconnects need a custom resume protocol |

"What I give up is simplicity: the record page now coordinates capture, a parts queue, retries and a server session. I keep that out of React by putting it in one class with a snapshot API, and I test it as plain TypeScript with a fake transport."

### Deep dive 2: playback and time-anchored comments (5 min)

"The player's job is to start fast, seek precisely, and stay in sync with the comment list without the two components knowing about each other."

- **Seeking needs a seek index.** MediaRecorder's WebM has no duration and no cues, so browsers can't seek it until fully downloaded — clicking "4:20" just spins. The backend remuxes every upload within seconds, and serves HLS renditions later; the player uses native HLS on Safari and loads hls.js as a lazy chunk elsewhere, so it costs nothing on pages that don't need it.
- **One-way data flow.** The page holds `playerTime`, updated from `timeupdate` (about four times a second). `CommentSection` reads it to label "Anchor at 2:34". Seeking goes the other way through a `seekRequest` prop carrying a nonce, so two clicks on the same timestamp both work.
- **Timestamp badges are buttons** with labels like "Jump to 4:20", so keyboard and screen-reader users can use them.
- **Markers on the scrubber** for anchored comments, rendered as one absolutely positioned layer, not a component per comment.
- **Long threads** get virtualized once they pass a few hundred comments; most videos have a handful.

### Deep dive 3: a share page that is fast, honest and safe (5 min)

- **Smallest route in the app.** The share route is its own chunk: no library, no recorder, no analytics code. The poster image is the LCP element, so it's preloaded from the edge-rendered HTML, and the `<video>` uses `preload="metadata"` until the viewer presses play.
- **Credentials stay out of URLs.** The token has to be in the path, so the page sets `Referrer-Policy: no-referrer` and loads no third-party scripts. The password goes in a `POST` body, and the grant comes back as an `HttpOnly` cookie that JavaScript can't read.
- **Clear outcomes.** `401` shows the password form, `404` says the link doesn't exist or was revoked, `410` says it expired, `429` says to wait a few minutes. Each is a distinct, plain sentence, not "Something went wrong".
- **Honest view counts.** The tracker creates a view ID on first play, adds watch time only for small forward steps (a seek isn't watching), marks completion at 90%, and sends the last heartbeat with `sendBeacon` on `pagehide`, which survives the tab closing. The creator's own plays aren't sent at all.

| Approach | Verdict |
|----------|---------|
| ✅ Edge-rendered shell with Open Graph tags, client-rendered player | Rich unfurls in Slack; tiny server work |
| ❌ Fully client-rendered share page | Unfurls show a blank title |
| ❌ Fully server-rendered player | Server work for markup that isn't the slow part |

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| Camera or screen permission denied | "Loom needs permission to record your screen" with steps | Catch `NotAllowedError` from `getDisplayMedia` |
| Browser can't record WebM | "Recording needs Chrome, Edge or Firefox" | No supported MIME type |
| Network drops while recording | Badge: "Upload paused — will retry"; recording continues | Uploader `error` phase; parts stay queued |
| Upload fails after Stop | "Upload paused" with a Retry button; the preview still plays | `retry()` re-sends only failed parts |
| Video still uploading or processing | Library card says "Uploading…" or "Processing…"; the player plays the original during processing | Status-driven rendering; 5 s polling while not `ready` |
| Wrong share password | "Incorrect password" in an `aria-live` alert; focus stays in the field | `401` from unlock |
| Expired or revoked link | "This link has expired" or "doesn't exist or was revoked" | `410` versus `404` |
| Empty library | Empty state with a Record button | First-run onboarding |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Upload | 5 MiB parts during recording | Upload after Stop | Link ready ~1 s after Stop; failures cost one part |
| Upload progress | `XMLHttpRequest` per part | `fetch` | Only XHR reports upload progress |
| Upload state | A parts list in a plain class | A percentage in React state | Resumable, testable, no re-render per chunk |
| Server state | TanStack Query | Copying responses into Zustand | Caching and invalidation for free |
| Share page | Edge shell + client player | Fully client-rendered | Slack and email unfurls |
| Share password | `POST` body, then a grant cookie | `?password=` in the URL | Keeps it out of history, logs and `Referer` |
| View tracking | View ID heartbeats + beacon | One request per page load | Real watch time; retry-safe |

"With more time I'd add the IndexedDB journal so a crashed tab resumes its upload, a camera bubble composited onto the screen recording with a canvas, and client-side trimming that uploads only an edit list instead of new video."
