# Gallery — frontend system design interview

A proposed 45-minute design conversation for an image gallery with tiles, masonry, a
slideshow, and a lightbox. The local repository is a 50-image layout demo; production
improvements below are explicitly proposed.

## 🎯 Scope and requirements — 4 minutes

> “I’ll design a gallery where someone can scan thumbnails, switch the layout,
> inspect a photo, and return to the same place. The hard parts are loading the
> right bytes, preserving the user's position, and making the viewer usable with
> a keyboard as well as a pointer.”

I would first ask whether images have a meaningful order. A collection of unrelated photos
can accept column-first masonry; a chronological album needs a predictable sequence. I
will support one explicit metadata order, with tiles as the default and masonry as an
optional presentation with a clearly understood visual flow.

The core scope is browsing, three layouts, a lightbox, responsive images, keyboard
navigation, and controlled slideshow playback. Upload processing is an API boundary for
this frontend answer. Editing, social features, visual search, pinch zoom, and
collaborative albums can be follow-ups.

I assume a small first page of around 30 images and a gallery that may grow to thousands.
The interface must not mount every photo or download originals just because the metadata
list is large. The backend provides oriented dimensions, text alternatives, available
variants, and a stable listing context.

My goals are p75 first visible image within 2.5 seconds on a defined mobile/network
benchmark, p75 layout shift below 0.1, and p95 local navigation feedback below 100
milliseconds. Image transfer and decode may take longer; controls must remain responsive
and communicate that loading state.

The design must work when an image fails, the next page is slow, a selected photo is
deleted, and keyboard focus returns from the lightbox. I would also define the privacy
model before storing media or signed URLs in long-lived browser caches.

| Journey | Expected behavior |
|---|---|
| Open gallery | Stable image slots and prioritized first visible content |
| Change layout | Preserve image identity/order and a useful scroll anchor |
| Open lightbox | Move focus into the viewer and isolate background interaction |
| Navigate images | Follow the same collection, including unloaded neighbors |
| Close viewer | Return focus and position to the initiating image |
| Image/page fails | Keep useful content and offer a bounded retry |

## 🏗️ Architecture and state ownership — 5 minutes

I would draw the metadata, rendering, and viewer boundaries rather than every component in
the visual tree.

```
┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐
│ Gallery route / state  │ ──▶ │    Layout adapters     │ ──▶ │     Image loaders      │
└────────────────────────┘     └────────────────────────┘     └────────────────────────┘

┌────────────────────────┐     ┌────────────────────────┐
│  Metadata query layer  │ ──▶ │  API / image delivery  │
└────────────────────────┘     └────────────────────────┘
```

The route identifies the gallery and a selected image when deep linking is useful. A
metadata query layer owns fetched pages, listing revision, loading/error states, and
cancellation. UI state owns layout choice and viewer selection. Individual image loaders
own transfer/decode status for a specific resource generation.

The layouts receive the same ordered image IDs and metadata map. They do not each fetch
their own differently ordered dataset. The lightbox receives the same listing context, so
“next” means the next image in that gallery rather than the next item in whichever array
happened to be mounted.

I would keep selected image identity separate from list position. An array index changes
meaning when uploads or deletions alter the list. The selected ID can remain stable while
its current position and neighboring IDs are recomputed.

The slideshow's playback state belongs to a controller that also knows whether its view is
active, a modal is open, the page is hidden, or user interaction has paused rotation. That
gives one place to decide whether the timer may advance. A bare interval cannot express
those conditions safely.

For a small fixed gallery, React state or a small external store is sufficient. I would
not introduce a query cache until there is actual server metadata to cache. If using
Zustand, select only relevant fields; subscribing to the entire store does not magically
prevent rerenders.

Route, account, and listing generations scope asynchronous work. An old page request or
image decode cannot overwrite a new gallery after navigation. Abort requests where
possible and also check generation before committing results, because cancellation alone
cannot undo a completion already queued.

## 💾 Data model and view state — 4 minutes

| State | Contents | Why it is separate |
|---|---|---|
| Image metadata | ID, generation, oriented dimensions, alt/caption | Identity and geometry independent of bytes |
| Variant descriptor | Profile, format, encoded dimensions, URL | Different display contexts need different resources |
| Listing context | Gallery, sort, revision/cursor, ordered IDs | Stable navigation and pagination |
| Layout state | Tiles/masonry/slideshow choice, scroll anchor | Presentation should not redefine collection identity |
| Viewer state | Selected ID, origin focus target, navigation status | Modal lifecycle and return path |
| Playback state | User intent, pause reasons, current slide | Predictable automatic rotation |
| Resource state | URL/generation, loading/decoded/error | Ignore stale completion and isolate image failure |

Metadata dimensions describe the image after orientation normalization. For tiles, the
chosen crop has a square slot; for masonry and full viewing, display profiles preserve the
source composition. Different crops are not mixed into one responsive candidate list
merely because their URLs have different widths.

Width and height reserve layout space before pixels arrive. A blurred preview can improve
appearance but does not replace that geometry. I would use the same aspect ratio for the
placeholder and final image so decode does not resize the page.

A loading image and a loading metadata page are different states. One failed photo should
not erase the entire gallery. A failed next-page request should leave already loaded
images usable and provide a retry at the paging boundary.

For a listing with changes, I would choose an explicit session/revision policy. If an
exact browsing session becomes invalid, refresh it visibly while preserving the selected
ID when still available. A keyset cursor avoids some offset problems, but it does not make
a mutable collection an immutable snapshot.

## 🔌 API and loading contract — 4 minutes

| Proposed endpoint | Frontend need | Important boundary |
|---|---|---|
| GET `/api/v1/galleries/:id/images` | Bounded metadata page and opaque continuation | Bind to gallery, sort, and listing policy |
| GET `/api/v1/images/:id` | Selected image and current available variants | Check current access even for cached navigation |
| GET `/api/v1/uploads/:id` | Processing/ready/failed state if uploads are added | Transfer complete is not display ready |

The client treats a cursor as opaque. It preserves the query context on subsequent
requests and does not combine an old cursor with newly selected filters or order. When a
page arrives, merge by image ID and resource generation, preserving server order rather
than relying on load completion order.

A variant descriptor contains actual encoded dimensions. The frontend supplies its
rendered slot width to browser candidate selection. A 180 CSS-pixel tile on a 2× screen
may justify approximately 360 encoded pixels, subject to available variants and bandwidth
policy. Selecting a size from viewport width alone can substantially overfetch or blur the
result.

I would use format-specific responsive sources with a fallback. Within each source set,
candidates represent the same crop and aspect ratio. The browser chooses a supported
format and resolution; the application should not always pick the largest URL or assume
one codec is best for every image.

Image URLs and metadata may have different cache lifetimes. Short-lived private delivery
authority must be refreshed under current access. A stale signed URL should produce a
scoped retry/reauthorization path, not an unlimited reload loop.

## 🔧 Deep Dive 1: Layout density versus stable order — 7 minutes

> “For the fixed demonstration, CSS columns are a good way to show varied heights.
> For a growing chronological collection, I would be more careful: balancing
> columns can move content the user was already looking at.”

Tiles have a straightforward row-major order and stable square slots. A responsive grid
changes the number of columns at defined breakpoints or according to a minimum cell size.
Cropping is deliberate; the lightbox should offer a composition-preserving view so a tile
crop does not become the only available representation.

Masonry optimizes density by allowing different heights. CSS columns flow down one column
before continuing in the next, and the browser balances content. They do not create the
same reading order as a row-major grid with gaps filled. I would explain this to the
interviewer using six differently sized images.

Appending more items can change the balanced column height and relocate earlier items.
Missing intrinsic dimensions can cause further reflow as each image loads. Neither is
fixed merely by avoiding JavaScript layout code. Reserving dimensions addresses the second
problem; the collection/order policy must address the first.

For an ordered long feed, I would start with tiles or an explicitly positioned masonry
layout built from known metadata. Keep DOM order meaningful and document how it relates to
visual placement. A shortest-column algorithm may improve density, but it does not
guarantee left-to-right visual chronology by itself.

JavaScript positioning has costs: resize handling, measured container widths, layout
caching, and focus/virtualization integration. Those are manageable when measurements and
writes are batched. It is inaccurate to say every layout library must thrash the browser
or recalculate after every image decode.

On a layout switch, I would capture a stable anchor image and its relative viewport
offset. After the new layout is ready, find that image and restore an approximate
position. The exact old scrollTop belongs to a different geometry and may point to an
unrelated photo after the switch.

For thousands of items, separate pagination from virtualization. Pagination bounds
network/metadata work; virtualization bounds mounted elements. Native image lazy loading
only influences resource fetching. A page with 10,000 lazy image tags can still have
expensive DOM, layout, and memory behavior.

I would introduce row-based virtualization for tiles first because row geometry is
predictable. Masonry needs visible-range lookup by positions and conservative overscan.
Its position cache is tied to the container width and metadata revisions; a responsive
resize invalidates that geometry.

Focused and selected items need special treatment. If an element containing focus is
removed from the virtualized window, keyboard navigation can become disorienting. Keep it
mounted temporarily or move focus intentionally. On lightbox close, restore the initiating
item to the rendered range before focusing its button.

The cost of a more stable layout is sometimes empty space or less dense packing. For a
chronological gallery where location matters, that can be a better choice than a perfectly
filled wall that keeps rearranging itself.

| Approach | Why it fits | What it gives up |
|---|---|---|
| ✅ CSS columns for a small unordered collection | Simple native layout with varied heights | Column-first flow and rebalancing |
| ✅ Tiles for long predictable browsing | Stable slot geometry and simpler virtualization | Cropped previews and less variety |
| ❌ Positioned masonry before measuring need | Fine-grained placement control | More geometry/cache/focus complexity than a small demo needs |

## 🔧 Deep Dive 2: Image bytes, decode, and preloading — 7 minutes

> “The gallery should download a useful preview first, reserve its space, and
> fetch higher detail only when someone asks to inspect the image.”

I would prioritize the first visible or hero image and lazy-load offscreen grid items.
Marking every image lazy can delay the very content defining the page's initial
experience. Conversely, preloading every full-resolution photo competes with the first
image and wastes bandwidth when the user leaves early.

The display slot determines the candidate width. For masonry, the slot depends on
container width, columns, and gaps. For a constrained desktop gallery, saying 100vw for
every image can make the browser select unnecessarily large resources. Responsive layout
and the sizes hint must evolve together.

Image format selection also needs a measured policy. AVIF or WebP can reduce bytes, but
encode/decode cost and visual quality depend on content and settings. Preserve fallbacks
and avoid claiming a universal percentage saving. Use immutable resource generations so
replacing an image cannot serve new bytes under an old cache key.

The image loader tracks requested identity and resource generation. If the user clicks
next three times quickly, a slow decode for the first request cannot replace the latest
selected photo. Keep the requested caption/counter coherent with the loading state; do not
show one photo under another photo's description.

I would preserve a reserved placeholder while the current resource loads, then reveal it
once decoded. A decode failure produces a labeled fallback and retry. A broken thumbnail
should not prevent opening a still-valid larger rendition, but the retry path must remain
bounded if the whole image was removed.

For slideshow/lightbox navigation, preload a small adjacent set after the current image is
ready. Prefer the next likely candidate and perhaps the previous one, using the same
rendition the viewer will request. Downloading an 80-pixel thumbnail is not equivalent to
preloading a 1920-pixel lightbox image.

Preloading does not guarantee an instant transition: network and decode may still be
incomplete, and the browser can evict resources. Keep loading feedback even on a warmed
path. Disable or reduce speculation under constrained-data policies and when the viewer is
closed or the page is hidden.

Decoded image memory can dwarf transfer size. Bound the number and resolution of resources
held by application references, release old preloads, and profile long viewing sessions.
Clearing an application reference is not a promise of immediate browser cache eviction,
but retaining every decoded image guarantees needless work.

The same lifetime rules apply to image subscriptions and observers. Cancel or ignore old
work on gallery switches. Avoid a global cache keyed only by image ID if different
generations, tenants, or crops can share that ID in different contexts. Cache metadata and
media authority according to their actual privacy scope.

| Approach | Benefit | Cost |
|---|---|---|
| ✅ Responsive profiles and bounded adjacent preload | Lower initial bytes and faster likely navigation | Candidate selection and lifecycle management |
| ❌ Originals everywhere | Simple URL selection and maximum detail | Large transfer/decode cost for tiny slots |
| ❌ Preload the entire gallery | Some navigation may be warm | Competes with useful content and increases memory pressure |

I would evaluate bytes delivered per visible image, LCP, layout shift, navigation decode
time, and retained memory together. A lower network payload is not a complete success if
the selected codec causes slow interactions on the target devices.

## 🔧 Deep Dive 3: Lightbox, keyboard ownership, and playback — 7 minutes

> “A full-screen-looking div is not automatically a modal. I would make opening
> and closing the lightbox a complete focus and navigation transition.”

When an image button opens the viewer, record its stable ID and focus target. Move focus
to an appropriate control inside the dialog, give the viewer a meaningful name, and
prevent background interaction. Tab and Shift+Tab remain within the modal; Escape and an
obvious close button leave it.

Closing restores focus to the initiating image if it still exists. If pagination or
virtualization removed it, first restore its rendered range. If the image was deleted,
focus a sensible surviving neighbor or gallery control. Returning focus to a detached node
does not complete the user's workflow.

I would use one tested modal controller for scroll locking, focus containment,
restoration, and stacking. Root-level placement can be sufficient; a portal can avoid
particular ancestor clipping contexts when needed. A portal does not itself provide
accessibility or guarantee precedence over every browser top-layer element.

React context continues through a portal because the React tree is preserved. DOM styling
inheritance may change with placement, and events still follow the React ancestry. Those
are integration details to handle deliberately, not reasons to move all gallery state into
a global store.

Keyboard commands have one active owner. While the viewer is open, its arrows navigate
images and the underlying slideshow's handler is suspended. Outside the viewer, shortcuts
are scoped to the intended region and avoid intercepting text inputs or unrelated focused
controls.

The view selectors are either ordinary labeled buttons or a complete tab pattern. If
implemented as tabs, define tablist/selected/tabpanel relationships and roving keyboard
behavior together. Merely drawing an underline does not establish a screen-reader tab
interface.

Autoplay begins only after an explicit user request. Entering keyboard focus or hover
pauses rotation, and it does not restart unexpectedly. Opening a modal, switching view, or
hiding the document also pauses it. Reduced-motion preferences limit transitions and
automatic behavior; the play/pause control remains available.

I would advance with a controller that considers whether the next image is ready. If it is
slow or failed, keep a coherent status and allow manual navigation rather than racing
through blank images on a fixed timer. The control's accessible name announces the action
it performs, such as starting or stopping rotation.

Announce manually selected slide changes concisely. Continuous automatic changes should
not flood a screen reader's live region. Thumbnail controls need descriptive names and a
deliberate tab strategy so a long strip does not impose hundreds of tab stops before the
main controls.

Deep links can encode the selected image in the route. Opening adds a history entry when
appropriate, and Back closes the viewer before leaving the gallery. A direct link has no
originating thumbnail, so its close action returns to the gallery route rather than
navigating to an unrelated previous site.

| Approach | Benefit | Cost or failure |
|---|---|---|
| ✅ One modal/playback controller | Clear focus, keyboard, and timer ownership | More lifecycle work than visual CSS alone |
| ❌ Independent global key handlers | Easy to attach in each component | One key can advance hidden and visible viewers |
| ❌ High z-index as the complete modal design | Quick visual overlay | Leaves focus, background interaction, and return path unresolved |

## 🧪 Performance and failure validation — 5 minutes

I would test a small fixed gallery first, then a long collection with mixed aspect ratios
and slow images. The important cases include first load, layout switch, lightbox
navigation, next-page failure, and returning focus after virtualization.

| Test | Expected outcome |
|---|---|
| Images arrive out of order | Metadata/slot order stays stable |
| Rapid next/previous navigation | Only the current image generation becomes visible |
| Image fails | Reserved placeholder, meaningful error, usable navigation |
| Layout switches after scrolling | Anchor image remains near the user's position |
| Keyboard opens/closes viewer | Focus stays inside, then returns logically |
| User focuses autoplay controls | Rotation stops and requires deliberate restart |
| Gallery/account changes during a request | Old results cannot populate the new context |
| Selected image is deleted | Explain removal and move to a valid navigation state |

Use browser traces to separate metadata latency, network transfer, decode, layout, and
painting. Measure on target devices; screenshots cannot establish frame rate, keyboard
behavior, or download prioritization. Include long-session memory checks because
preloading and retained page caches can accumulate gradually.

I would validate text alternatives with actual content descriptions rather than only image
numbers. Test touch targets, zoomed text, reduced motion, contrast, and screen-reader
announcements. A library or ARIA attribute does not certify the whole interaction without
exercising it.

For uploads added later, keep pending local previews separate from published items.
Transfer progress reaching 100% means bytes were sent, not that variants are ready. The
frontend polls the upload state and inserts the server's stable image identity only under
the agreed listing revision behavior.

The first implementation order is coherent state/identity, stable slot geometry, scoped
viewer behavior, then responsive selection and bounded paging. Add positioned masonry and
virtualization when profiling demonstrates their value. That sequence keeps each
optimization tied to an observed user-facing problem.

## ⚖️ Trade-offs and close — 2 minutes

| Decision | Chosen approach | Alternative |
|---|---|---|
| Small masonry collection | ✅ CSS columns with explicit ordering caveat | ❌ Claiming native layout never shifts |
| Image resources | ✅ Appropriate variants and bounded preload | ❌ Download all originals |
| Viewer behavior | ✅ Focus/keyboard/playback lifecycle | ❌ Visual overlay alone |
| State | ✅ Stable IDs and scoped requests | ❌ Independent indices in every layout |

> “The gallery's quality comes from preserving identity, geometry, and user control
> while image bytes arrive asynchronously. I would prove those boundaries before
> introducing a complex layout engine or aggressive preloading.”

The repository currently implements fixed URLs, native grid lazy loading, simple store
state, and an inline overlay. Responsive candidates, reliable modal focus, metadata
paging, and coordinated playback remain proposed improvements documented in
[architecture.md](./architecture.md).
