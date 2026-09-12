# Form Library Comparison — Fullstack System Design

*A 45-minute interview discussion. The design below is a proposal for a robust
comparison product. See [architecture.md](./architecture.md) for the verified
implementation and the features it simplifies or omits.*

## 🎯 Start with the user journey — 5 minutes

> “A developer wants to compare the same form in several UI libraries. They choose
> a form, pick two or three libraries, try the controls, switch themes, and send
> the comparison to a colleague. I would design that complete journey before adding
> infrastructure, because the hardest requirements cross the browser boundaries.”

I would clarify whether the forms are demonstrations or submit real data, whether
examples are curated or user-uploaded, and whether a link must reproduce the exact
selection on another device.

For this discussion, forms are curated demonstrations. There are twenty form types
and about fifty library entries, including an unstyled baseline. We support multiple
form and library selections, two grouping modes, and light/dark themes where the
library provides them.

We do not need account creation, payment processing, shared document editing, or a
server-side comparison database. Typed form values remain transient in each preview.
Comparison settings can be represented in a URL.

This makes the serving workload static, but the frontend is still interactive.
There is substantial engineering in the contracts between the shell, each library
application, and the artifact that delivers them together.

### Requirements and their consequences

| Requirement | Design consequence |
|-------------|--------------------|
| Faithful native controls | Give each library an independent styling boundary |
| Interactive comparisons | Preserve input during ordinary theme changes |
| Exact share links | Specify URL state independently of saved preferences |
| Many possible previews | Bound the number of live documents |
| A dependable catalog | Deploy matching shell and preview artifacts |
| Accessible browsing | Label frames and preserve focus during lifecycle changes |

I would propose shell interactions around 200 ms and first useful content within a
few seconds on an agreed device/network profile. These are targets to measure, not
promises based on framework choice.

## 🏗️ Draw one end-to-end picture — 5 minutes

```
┌─────────────────────┐       ┌─────────────────────┐
│ Source + catalog    │──────▶│ Build, validate,    │
│ library applications│       │ publish release     │
└─────────────────────┘       └──────────┬──────────┘
                                        ▼
                              ┌─────────────────────┐
                              │ Static origin + CDN │
                              └──────────┬──────────┘
                                         │ assets
                                         ▼
┌──────────────────────────────────────────────────┐
│ Browser                                          │
│ ┌──────────────────────────────────────────────┐ │
│ │ Shell: controls, URL state, preview lifecycle│ │
│ └──────────────┬─────────────────┬─────────────┘ │
│                ▼                 ▼               │
│       ┌────────────────┐ ┌────────────────┐      │
│       │ Library A frame│ │ Library B frame│      │
│       │ Native form    │ │ Native form    │      │
│       └────────────────┘ └────────────────┘      │
└──────────────────────────────────────────────────┘
```

The build process produces static entry documents and assets for the shell and each
library. A CDN serves reusable objects, and its origin handles cache misses. There
is no application server deciding which form to render on each request.

The shell runs as a React app. It owns comparison state and uses a small shared store
for controls and preview descriptors. A library app has its own React root and owns
its component state, styles, and theme provider.

I would keep the catalog static initially. Adding a library requires a release;
that is acceptable for a curated showcase. A remotely editable catalog would need
to ensure it only advertises artifacts that are already available.

### Trace the first comparison

1. The browser loads the shell and its catalog.
2. The shell validates the URL and resolves the requested comparison.
3. It lays out cards for the selected form/library pairs.
4. Nearby cards load independent preview documents.
5. Each preview reads its initial configuration and renders the native form.
6. The user interacts locally; a share action captures comparison settings only.

That flow tells us where the three difficult decisions are: the document boundary,
the state contract, and release consistency.

## 💾 Define the contracts — 4 minutes

I would use a small table rather than draw a database that the workload does not
need. Stable IDs connect the shell's catalog to library routes and build artifacts.

| Entity | Important fields | Owner |
|--------|------------------|-------|
| Library | ID, display name, entry path, theme support | Catalog |
| Form | ID, label, expected behavior | Form specification |
| Comparison | Library IDs, form IDs, theme, grouping | Shell URL and store |
| Preview instance | Library/form identity, readiness | Browser preview manager |
| Release | Revision, advertised previews, artifact references | Build pipeline |

The catalog should describe availability explicitly. A library name in a dropdown
is a promise that its selected form can be opened; it should not be an unrelated
hard-coded list maintained separately from release validation.

### External interfaces

| Interface | Purpose |
|-----------|---------|
| Shell GET with comparison parameters | Open a saved comparison in any browser |
| Library GET with form and theme parameters | Open an independent example |
| Static asset GET | Load scripts, styles, fonts, and images |
| Child-ready message | Announce that an embedded application can receive updates |
| Absolute theme-setting message | Update presentation without toggling ambiguously |

For example, the shell can request `forms=user-login`, `libraries=mui,chakra`, and
`theme=dark`. Its MUI frame then opens that library's entry document with
`form=user-login` and the initial theme.

Form data is not part of either sharing or messaging. This avoids turning a simple
comparison contract into an accidental mechanism for collecting entered credentials.

## 🔧 Deep dive 1: isolation that remains usable — 9 minutes

> “I would use iframe documents to preserve each library's native appearance, then
> put a resource budget around active previews. The trade-off is extra browser work
> in exchange for a much more trustworthy comparison.”

Imagine a library whose reset changes every input and another whose popup is styled
through rules injected into the page head. Rendering both in one document can change
what the user sees depending on stylesheet order.

A CSS module around our own components does not automatically contain those rules.
Shadow DOM can help, but it requires library-specific integration for inherited
properties, injected styles, and document-level overlay targets.

I would not reject Shadow DOM because of an assumed React-context limitation.
Context follows the React tree, including through portals. The practical issue is
whether the library's styling and DOM assumptions fit the boundary we provide.

An iframe gives each example an independent document and cascade. That is a close
match to how the library would run in a standalone application and lets developers
open the same preview directly when debugging.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Separate iframe documents | Faithful styling with fewer library-specific adaptations | More documents, runtime state, and focus boundaries |
| ❌ Combine all libraries in one document | Less repeated initialization | Global styles and overlays need compatibility work |
| ❌ Adapt all libraries to Shadow DOM | Potentially lighter boundary | Continuous integration effort as libraries change |

### Distinguish build count from preview count

Fifty library builds can support twenty forms each. Selecting everything creates
one thousand possible documents, even though it reuses about fifty sets of built
assets. Browser caching can reduce repeated transfers without eliminating repeated
DOM creation, event handlers, or layout.

Suppose six nearby previews each need an illustrative 150 KB of JavaScript. That is
about 900 KB before other assets. I would use this as an initial budget discussion,
then profile actual libraries instead of claiming a specific load-time improvement.

### Load only the useful working set

The shell starts with a small default comparison, reserves space for selected cards,
and makes nearby cards eligible to load. A small queue limits simultaneous starts
when the user scrolls quickly or expands a large selection.

I would retain a bounded number of recently used previews. Lazy loading alone only
delays the problem if every visited document remains alive forever.

A preview that becomes far away can be removed when we need its resource budget.
The focused frame remains mounted. We should not erase a document while someone is
filling a field, even if a resize makes it technically fall outside the viewport.

The cost is that an evicted demo can lose its transient input when revisited. I would
accept that for a comparison playground before building a system to persist arbitrary
fields across dozens of unrelated form implementations.

Keeping all visited frames alive would preserve more input, but memory would grow
throughout the browsing session. Destroying every frame immediately on scroll would
cause repeated initialization and surprising resets. Bounded retention provides a
middle ground whose budget we can measure.

### Comparable behavior and accessible navigation

Independent rendering does not guarantee that forms are equivalent. A shared form
specification should describe required fields, labels, and expected error behavior.
The library implementations keep their native controls and layout choices.

I would test a representative invalid submission and keyboard journey as well as a
visual comparison. A screenshot cannot tell us whether an error is announced or a
popup traps focus.

The shell uses ordinary labeled controls, headings, and descriptive frame titles.
A visual row of cards does not require a spreadsheet-style ARIA grid. Users should
be able to move into a preview and back to the comparison controls predictably.

If the product later allows untrusted uploaded code, I would change the trust model.
Same-origin scripted frames are not a strong malicious-code sandbox simply because
their CSS is separate. That expansion requires origin and permission decisions.

## 🔧 Deep dive 2: make sharing and live state agree — 9 minutes

> “I would define comparison state once, serialize it deterministically, and give
> each child a small configuration contract. URL initialization makes an example
> reproducible; live messages make theme changes less disruptive.”

The shell owns selected IDs, requested theme, and grouping. The preview owns typed
values and validation. That separation keeps the parent from trying to manage the
internal state of every component library.

On an ordinary visit without explicit configuration, saved browser preferences are
useful. On a shared comparison, the URL must win. Otherwise two developers can open
the same link and see different libraries or themes.

### Be precise about missing values

There are three different meanings for a list: the user selected nothing, selected
all entries, or did not specify a value. Treating all three as an omitted parameter
makes the result depend on local defaults.

The same issue appears with theme. If we omit light theme because it is the default,
a recipient with a saved dark preference may restore dark instead. A share action
should encode every comparison-defining field, even when it equals a default.

I would validate both URL values and stored values against the current catalog.
Unknown entries should be reported clearly or handled with an explicit fallback.
A renamed or removed library must not produce an undefined component or blank page.

The shell can replace the current history entry as filters change. If stepping
through past comparisons with Back is a requirement, we should create deliberate
entries and handle browser history events. A debounce is useful only for reducing
work; it does not create correct history semantics on its own.

### Initialize first, then synchronize

A newly opened library document reads the form and initial theme from its URL.
Once its application is ready, it announces readiness. The parent responds with
the latest absolute theme value.

```
Shell                          Preview
  │ ── URL: form + theme ─────▶ │
  │                            │ render and install receiver
  │ ◀────── ready ──────────── │
  │ ── set current theme ─────▶ │
  │                            │ preserve local form input
```

This avoids a race where the parent sends a theme update before the child has
installed a message handler. If the user changed theme during loading, the parent
sends the current state rather than replaying obsolete transitions.

An absolute “set dark” operation is idempotent. Repeating it does not reverse the
state. Repeating “toggle” would, so I would not use toggle messages at the boundary.

The receiver validates the origin, sending window, message type, and allowed value.
The protocol stays small: a readiness signal and a theme setting are enough for
this journey. We do not need arbitrary remote function calls.

The parent must avoid updating the loaded frame's `src` for the same theme change.
Changing `src` is a navigation even if a theme message is also sent. Navigation can
reset the document and its input, which defeats the user-experience goal.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ URL initialization and live theme messages | Shareable examples with less input loss | A small validated readiness protocol |
| ❌ URL-only theme updates | Simple and independently reproducible | Reloads repeat work and can reset input |
| ❌ Message-only initialization | Flexible live control | Direct opening needs a separate bootstrap mechanism |

For a light-only library, the requested theme remains part of the comparison state,
but its effective presentation stays light with a clear indicator. We should show
a library's actual capability instead of inventing a dark appearance for it.

### Failure behavior belongs in the contract

An iframe's document load event does not prove successful application rendering.
A readiness timeout can show an unavailable card while other comparisons continue.
The user can retry or open the example by itself.

If browser storage fails, the URL and in-memory settings still work. If the URL is
invalid, the shell provides a useful correction path. Neither should require an
application backend or make every preview unavailable.

## 🔧 Deep dive 3: keep the delivered catalog consistent — 8 minutes

> “The frontend contract depends on the release artifact. If the shell advertises a
> library whose build failed, the page can look healthy while its main feature is
> broken. I would publish a validated set of matching shell and preview assets.”

I would build each library independently. This allows its dependency and styling
setup to evolve without forcing every library into a single application bundle.
The cost is repeated dependencies and build orchestration.

A worker pool bounds the number of simultaneous compiler processes. The right size
comes from measured peak memory and CPU. Launching every compiler together risks
out-of-memory failures; doing everything sequentially can make feedback too slow.

For example, fifty thirty-second jobs need about twenty-five minutes sequentially.
Four ideal workers need roughly six and a half minutes before other work. I would
use that arithmetic to discuss a build target, not assert an unmeasured three-minute
pipeline.

### Validate what the browser will actually load

Successful outputs go into a clean staging area for one release. A manifest maps
advertised library IDs to their entry documents. We verify those documents and their
asset references under the production base path.

This avoids copying stale per-library output after a failed rebuild. It also catches
an easy local-development mistake: the shell server is healthy, but it does not
serve the independently built library paths that the production shell references.

The smoke test should open the assembled site and wait for actual preview content,
not merely check for an iframe element. A missing document can still occupy a
perfectly visible frame container.

My initial release rule would require every advertised library to succeed. An
explicit partial release is possible, but the shell catalog must then reflect the
reduced available set. Silent partial success is a poor fit for a comparison tool.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Publish one complete validated release | Shell and preview availability agree | One required failure can delay publication |
| ❌ Copy whatever outputs exist | Simple assembly | Missing or stale previews can be advertised |
| Alternative: manifest-driven partial catalog | Releases can proceed with unavailable libraries | More product states and release coordination |

### Caching is part of release correctness

Content-hashed asset names let browsers reuse unchanged bytes and fetch changed
ones under new URLs. HTML needs an appropriate revalidation or short-freshness
policy where the host supports it.

Hashes do not make deleting old files safe immediately. A browser holding an old
entry document can still request one of its old assets after deployment. We should
retain referenced assets for a defined compatibility window or use release-specific
paths and a recovery strategy for stale clients.

The host's actual cache behavior needs verification. I would not claim that choosing
GitHub Pages automatically configures custom immutable headers or instantly updates
every user's document.

Publishing a complete artifact should leave the previous complete artifact available
for rollback. If validation fails, keep the old release serving. If two builds race,
prevent an older revision from becoming current after a newer one.

These release controls cost artifact storage and validation time. They are justified
because static delivery removes many runtime failure modes but still leaves real
cross-version and missing-asset failures.

## 📊 Verify the journey and discuss growth — 4 minutes

I would validate the system with a few cross-boundary scenarios:

- A comparison link opened in a clean browser reproduces the sender's selection.
- A theme change during loading and after typing ends in the correct presentation.
- Scrolling through many selections leaves a bounded number of live documents.
- A failed preview renders an actionable card without disabling the shell.
- A broken library build cannot publish a catalog that silently links to it.
- An old open document still works, or recovers predictably, after a new release.

I would track shell interaction latency, preview readiness, active document count,
and asset failures by release. On the build side, I would track duration and failures
by library. Those signals tell us whether to optimize the browser, compilation,
or distribution.

The first growth problem is likely to be browser resources or the maintenance cost
of equivalent forms. More CDN capacity helps traffic, but it does not fix too many
active React roots in a tab. More build workers help only while the runner has
resources and the work can execute independently.

If users later need saved team comparisons, I would add a small server-owned record
for a named comparison and its access rules. The static preview architecture could
remain. I would not add that database before the user journey requires it.

> “The design connects three guarantees: each library renders faithfully, a link
> and live updates express the same comparison, and a release contains the previews
> its shell promises. Iframes, bounded preview loading, a small state protocol, and
> complete static artifacts support those guarantees. Each has a cost, but the
> boundaries keep the product understandable and give us clear places to measure
> failures before adding more infrastructure.”
