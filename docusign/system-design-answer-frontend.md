# DocuSign (E-Signature Platform) — System Design Answer (Frontend Focus)

*45-minute system design interview format — Frontend Engineer Position*

---

## 📋 Opening Statement

"An e-signature client is unusual among frontend problems because **the UI is part of the legal record.** When someone clicks Sign, what they saw on screen at that moment is evidence. That inverts several defaults I'd normally reach for: I can't render optimistically, I can't let a retry produce a second signature, and I can't show a document that might not be the document that was signed.

There are also two completely different applications sharing a codebase — a sender's authoring tool and a recipient's signing experience — with opposite constraints. The sender is a logged-in power user placing fields on a PDF. The signer is a stranger following an emailed link on an unknown device, who may never use the product again.

I'll go deep on three things: rendering a PDF with interactive fields positioned correctly at any zoom, making the signing action exactly-once from the client's side, and designing for a signer who has no account and no second chance."

---

## 🎯 Requirements

### Functional

1. **Authoring** — upload a PDF, place typed/signature/date fields by dragging onto pages, assign each to a recipient
2. **Sending** — define recipients and routing order, then dispatch
3. **Signing** — open a magic link, read the document, complete required fields, draw or type a signature, submit
4. **Tracking** — see envelope status and a tamper-evident audit trail
5. **Terminal states** — decline, void, completion, each with its own screen

### Non-functional

| Requirement | Target | Why |
|-------------|--------|-----|
| Field position accuracy | Exact at every zoom, every viewport | A signature rendered in the wrong place is a legal defect, not a visual one |
| Double-submit safety | Guaranteed exactly-once | Two signatures on one field is legally ambiguous |
| Signer completion on mobile | Fully usable | Most signers open from email on a phone; they don't get a second chance |
| Time to first page | < 2s | A blank viewer reads as "broken link" and signers abandon |
| Accessibility of signing | Keyboard-completable | An unsignable document is a legal-access problem |

### Non-goals

No collaborative real-time authoring, no in-browser PDF editing, no offline signing. Offline in particular is a deliberate exclusion — a signature captured without a server round trip has no trustworthy timestamp.

---

## 🏗️ Two Applications, One Codebase

```
   SENDER (authenticated, repeat user)     SIGNER (magic link, one-time)
   ┌──────────────────────────────┐        ┌──────────────────────────────┐
   │  Envelope list               │        │  /sign/:accessToken          │
   │  Authoring                   │        │                              │
   │   ├─ documents               │        │   ├─ read-only PDF           │
   │   ├─ recipients + order      │        │   ├─ only *my* fields        │
   │   ├─ field placement (drag)  │        │   ├─ signature capture       │
   │   └─ audit trail             │        │   └─ submit / decline        │
   └───────────────┬──────────────┘        └───────────────┬──────────────┘
                   │  session cookie                       │  token in URL
                   └───────────────┬───────────────────────┘
                                   ▼
                        ┌────────────────────┐
                        │   API (Express)    │
                        └─────────┬──────────┘
                     ┌────────────┼────────────┐
                 Postgres      MinIO        Redis
              (state machine) (PDFs)     (sessions)
```

**The split is the first architectural decision.** These could share a document viewer, and mostly do — but their requirements diverge sharply enough that treating them as one app produces a bad version of both.

| | Sender | Signer |
|---|--------|--------|
| Auth | Session, persistent | URL token, single envelope |
| Bundle tolerance | High — a tool they use daily | Low — first paint on cellular decides completion |
| Field interaction | Create, move, delete | Fill only their own |
| Failure cost | Retry later | May never return |

The signer route should therefore be **independently code-split and never import authoring code.** A signer downloading the drag-and-drop field editor to read a two-page contract is paying for capability they're forbidden to use.

---

## 🧭 Questions I'd Ask First

Three answers would reshape this design:

**"Can two senders edit one envelope at once?"** If yes, field placement becomes a collaborative-editing problem — presence, conflict resolution, and probably CRDTs — and it dominates everything else. I'm assuming single-editor drafts, which is what the state machine implies.

**"Which PDFs must we support?"** Scanned images, forms with existing AcroFields, and 300-page documents are three different rendering problems. A PDF that already contains form fields raises a real question: do we use them or overlay our own? Overlaying is more consistent; reusing them is what signers expect.

**"What's the legal bar — evidence, or a self-contained signed artifact?"** This decides whether overlays are acceptable or flattening is mandatory, and it's the difference between a rendering choice and a compliance requirement. I'll design for evidence-plus-audit-trail and flag flattening as the gap.

---

## 🔍 Deep Dive 1: Positioning Fields on a PDF That Can Be Any Size (11 minutes)

This is the hardest rendering problem in the product, and getting it wrong is a legal defect.

### The coordinate problem

A field is stored against the document — page 2, x 0.31, y 0.62. The browser renders that page as a canvas whose pixel dimensions depend on zoom, viewport width, and device pixel ratio. Between "where the field is" and "where to draw it" sits a coordinate transform that must be exactly invertible, because the same transform runs backwards when the sender *places* a field by dragging.

**If placement and rendering disagree by even a few pixels, a signature drifts out of its box** — and it drifts differently on the signer's phone than on the sender's laptop.

### Options

| Coordinate system | Zoom behavior | Risk |
|-------------------|---------------|------|
| ❌ Absolute pixels at authoring zoom | Breaks at every other zoom level | Silent misalignment; the classic bug |
| ❌ CSS pixels of the rendered canvas | Breaks on different viewport widths | Sender and signer see different placements |
| ✅ **Normalized 0–1 fractions of page dimensions** | Scales exactly | Requires care with PDF's bottom-left origin |
| ✅ PDF points (72/inch) with explicit scale factor | Matches the PDF spec | Must track the render scale everywhere |

### What I'd build

**Store normalized fractions relative to page width and height.** Rendering multiplies by the current rendered page size; placement divides by it. One transform, one inverse, defined in one module that both the authoring overlay and the signing overlay import. The rule I'd enforce is that **no component computes a coordinate itself** — every position goes through that module, because the moment two places implement the transform, they drift.

Two details that bite:

- **PDF's origin is bottom-left; the DOM's is top-left.** The Y flip has to live inside the transform, not be remembered by each caller. This is the single most common source of "the signature is mirrored vertically" bugs.
- **Fields are overlaid, not embedded.** The PDF renders to a canvas and absolutely-positioned DOM elements sit on top. That's what makes fields focusable, keyboard-accessible, and styleable — a canvas-drawn field would be invisible to assistive technology and impossible to tab into.

### What we give up

Because signatures are overlays rather than flattened into the PDF, **the downloaded file is not self-contained proof.** The evidence lives in the stored signature objects plus the audit chain. That's a defensible position — the audit trail is the legal artifact — but it means the client must never imply that "download PDF" produces a signed document. The copy has to be honest about what the file is.

> "I'd put the coordinate transform behind a single tested module before writing any drag interaction. It's twenty lines that everything depends on, and it's the one place where a rounding error becomes a legal problem rather than a visual one."

---

## 🔍 Deep Dive 2: Making "Sign" Exactly-Once From the Client (10 minutes)

The server enforces idempotency with keys and row locks. The client's job is to make sure it participates correctly, and there's a subtle failure that pure server-side protection doesn't cover.

### The failure the server can't see

A signer taps Sign on a slow connection. Nothing visibly happens. They tap again. Without a client-supplied key, those are two independent requests carrying identical content, and the server has no basis to recognize the second as a retry — idempotency requires a *client-generated* identifier, because only the client knows the two attempts are the same intent.

### The rule: mint the key when the intent forms, not when it's sent

| When the key is generated | Behavior on double-tap |
|---------------------------|------------------------|
| ❌ At request time | Two keys, two signatures — idempotency defeated |
| ✅ **When the signing session opens** | One key, second request returns the first result |
| ✅ Per completed signature, before submit | Same, and survives a page reload if persisted |

This is the same reasoning I'd apply to any payment form, and it's worth stating plainly: **the idempotency key identifies the user's intent, so it must be created when the intent is formed.**

### Client-side layers on top

The key is the correctness mechanism; these prevent the situation from arising:

- **Disable and label the button on submit** — "Signing…", not a spinner alone, because a spinner beside an enabled-looking button invites a second tap.
- **Treat a 409 as success, not error.** If the server reports the signature already exists, the correct UI is the completion screen. Showing an error for an action that succeeded is how signers end up signing twice through a different path.
- **Never optimistically render the completed state.** Everywhere else I'd argue for optimism; here the signature isn't real until the server has it, and showing "Signed" before that is a lie with legal weight.

### What this costs

A guaranteed round trip before the signer sees confirmation — on a bad connection, several seconds of a disabled button. I'd accept that and invest in making the wait legible rather than shortening it: progress text, an explicit timeout with a retry that reuses the same key, and never a silent failure.

> "The distinction I keep coming back to is that a signature isn't a UI state, it's an event that either happened or didn't. Optimistic UI is a bet that the server will agree with you, and that's not a bet to take on a legal record."

---

## 🔍 Deep Dive 3: Designing for a Signer With No Account and One Attempt (9 minutes)

The signing route is the highest-stakes screen in the product and the one with the least context about its user.

### What's different

The signer arrives from an email, on an unknown device, authenticated only by a token in the URL. They have no account, no prior session, no support relationship, and often no reason to try twice. **Every friction point converts directly into an unsigned contract.**

That produces constraints the sender's app doesn't have:

**The URL is the credential.** A token in the address bar leaks through screenshots, shared links, and browser history. The client should treat it accordingly: exchange it for a session immediately and remove it from the visible URL via history replacement, so the page can be reloaded without the raw token sitting in the address bar. It also means "share this page" is never a supported action.

**Mobile is the primary case, not the responsive afterthought.** Signing on a phone means a pinch-zoomable PDF, a signature pad sized for a finger, and fields the user can jump between without hunting. The "next required field" affordance isn't a nicety — on a small screen, a required field on page 7 is otherwise undiscoverable, and the signer submits, gets rejected, and doesn't know why.

**Errors must be recoverable in place.** A signer who hits an error has no account to log back into. Losing their drawn signature and typed entries to a failed submit means starting over — the moment most abandonment happens. Captured input should survive an error and a reload, held locally against the signing session, right up until the server confirms.

### Terminal states are screens, not toasts

Completion, decline, and "this envelope was voided" are separate routes. A signer who lands on an expired link needs an explanation and a path forward — usually "contact the sender" — and a toast on a broken document viewer doesn't provide that. These states are also where signers arrive *later*, re-clicking the emailed link days after signing, so they have to be meaningful out of context.

---

## 🗄️ State: Three Lifetimes, Three Homes

The authoring app and the signing app hold different state, and the useful frame is how long each piece must survive.

| State | Lifetime | Home | Why |
|-------|----------|------|-----|
| Envelope + fields (server truth) | Until changed on the server | Fetched, never locally mutated as truth | Two clients editing one envelope must not diverge |
| In-progress field placement | The authoring session | Local store, flushed on save | Dragging shouldn't produce a request per pixel |
| Signer's entries and drawn signature | Until the server confirms | Local, keyed to the signing session | Survives an error or reload; the abandonment fix from Deep Dive 3 |
| Zoom, current page, selected field | This tab | Component/URL | Pure view state; sharing a link to page 4 is useful |
| Session / access token | Session | Cookie, not JavaScript-readable | It's a credential |

The row worth defending is the second. **Field placement is buffered locally and saved explicitly, rather than persisted on every drag.** A save-per-drag would produce hundreds of writes for one layout pass, and each is a state transition on a legally-tracked object — polluting the audit trail with noise that obscures the events that matter. Explicit save also gives the sender an undo boundary that matches their mental model.

The cost is a lost-work window if the tab closes mid-layout. I'd mitigate with a local draft rather than by writing through to the server, because the audit-trail argument doesn't go away.

> "I want the audit trail to record decisions, not mouse movements. That pushes me toward explicit saves even though continuous autosave would be friendlier."

---

## 🔀 Making Routing Order Comprehensible

Recipients sign in a defined order, which can be serial or parallel. This is where senders make their most consequential mistakes, and it's a pure UI problem — the backend model is simple, the mental model isn't.

The failure is specific: a sender adds three recipients, assumes they'll all be notified now, and only discovers days later that recipient two was never emailed because recipient one hasn't signed. Nothing was broken; the UI just let them assume the wrong thing.

| Presentation | What it communicates | Problem |
|--------------|---------------------|---------|
| ❌ A flat list with an order column | Nothing about *waiting* | Reads as "these people will be notified" |
| ❌ Drag-to-reorder list | Sequence, but not concurrency | Can't express "these two in parallel, then this one" |
| ✅ **Grouped stages, each stage parallel within it** | Both sequence and concurrency, visually | More complex to build; needs a clear empty/single-stage case |

**Stages are the right primitive** because they match the underlying model exactly — a routing order value is a stage number, and recipients sharing one sign concurrently. Rendering them as vertical groups makes "who is waiting on whom" a spatial fact rather than something inferred from a number in a column.

Two supporting details matter as much as the layout. The UI should **preview who gets notified immediately** — "Sending now: Alice. Bob and Carol will be notified after Alice signs" — in plain language before dispatch, because that sentence is what corrects the wrong assumption. And **status should render onto the same stage layout** after sending, so the tracking view and the authoring view are the same picture. A sender who arranges recipients in one shape and then tracks them in a different one has to rebuild the model twice.

---

## 📜 Showing a Hash Chain Without Requiring Cryptography Knowledge

The audit trail is a hash-chained event log, and the temptation is to display it as one — hashes, previous-hashes, a verification badge.

That's the wrong default, because **the audience is a person in a dispute, not a cryptographer.** What they need is a readable narrative: who did what, when, from where. The chain is the *mechanism* that makes the narrative trustworthy, not the content.

So the primary view is a timeline in plain language, and verification is a single honest statement — "integrity verified, 47 events" — with the hashes available behind a disclosure for anyone who wants them.

The part worth getting right is failure. If verification fails, the UI must not degrade into a red badge on an otherwise-normal timeline. **A broken chain means the record cannot be trusted**, and the interface should say that prominently and identify the first event where the chain breaks, because that's the forensically useful fact. Treating tamper-evidence as a minor status indicator wastes the entire mechanism.

---

## 🔒 Rendering Someone Else's PDF Safely

The client renders arbitrary user-uploaded PDFs, and PDFs are an executable format.

**Rendering with `react-pdf`/PDF.js rather than an `<iframe>` or the browser's plugin viewer is a security decision as much as a functional one.** PDF.js parses and paints to a canvas in JavaScript, so embedded JavaScript actions, auto-launching links and embedded files never execute. Handing the same file to a native viewer inside an iframe gives up that control.

Two further precautions worth naming: PDF.js should run with its worker so parsing a large or malicious file can't lock the main thread, and documents should be fetched from storage with a short-lived signed URL rather than a permanent public one — otherwise a leaked document URL outlives the envelope's access controls entirely.

---

## ♿ An Unsignable Document Is an Access Problem

Accessibility here has legal weight beyond the usual: if a signer cannot complete the document with assistive technology, they cannot enter the agreement.

- **Fields are DOM elements, not canvas drawings** — the overlay approach in Deep Dive 1 is what makes them focusable and labeled at all. This is the concrete payoff of that choice.
- **Tab order follows reading order**, not the order fields were placed by the sender. Someone dragging fields around a page must not be able to produce an incoherent keyboard path.
- **Drawing a signature can't be the only option.** A signature pad requires a pointer and fine motor control. Typed signatures with a rendered font are a genuine alternative, not a lesser fallback, and must carry the same legal weight in the UI's presentation.
- **Required-field errors are announced**, not just outlined in red — and they name the field and page, because "3 required fields remaining" is unactionable on a long document.

---

## 🧪 Testing What Has Legal Consequences

The valuable tests here aren't render assertions — they're the ones that would catch a defect a court could care about.

| Scenario | How | What it protects |
|----------|-----|------------------|
| Coordinate round-trip | Place a field, re-read it, at several zoom levels and viewport widths | The Deep Dive 1 drift bug — a pure function, so this is cheap and exhaustive |
| Y-axis origin | Assert a field placed at the visual top of a page stores a *high* normalized Y | Catches the flip that mirrors signatures vertically |
| Double submit | Fire the submit action twice concurrently | One signature recorded; second returns the first result |
| 409 on retry | Server reports already-signed | Completion screen, not an error |
| Signer input survives failure | Fail the submit, reload | Entries and drawn signature still present |
| Required-field guard | Submit with a required field on an unrendered page | Blocked *and* the user is navigated to it |
| Expired / voided token | Load a dead link | Explanatory terminal screen, not a broken viewer |

The first two are the highest-value tests in the codebase and cost almost nothing, because the transform is a pure function of page dimensions. **That's an argument for the shared-module design on its own** — a coordinate transform buried in a drag handler can only be tested through the UI, which means in practice it isn't tested at all.

I'd also snapshot-test the field overlay against a fixed page size, so an unintended change to positioning shows up as a diff rather than as a signature slightly outside its box six months later.

---

## 🧯 Failure States That Have to Be Right

Ordinary apps can treat network errors generically. Here several of them carry meaning the user must understand.

| Failure | Wrong response | Right response |
|---------|---------------|----------------|
| Document fetch fails | Blank viewer | Explicit "couldn't load the document" with retry — never let a signer sign something they can't see |
| Envelope voided while signing | Generic error on submit | Terminal screen explaining the sender withdrew it |
| Token expired mid-session | Redirect to login (there is no login) | Explanation plus "request a new link" |
| Field save fails | Silent | Inline, non-destructive — the value stays in the input |
| Signature upload fails | Discard the drawing | Keep the drawn signature; retry the upload |

The first row is the one with legal weight. **A signing UI must never allow submission when the document didn't render.** It's an easy bug to write — the fields load from a separate request and are perfectly functional while the PDF canvas is empty — and it produces exactly the scenario e-signature law exists to prevent. The submit control should be gated on the document having rendered, not merely on required fields being complete.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| Field coordinates | ✅ Normalized 0–1 fractions | ❌ Absolute pixels | Only representation stable across zoom, viewport and device |
| Transform location | ✅ One shared module | ❌ Per-component math | Two implementations drift; drift is a legal defect |
| Field rendering | ✅ DOM overlay on canvas | ❌ Drawn into canvas | Focusable, labelable, keyboard-navigable |
| Idempotency key | ✅ Minted at session start | ❌ Generated per request | Key must identify intent, not transmission |
| Signature feedback | ✅ Wait for server | ❌ Optimistic "Signed" | A signature is an event, not a UI state |
| 409 handling | ✅ Render success | ❌ Render error | The action did succeed; an error invites a second attempt |
| App split | ✅ Separate signer bundle | ❌ One shared app | Signer pays for authoring code they're forbidden to use |
| PDF rendering | ✅ PDF.js to canvas | ❌ iframe / native viewer | Embedded JavaScript and actions never execute |
| Token in URL | ✅ Exchange, then strip | ❌ Leave in address bar | Screenshots and history leak the credential |
| Draft input | ✅ Persist until confirmed | ❌ Discard on error | A signer who loses their work abandons |

---

## 🚀 What Breaks First

**Large documents, before anything else.** A 200-page PDF rendered eagerly blocks the main thread and exhausts memory on a phone. The fix is rendering only visible pages with a small buffer — and it interacts with Deep Dive 1, because a field on an unrendered page still needs a known position for "jump to next required field" to work. That's the argument for keeping field geometry in normalized data rather than deriving it from rendered DOM.

**Then field density.** A page with 60 fields is 60 absolutely-positioned elements re-laid-out on every zoom. Batching the transform and avoiding per-field layout reads matters well before page count does.

**Then the audit trail**, which grows unbounded per envelope and is currently rendered as a list. Pagination, and eventually virtualization.

**Not a concern:** the envelope list, and the state machine's complexity. Those are ordinary CRUD problems with well-understood solutions — worth saying explicitly, because they look like the hard parts and aren't.

---

## 📶 Performance Where It Decides Completion

Worth separating the two apps, because their performance problems are different in kind.

**The sender's app has a throughput problem.** Dragging a field must stay at 60fps while a PDF page is rendered beneath it. The fix is standard: transform-based movement during the drag, committing position only on drop, and never triggering a React re-render per pointer move.

**The signer's app has a first-paint problem, and it's the one that matters commercially.** A signer on cellular staring at a blank viewer assumes the link is broken. Three things move that number, in order of impact:

1. **Don't ship authoring code.** The biggest win is the code split — the signer's bundle should contain a viewer, a signature pad and a form, nothing else.
2. **Render page one before fetching the rest.** Progressive rendering means the signer sees a document while later pages stream, which converts "broken" into "loading".
3. **Fetch the document and the field definitions in parallel.** They're independent, and serializing them doubles time-to-interactive for no reason.

The measurement I'd hold the team to isn't Lighthouse — it's **completion rate by connection type.** A signing flow that works beautifully on office wifi and loses a quarter of mobile signers is failing at the only thing it's for.

---

## 🔭 What I'd Build Next

Three gaps I'd name unprompted, because they're the difference between this and a product:

**Flattened PDFs.** Today the signed document is "original PDF + overlay data + audit trail". That's defensible as evidence and confusing as a deliverable — the file someone downloads doesn't show the signatures. Embedding them with `pdf-lib` at completion, and digitally signing the resulting bytes, turns the artifact into something a recipient can forward without explanation.

**Real-time status for the sender.** Envelope status is fetched on load, so a sender watching for a signature refreshes. This is the one place I'd add a push channel — and I'd use SSE for the same reasons as elsewhere: one-directional, free reconnection, no upgrade handshake.

**Templates.** The data model has them; there's no UI. For anyone sending the same agreement repeatedly, re-placing fields every time is the dominant cost of using the product, and it's pure frontend work on an existing table.

---

## 📝 Summary

Three ideas carry this design:

1. **The UI is evidence.** That single fact rules out optimistic rendering of signatures, forbids client-invented coordinates, and turns a rounding error into a legal defect rather than a cosmetic one.
2. **Two users, two applications.** A daily-use authoring tool and a one-shot signing experience have opposite tolerances for bundle size, friction and failure. Sharing a viewer is right; sharing a bundle is not.
3. **Exactly-once is a client responsibility too.** The server enforces it, but only the client knows that two taps were one intent — which is why the idempotency key is minted when the intent forms, and why a 409 is a success screen.
