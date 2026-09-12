# Design an electronic signature platform — frontend interview

A 45-minute discussion of a proposed design. This is not a claim that the local demo already
provides these guarantees. I would draw one architecture and expand the three hardest
decisions as the interviewer asks questions.

## 🎯 Scope and promises — 4 minutes

> “I would organize this around a promise to the signer: the document you review, the fields you complete, and the action the server records must refer to the same document revision.”

There are two main journeys. The sender prepares an envelope with PDFs, recipients, and
fields. The signer arrives through an invitation, reviews the documents, fills their
assigned fields, and confirms or declines. An administrator needs a separate investigation
interface.

I would clarify whether we support collaborative preparation, which PDF formats and page
counts we accept, and whether completion includes a downloadable artifact. I will assume one
active draft editor, ordinary PDFs, and a final artifact produced asynchronously after all
required signers finish.

The sender can recover through their account. A signer may have only the invitation, so
recovery must work without sending them to an unrelated account login. That affects
navigation, authentication errors, and how we preserve input during a failed request.

| Requirement | Proposed scope |
|-------------|----------------|
| Preparation | Upload, place/resize fields, assign recipients, preview routing stages |
| Signing | Review the frozen revision, draw/type a signature, fill text/date/checkbox fields |
| Workflow | Show waiting, active, completed, declined, withdrawn, and expired states |
| Confirmation | Distinguish recorded actions from final artifact availability |
| Usability | Keyboard completion, usable narrow layout, clear required-field navigation |
| Performance | First page within two seconds for a defined ordinary PDF/device/network scenario |

I would exclude offline submission and simultaneous editing initially. We can retain a
drawing while a request fails, but we cannot record a server-authorized action while
disconnected. Local input and recorded evidence are different things.

I would also ask for the intended identity and consent requirements. The UI must collect the
product's specified confirmation and display it accurately. I would not infer legal
compliance from a signature image, timestamp, or audit badge.

## 🏗️ Client architecture — 5 minutes

I would draw the sender and signer experiences separately because their interactions differ,
while sharing a tested document geometry and field-rendering layer.

```
┌──────────────────┐     ┌───────────────────┐
│ Sender workspace │     │ Signer ceremony   │
│ Draft and stages │     │ Review and action │
└──────────────────┘     └───────────────────┘
          │                        │
          ▼                        ▼
┌───────────────────────────────────────────┐
│ Shared viewer and geometry contract       │
│ PDF page, accessible fields, input panels │
└───────────────────────────────────────────┘
                       │
                       ▼
             ┌────────────────────┐
             │ Typed API boundary │
             │ Auth, revisions,   │
             │ operation receipts │
             └────────────────────┘
                       │
                       ▼
             ┌────────────────────┐
             │ Server authority   │
             │ State and objects  │
             └────────────────────┘
```

The signer route should load its viewer and input controls without requiring the full
preparation editor. I would measure the generated bundle before asserting that route files
automatically provide that separation. Heavy PDF parsing belongs in its supported worker,
with a maintained parser and resource limits.

The API boundary validates response shapes and converts database representations into client
types. Declaring a coordinate as a TypeScript number does not make a JSON string a number.
It also preserves structured errors such as expired invitation, revision conflict, or
unknown operation outcome.

| State | Owner | Reason |
|-------|-------|--------|
| Envelope revision, fields, permissions | Server, with a client cache | Must be revalidated before recording actions |
| Selected document/page/zoom | Component or route | Navigation state does not change the agreement |
| Drag preview and unsaved layout edits | Editor state | Pointer movement should not produce server writes |
| Drawn image and typed input | Ceremony memory until acknowledged | Preserve work through a request failure |
| Operation ID and receipt | Client identifier, server result | Reconnect must recover the same action |
| Session credential | Secure cookie after invitation exchange | Keep ongoing authority out of ordinary application state |

I would use a query cache for server resources and a small local store for editor
interactions. Zustand is sufficient for the latter; using it does not automatically provide
cancellation, stale-response protection, or revision checks.

A response can arrive after navigation to another envelope. Bind it to the envelope ID,
revision, and request generation before applying it. Clear or invalidate resources when
authorization changes. A single global loading boolean cannot represent several independent
page and save requests safely.

## 🧭 Preparation and recipient flow — 4 minutes

The preparation sequence is upload, recipients, placement, review, and send. Upload progress
covers byte transfer; processing status covers server validation. Those are separate
indicators, since finishing a transfer does not mean the file is ready to sign.

I would show recipients in stages. People within one stage act in parallel; later stages
wait. Before sending, the interface says who is notified now and who will wait. A flat
numbered list hides this distinction, especially when two recipients have equal routing
order.

The preview also shows any participant who is copied rather than required to sign. That
person should not accidentally hold up the signing stage. The server owns these rules, but
the preparation UI should make them understandable before the sender commits.

For draft layout, pointer movement updates a local preview. A drop becomes a versioned
layout mutation, or part of an explicit saved revision. If another client changed the draft,
show a conflict and preserve the local edits for review rather than silently overwriting
them.

Sending freezes the document and field revision on the server. I would disable further
editing while the request is unresolved, then reconcile its operation receipt. Hiding the
controls after a successful response is useful feedback; preventing a concurrent edit
requires the backend's revision guard.

This is also where I would stop unsupported PDFs. A parser failure or unsupported page
geometry should produce an actionable preparation error. Letting a broken document reach a
recipient moves a recoverable authoring problem into the signing ceremony.

## 🔧 Deep dive: coordinates that survive different devices — 9 minutes

> “The difficult part is not drawing a rectangle. It is ensuring that a rectangle placed on a laptop identifies the same area when reviewed on a phone and later written into the final PDF.”

I would choose a versioned PDF-page coordinate contract. Each field references an immutable
document revision and page, while the page metadata supplies its crop box, rotation, and
coordinate units. The browser uses the page viewport's transform to move between that space
and CSS display coordinates.

For placement, take the pointer location relative to the rendered page itself. Apply the
inverse viewport transform, then store a rectangle in the agreed document space. For
display, transform the rectangle's corners back into the current viewport. The final
artifact renderer consumes the same document-space rectangle.

I would explicitly separate three spaces: document coordinates, CSS display pixels, and
canvas backing pixels. Device-pixel ratio makes the canvas sharper; it must not double the
field's stored position. Padding and a centered canvas add an offset that is not part of the
PDF.

| Approach | Strength | Cost or failure |
|----------|----------|-----------------|
| ✅ Versioned PDF-page geometry | Common reference for editor, signer, and output | Requires transform and parser-version tests |
| ❌ Container CSS pixels | Easy for a fixed demo layout | A different width, padding, or zoom shifts the field |
| Alternative: normalized page fractions | Convenient responsive rendering | Still needs a defined crop, rotation, and origin contract |

Normalized fractions are a reasonable alternative, not a universal solution. A value such as
“halfway down the page” is ambiguous if the authoring and output systems disagree about
which page box is visible. I would choose the representation that the PDF pipeline can
reproduce consistently.

The PDF origin is often described as bottom-left, but I would not scatter manual Y flips
through components. Rotation and nonzero crop-box origins complicate that shorthand. The
shared transform should account for those cases, and a round-trip test should prove that
placement survives a change in viewport.

For a concrete example, imagine a 90-degree rotated page with a field near its visible
top-right. A width/height-only scaling rule can move that field to a different corner.
Transforming the rectangle's corners through the actual viewport keeps the interpretation
consistent.

On the client, I would put both the PDF page and its field overlay inside one page-sized
positioning context. Observe that page's size, compute one transform for the frame, and
apply it to all fields. Avoid reading each field's layout separately during a zoom gesture.

The overlay should use real controls with names, required status, and keyboard behavior.
Being in the DOM is not enough: a clickable div still needs semantics and focus handling. A
checklist offers a second path to the same field when the visual page is hard to navigate.

I would render one page or a small visible window, depending on the reading experience.
Field metadata remains available even when its page is unmounted, so “next required field”
can navigate to it. Do not allocate hundreds of canvases just to preserve navigation
targets.

For scale, a US-letter-sized canvas at approximately 816 by 1,056 CSS pixels and
device-pixel ratio two needs roughly 13 MiB for one RGBA bitmap. Several hundred pages can
consume gigabytes before parser and text-layer overhead. This is a sizing illustration, not
a browser benchmark.

The cost of the shared geometry contract is upfront complexity and compatibility work when
the parser changes. I would accept that cost because an isolated fixed-width implementation
becomes expensive to correct once the same field must survive mobile rendering and final
artifact generation.

My acceptance cases include portrait and landscape pages, rotation, crop offsets, different
device-pixel ratios, narrow widths, and placement near each edge. I would compare the
generated artifact as well as the interactive overlay; a visually correct browser alone does
not prove correct output.

## 🔧 Deep dive: a retry must preserve the same intent — 8 minutes

> “A disabled button reduces double taps. A server receipt tells us whether the action was actually recorded. We need both, and they solve different problems.”

When a signer confirms an input, create a stable operation ID for that field action and bind
it to the document revision and input digest. Reuse it when retrying the same payload. A
different field or deliberately changed input gets a different operation ID; one key for the
entire session would collapse unrelated actions.

The server must claim that scoped operation and commit the field action and receipt
atomically. The frontend cannot create exactly-once behavior by generating UUIDs. It can
participate in a protocol that makes a repeated request refer to the same accepted effect.

| UI state | What the signer sees | Meaning |
|----------|-----------------------|---------|
| Editing | Input controls | Nothing submitted yet |
| Submitting | Action disabled, descriptive progress | Request in flight |
| Outcome unknown | Input preserved, checking status | Transport failed; commit may have happened |
| Recorded | Server-confirmed field value/check | Matching operation receipt obtained |
| Conflict | Explanation and current state | Input or workflow differs from the requested action |

Suppose the server commits, but the response is lost. Displaying “failed” and generating a
fresh operation encourages a second action. Instead, retain the original ID and query its
status or replay that same request. If the receipt confirms the matching revision and input,
the UI can safely show it as recorded.

A 409 response is not automatically success. It might mean that another tab completed the
field, the sender withdrew the envelope, or this operation ID was reused with different
input. Fetch the authoritative state and distinguish those cases before updating the
display.

I would keep the drawn image in memory while a request fails, and disable changing it while
its outcome is unknown. Let the signer resolve that operation first, then start a new edit
if the product permits it. Otherwise the client can accidentally attach an old response to a
new drawing.

For reload recovery, preserve a small non-secret operation identifier when allowed, then ask
the authenticated server for the result. I would not default to retaining signatures and
document content indefinitely in local storage on a shared device. If reload loses
unsubmitted input, say so clearly; persistence needs an explicit privacy and expiry policy.

The trade-off is extra waiting before a field becomes green. I would use optimistic feedback
for pointer movement and local text entry, but require a matching server acknowledgment for
recorded actions. The user still gets immediate interaction feedback without being told the
server accepted something it has not confirmed.

| Choice | Why it fits | What we give up |
|--------|-------------|----------------|
| ✅ Confirmed receipt before “recorded” | Survives response loss and rejection | A network round trip and reconciliation state |
| ❌ Optimistic recorded status | Feels immediate | Can mislead after void, conflict, or server failure |
| ❌ Fresh operation ID on every retry | Easy request helper | Turns one intent into multiple logical actions |

Finish is its own operation. It rechecks all required fields on the server, including fields
on pages never mounted in the current view. The client can guide the signer to missing
inputs, but cannot decide that the workflow is complete.

Once Finish is recorded, the page says that this recipient's action is complete. Other
recipients may still be waiting, and final document generation may still be pending. Those
distinctions prevent a success screen from promising an artifact that does not exist.

## 🔧 Deep dive: invitation access and recoverable signing — 7 minutes

A signer may arrive from a forwarded email, a link scanner, or a second device. I would
treat the invitation as a credential with a limited scope and explicit lifetime. The server
decides whether additional authentication is required before granting signing authority.

I would exchange the invitation for a secure session and replace the credential-bearing URL.
The exchange must account for email scanners: merely fetching a page should not consume the
only invitation and lock out the person. A user-initiated step can establish the session
while the server retains the intended invitation policy.

That session remains subordinate to current envelope state. Withdrawal, expiration, and
stage changes must be enforced by the action endpoints even if the browser has not
refreshed. A long-lived cached “active” flag is convenient, but would let stale state
authorize an action after circumstances change.

| Approach | Why choose it | Cost |
|----------|---------------|------|
| ✅ Scoped session plus live action checks | Limits ongoing token exposure and respects state changes | Session lifecycle, recovery, and backend lookups |
| ❌ Reusable URL token as the only authority | Simple invitation flow | URL leaks and stale permission are difficult to contain |
| ❌ Require every signer to create an account | Reuses sender authentication | Adds friction unrelated to a one-envelope task |

In the ceremony, I would show loading, PDF failure, waiting for an earlier stage, expired
invitation, withdrawn envelope, and already-completed recipient as distinct states. The
recovery action must fit the state. A waiting signer does not need to reset their password;
an expired invitation may require contacting the sender.

Do not enable signing while the document failed to load. Bind render readiness to the exact
document revision, clear it on document changes, and show retry next to the failure.
Successful rendering is a useful interaction prerequisite, though it does not prove that a
human read or understood the document.

On narrow screens, move the field checklist into a compact navigator or input panel. Keep
the page readable and let a field jump open a large enough input control instead of asking
someone to hit a tiny box. Preserve document/page context when the keyboard opens.

The signature modal needs a focus trap, accessible title, close behavior, and restoration to
the field that opened it. Typed capture provides a keyboard-accessible alternative to
drawing. Drawing must account for canvas display scale and pointer input; a fixed backing
canvas stretched by CSS can distort strokes.

A required-field error should announce which field remains and offer navigation. A generic
“three fields left” counter is insufficient on a long document. Progress should count
completed required fields against required fields, not include optional fields only in the
numerator.

The cost of these explicit states is more UI work and more contract testing. I would
prioritize them over animation because this journey has a meaningful terminal action and
often no account-based recovery path.

## 📜 Tracking and evidence display — 3 minutes

The sender view can start with bounded polling while visible, backing off when hidden or
after errors. If low-latency tracking becomes important, SSE can send invalidation hints;
reconnect still requires fetching an authoritative snapshot. A push message should not
replace revision-aware state reconciliation.

I would show invitation queued, provider accepted, recipient opened, recipient finished, all
signers finished, and artifact ready according to the evidence actually available.
“Delivered” is particularly easy to misuse if the backend merely attempted to enqueue an
email.

The audit timeline should lead with actor, action, time, and document revision.
Cryptographic details can be expanded. A verification result should identify the covered
sequence and verification time, and say whether it was checked against an independently
protected checkpoint.

A failed verification is not automatically proof of malicious alteration. Serialization bugs
and incomplete exports can also cause it. Show an unresolved evidence problem clearly and
preserve the records for investigation; do not silently turn a failed check into a green
success badge.

An original PDF download and a final signed artifact need different labels. A browser
overlay is not embedded in the original bytes. Only show the final-artifact action when the
server returns a ready version with its identity and authorization.

## 🧪 Verification and performance — 3 minutes

I would spend testing effort at the boundaries where an apparently successful screen can be
wrong.

| Scenario | Required result |
|----------|-----------------|
| Slow response after switching envelopes | Old data cannot replace the current revision |
| Rotated/cropped page at several scales | Browser placement and final output agree |
| Commit followed by response loss | Same operation reconciles to one recorded action |
| Conflict from another tab | UI presents the actual conflict, not assumed success |
| Withdrawn envelope during review | Server rejects action; input and explanation remain available |
| PDF load failure | No false review-ready state or enabled submission |
| Keyboard-only ceremony | Every field and modal can be completed and exited |
| Artifact job failure | Recipient completion remains distinct from artifact availability |

Performance metrics should include first usable page, input delay while rendering, save
acknowledgment latency, and recovery success. Segment by document size and device class. A
fast landing page score says little about filling a field on a large scanned PDF.

I would keep canvases bounded, avoid per-field layout reads on zoom, and load the
preparation editor separately. Larger envelope lists need actual pagination controls; adding
virtualization to the first twenty rows does not make the remaining envelopes reachable.

## ⚖️ Trade-offs and local implementation — 2 minutes

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Geometry | ✅ Shared page contract | ❌ Container pixels | Same field survives viewport and output changes |
| Recorded feedback | ✅ Durable receipt | ❌ Optimistic completion | Handles ambiguous outcomes accurately |
| Signer access | ✅ Scoped session, live checks | ❌ Token plus cached status | Respects current workflow authority |
| PDF rendering | ✅ Small mounted page window | ❌ All canvases at once | Controls memory while retaining field navigation |
| Tracking | ✅ Bounded refresh first | ❌ Mandatory push infrastructure | Fits initial freshness needs with simpler recovery |

The local project uses React, TanStack Router, Zustand, a one-page 700-pixel viewer, and
draw/type capture. It saves placement clicks immediately in container pixels, has no
zoom/drag editor or request-generation guard, and hides PDF text layers. Its signing
overlays are clickable divs, and no stable operation IDs are sent.

More fundamentally, session bootstrap caches different identifier names from those expected
by signer writes, so the normal field request fails. The worker and audit formats also
mismatch, and final artifact generation is absent. These are documented in
[architecture.md](./architecture.md); they are not capabilities I would claim in this
proposed interview design.

> “The three decisions I would defend are a shared geometry contract, an honest action-reconciliation state, and an invitation journey whose authority remains with the server. Together they keep the interface understandable when the document, device, or network becomes difficult.”
