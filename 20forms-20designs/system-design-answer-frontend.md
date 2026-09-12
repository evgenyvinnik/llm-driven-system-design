# Form Library Comparison — Frontend System Design

*A 45-minute interview discussion. This is a proposed design; the current source
and its limitations are documented in [architecture.md](./architecture.md).*

## 🎯 Clarify the problem — 5 minutes

> “I want to help a developer compare how several component libraries implement
> the same form. The comparison is only useful if each library looks and behaves
> as it would in a standalone application. I would start with that requirement,
> because it determines where I put the rendering boundary.”

I would clarify three things with the interviewer before drawing the system:

1. Are the examples maintained by our team, or can users upload arbitrary code?
2. Are people comparing appearances, interactive behavior, or both?
3. Must a shared link recreate the exact comparison on another person's browser?

For this discussion, I will assume curated, interactive examples and exact sharing.
The product supports twenty forms and roughly fifty comparison entries, including
an unstyled reference. Users select several forms and libraries, group the results,
and switch themes where the library supports them.

Login and checkout are demonstrations. We are not creating accounts, processing
payments, or storing what users type into the examples. Those requirements would
change both the data model and the trust boundary.

The main user journey is simple: select a login form, choose two libraries, compare
their controls, try a validation error, switch theme, and share the result.

### What success means

| Requirement | Why it matters |
|-------------|----------------|
| Independent styling | A comparison corrupted by another library is misleading |
| Responsive controls | A heavy preview must not make selection feel stuck |
| Reproducible links | The recipient should see the sender's intended comparison |
| Keyboard access | Each preview is an interactive document, not an image |
| Visible limitations | Unsupported themes and unavailable previews must be clear |

I would propose a shell interaction target around 200 ms and then agree on a device
and network profile. I would measure preview readiness separately: downloading an
iframe document does not prove that its React app has rendered successfully.

I would not promise that a thousand active frames will perform well. Twenty forms
across fifty entries produce a thousand possible previews, so controlling how much
of that matrix is alive is part of the design.

## 🏗️ Draw the architecture — 5 minutes

I would draw the shell and two representative previews. More library boxes would
repeat the same boundary without explaining another decision.

```
┌──────────────────────────────────────────┐
│ Shell                                    │
│ Controls ──▶ Comparison state ──▶ Cards  │
│                    ▲                     │
│                    │ URL + preferences   │
└───────────┬──────────────────┬───────────┘
            │                  │
            ▼                  ▼
    ┌──────────────┐   ┌──────────────┐
    │ Library A    │   │ Library B    │
    │ Own document │   │ Own document │
    │ Native forms │   │ Native forms │
    └──────────────┘   └──────────────┘
```

The shell is responsible for selection, grouping, navigation, and preview lifecycle.
Each library app owns its form components, theme provider, styles, and input state.
Both are static applications served through the same delivery system.

I would use React for the shell and a small store such as Zustand for comparison
settings shared by the controls and cards. Ordinary React state remains appropriate
for a selector's open/closed state or a card's local display details.

Choosing a store is not the main performance solution. Every mounted iframe still
creates another document and application instance. Avoiding an unnecessary shell
render cannot compensate for hundreds of expensive previews.

### State ownership

| State | Owner | Persistence |
|-------|-------|-------------|
| Selected form and library IDs | Shell comparison state | URL and optional saved preferences |
| Requested theme and grouping | Shell comparison state | URL and optional saved preferences |
| Library metadata and form labels | Static catalog | Build artifact |
| Preview readiness and last use | Preview manager | Memory only |
| Typed form fields and validation | Individual library app | Transient within its document |

I would store stable IDs and derive the selected catalog entries. Storing another
copy of the filtered catalog creates an unnecessary synchronization problem.

The first request loads the shell. The shell parses the comparison, constructs
preview descriptors, and starts the nearby frames. Each frame loads its library
app and renders the requested form.

## 🔧 Deep dive 1: preserve native styling — 8 minutes

> “I would use a separate iframe document for each active preview. The extra
> document is a real cost, but preserving native library behavior is the product's
> central requirement. I would spend the complexity budget on controlling those
> documents rather than adapting every library's styling internals.”

Consider two libraries that both reset body margins, choose default fonts, and
inject styles for overlays. In a shared document, stylesheet order can change what
the comparison shows. A developer might reject a library because our integration
altered its controls rather than because of the library itself.

CSS Modules help with class-name collisions in code we own. They do not automatically
contain global resets or third-party stylesheets. Rewriting every selector also
creates maintenance work whenever a library changes its CSS.

Shadow DOM is a more serious alternative. It can contain selectors, but inherited
properties, style injection, and menus rendered outside the shadow root need
intentional integration. Some libraries support that well; others assume a global
document and portal target.

I would avoid saying that React context inherently stops at a shadow boundary.
Context follows the React component tree; a portal can preserve it even when DOM
placement changes. The integration concern is how the library uses styles and DOM
APIs, not an automatic failure of React context.

An iframe gives the library its own document, stylesheet cascade, and React root.
Its reset applies to its own example. We can open that document directly to inspect
whether a problem belongs to the library app or the surrounding shell.

### What the choice costs

| Approach | Benefit | Cost for this product |
|----------|---------|-----------------------|
| ✅ Separate iframe documents | Native document-level styling and independent debugging | More memory, initialization, and focus boundaries |
| ❌ Shared document with CSS Modules | Fewer application roots | Third-party global styles remain a compatibility problem |
| ❌ Shadow DOM integration for every library | Potentially lighter previews | Ongoing work for styles, inherited values, and overlays |

Separate documents do not guarantee separate operating-system processes or that
CPU-heavy code cannot affect perceived responsiveness. I would measure the real
browser behavior instead of describing frames as free execution isolation.

We also pay for some duplicated assets. Caching may reuse a library's bytes across
multiple forms, but the runtime state is still separate. Sharing a single React
runtime across documents would add coupling and would not remove the DOM cost.

### Keep comparison semantics consistent

The visual boundary alone does not produce a fair comparison. We need a small form
specification describing labels, required fields, and expected validation behavior.
For login, that might be an identifier, password, remember-me option, and an invalid
submission state.

Each library implements that behavior with its native controls. A universal wrapper
that flattens every library into identical markup could hide the differences users
came to evaluate.

I would test representative behaviors as well as screenshots. A screenshot can show
that a field exists; it cannot establish keyboard interaction or when an error is
announced. Library-specific behavior should be explained when exact parity is not
possible.

### Define the trust boundary

These are curated examples, so style fidelity is the immediate requirement. If the
interviewer changes the scope to arbitrary uploaded code, I would revisit origins,
sandbox permissions, and resource limits before accepting that feature.

Same-origin frames with scripts and same-origin access enabled do not provide a
strong hostile-code sandbox. That distinction matters even though this design does
not require a full plugin-security architecture.

## 🔧 Deep dive 2: bound browser work — 9 minutes

> “The first scaling limit is likely to be the user's browser. I would load previews
> near the viewport and keep a bounded set of recently used documents. Loading
> everything eventually is still a memory problem if nothing is ever released.”

I would begin with a modest default selection. A new visitor should see a useful
comparison immediately rather than wait for the entire catalog.

For planning, suppose six nearby frames need 150 KB of compressed JavaScript each.
That is roughly 900 KB before the shell, CSS, and fonts. This is an illustrative
transfer estimate, not a measured bundle size or a prediction of interactive time.

More importantly, selecting fifty libraries and twenty forms can create a thousand
application instances if we render the entire matrix eagerly. The same asset might
come from cache many times while initialization and layout still overwhelm the page.

### Preview lifecycle

I would describe the lifecycle with five states:

1. A selected preview starts as a placeholder with reserved dimensions.
2. Near the viewport, it becomes eligible for loading.
3. A limited number of eligible previews begin loading at once.
4. A readiness signal marks the application usable.
5. A far-away, unfocused preview can be evicted when the retention budget is full.

Intersection Observer can detect proximity. A small loading queue limits bursts
when several cards become visible together. Scrolling a little farther should not
start dozens of expensive documents simultaneously.

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│ Placeholder │──▶│ Loading     │──▶│ Ready       │
└──────▲──────┘   └──────┬──────┘   └──────┬──────┘
       │                ▼                 │
       │          Unavailable             │ far away + over budget
       └──────────────────────────────────┘
```

A load timeout should make the card actionable, with retry and standalone-open
options. It should not leave an endless spinner or disable unrelated previews.

I would reserve a sensible size by form category and allow scrolling for longer
forms. Automatic child resizing is possible, but introduces another cross-document
protocol and can create layout shifts. It is not necessary for the first version.

### Retention versus state preservation

Keeping every visited frame alive makes revisiting convenient. It also means that
one long browsing session can retain the whole catalog. Hiding a frame with CSS
is not the same as releasing its document.

Eviction bounds memory, but a remounted form loses its transient input. For a
comparison playground, that can be acceptable if we preserve the focused preview
and make the lifecycle predictable. I would not extract passwords or billing fields
into a global persistence layer merely to preserve a demo.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Nearby loading with bounded retention | Predictable resource use and useful revisits | Some evicted forms reset on return |
| ❌ Keep all visited frames alive | Stronger transient input preservation | Memory grows throughout the session |
| ❌ Immediately destroy every offscreen frame | Lowest retained document count | Repeated loads and lost input during small scrolls |

I would tune the budget after profiling a heavier library and a long form on a
representative laptop and lower-powered device. There is no universally correct
number of retained documents.

### Avoid avoidable remounts

A preview's identity is its library/form pair. Its React key should not change just
because the user requests another theme. A stable key helps only while the component
remains in a compatible parent position; moving it between different grouping
containers can still remount it.

If preserving drafts across regrouping becomes important, I would keep a stable
preview layer and change layout metadata. Otherwise, I would accept and explain a
reset on regrouping rather than build complex DOM caching prematurely.

Selective store subscriptions and memoized descriptors can reduce shell work after
that lifecycle is under control. I would profile first; splitting a small context
can also be adequate, so Zustand is a practical choice rather than a prerequisite.

## 🔧 Deep dive 3: make sharing and theme changes reliable — 8 minutes

> “I would use URLs to reconstruct a comparison and messages to update a loaded
> preview. A theme toggle should not erase an example the user is interacting with.
> A copied link should not depend on the recipient's previous preferences.”

The shell URL contains form IDs, library IDs, theme, and grouping. A direct preview
URL contains one form and the initial theme. These are related interfaces with
different purposes.

For example, a shell link can request the login form in MUI and Chakra. The shell
then constructs one child URL for each library. Each child can also be opened by
itself, which makes debugging and sharing an individual example straightforward.

### Resolve state deterministically

On first load I would apply a documented order:

1. Validate explicitly supplied URL values against the catalog.
2. For fields absent from an ordinary visit, consider validated saved preferences.
3. Use stable defaults for anything still missing.
4. Serialize all comparison-defining fields when producing a share link.

An empty list, an all-selected list, and an omitted parameter are different states.
If we omit the all-selected list, a recipient might see their saved three libraries
instead of the sender's fifty. Omitting light theme can similarly restore a saved
dark preference.

Unknown IDs should produce a helpful message or a documented fallback. Persisted
preferences can outlive catalog entries, so they need validation too. If storage is
unavailable, the URL and in-memory state are sufficient to keep the product usable.

I would replace the current history entry while the user adjusts filters. If product
requirements include stepping through saved comparisons with Back, I would add
explicit history entries and handle browser navigation. Debouncing is a separate
optimization; replacing history does not append an entry for every click.

### Keep a loaded preview synchronized

The child reads its initial theme before rendering, then signals readiness. The
parent replies with the latest absolute theme value. If the user toggled twice
while the child loaded, it receives the current value rather than replaying two
possibly stale toggles.

An absolute “set dark” message is safe to apply repeatedly. A “toggle theme” message
is not: duplicate delivery would reverse the user's intent.

Both sides validate the sending origin, window, and allowed message values. Messages
need not include typed form data. A small theme protocol is easier to reason about
than a general remote component-control interface.

The parent must also avoid changing the loaded frame's `src` when sending the theme.
Otherwise the browser can navigate the document despite the message, resetting
input and negating the reason to use live updates.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ URL bootstrap plus live theme updates | Standalone links and better input continuity | Readiness and validation protocol |
| ❌ Reload the frame for every theme change | Very simple lifecycle | Can erase input and repeat initialization |
| ❌ Messaging as the only configuration | Flexible live control | Standalone loads still need another initialization contract |

A library marked light-only should remain light with a clear badge. A dark theme
request does not justify applying a generic inversion filter that misrepresents
what that library actually supports.

## ♿ Accessibility and failure behavior — 5 minutes

The shell should use labeled form controls and ordinary document navigation.
Each iframe needs a descriptive title containing the library and form name, and
each comparison group needs a meaningful heading.

I would keep a predictable tab order and a route back to the comparison controls.
I would not add an application role or a spreadsheet-style ARIA grid simply because
cards are visually arranged in columns. Those roles imply keyboard behavior that
this browsing interface does not need.

Focus also constrains virtualization: do not remove a document while someone is
typing in it. Global shortcuts must not steal typing or selection gestures from
form fields inside a preview.

The shell's accessibility is only half the product. I would test keyboard and
screen-reader behavior inside representative library forms, especially errors,
menus, and dialogs. We can report observed behavior without claiming that every
library automatically conforms to an accessibility standard.

A failed frame should display its library/form identity and a recovery action.
An empty selection should explain how to add a preview. A storage failure should
not make the whole shell fail to initialize.

## 📊 Validation and closing discussion — 5 minutes

I would verify a small set of user journeys before adding more optimizations:

- Share a comparison into a clean browser with different saved preferences.
- Change theme while a preview loads and after entering form data.
- Scroll through a large selection and confirm mounted document count is bounded.
- Deselect or regroup while a preview has keyboard focus.
- Fail one library asset and confirm the other previews remain usable.

For performance, I would separate network transfer, application readiness, shell
interaction latency, and retained memory. Cache hits alone cannot demonstrate that
the comparison remains responsive.

For visual correctness, I would compare a preview opened alone with the same preview
inside a mixed-library selection. That directly tests the reason for the isolation
boundary rather than just asserting that an iframe element exists.

If the interviewer asks what breaks first, I would point to browser resources and
catalog maintenance. CDN traffic can grow independently; more servers do not solve
hundreds of live documents in one user's tab.

> “My design keeps the shell small and makes each library responsible for its own
> faithful preview. Iframes give us document-level style isolation, bounded loading
> keeps that choice affordable, and a deterministic URL plus a small theme protocol
> makes the comparison reproducible. The main concession is that an evicted preview
> can lose transient input; I would accept that before retaining the entire catalog.”
