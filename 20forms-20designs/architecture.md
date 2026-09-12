# 20 Forms, 40+ Designs — Architecture

## System Overview

A form comparison application places independently built React component-library
examples inside a shared browser shell. Its central requirement is rendering
fidelity: a preview should use its library's native controls and styles without
another preview changing them. The important system-design problems are document
isolation, browser resource management, state synchronization, and reliable static
releases.

This is a documentation-only entry in this repository. The **production design**
below describes a robust version of the application. The final **Implementation
Notes** document what the external source actually does, including gaps. Proposed
features and performance targets are not claims about the deployed demo.

The source review used upstream commit
[`bc34aba76a4cabe9bfe545bc8dccf3689808e482`](https://github.com/evgenyvinnik/20forms-20designs/tree/bc34aba76a4cabe9bfe545bc8dccf3689808e482)
on 2026-09-09. Paths in the implementation section refer to that repository.

## Requirements

### Functional requirements

- Compare selected form types across multiple component libraries.
- Group previews by form or library and identify unsupported themes.
- Share the exact comparison through a URL and retain personal preferences locally.
- Keep each library independently runnable for debugging and review.
- Publish a complete static release without introducing a form-submission backend.

### Non-functional requirements — proposed targets

| Concern | Target | Validation |
|---------|--------|------------|
| Style fidelity | No cross-document stylesheet effects | Cross-library visual tests |
| Shell responsiveness | p75 LCP below 2.5 seconds on a defined device/network profile | Browser measurement |
| Interaction | p75 INP below 200 ms | Browser measurement under realistic selections |
| Preview resources | Mount only visible and nearby frames, with a bounded retained set | Memory and scrolling profiles |
| Delivery availability | 99.9% successful static retrieval as a starting SLO | Synthetic requests to actual assets |
| Release integrity | Every advertised preview exists and references available assets | Artifact validation before promotion |

No current benchmark establishes these targets. The shell must remain usable even
when a library preview is slow or unavailable; an arbitrary iframe count is not a
useful capacity guarantee without a device profile.

## Capacity Estimation

For planning, use approximately 50 comparison entries and 20 forms: 1,000 possible
previews. Mounting one iframe per combination gives 1,000 active documents even
though there are only about 50 independently built applications. These are different
resource counts.

If six visible documents each need an illustrative 150 KB of compressed JavaScript,
first-use library transfer is about 900 KB plus the shell, styles, and fonts. That
estimate is a budget exercise, not a measurement. Browser caching may reuse bytes
for multiple forms from one library, but each document still creates its own DOM
and application state. Lazy loading delays work; eviction is needed to bound memory
after a user scrolls through the whole catalog.

### Local development scale

The reviewed source exposes 46 entries, including the no-CSS baseline, and 20 forms:
920 selectable pairs across 47 app packages including the shell. Defaults select
three forms and three libraries, creating nine preview documents.

## High-Level Architecture

```
┌─────────────────┐    ┌────────────────────┐
│ Source + catalog│───▶│ Build and validation│
└─────────────────┘    └─────────┬──────────┘
                                 │ complete versioned release
                                 ▼
                       ┌────────────────────┐
                       │ Static origin + CDN│
                       └─────────┬──────────┘
                                 │ HTML, JS, CSS, fonts
                                 ▼
┌─────────────────────────────────────────────────┐
│ Browser                                         │
│ ┌─────────────────────────────────────────────┐ │
│ │ Shell: URL state, selection, preview manager │ │
│ └──────────────────┬──────────────────────────┘ │
│             ┌──────┴──────┐                     │
│             ▼             ▼                     │
│       ┌───────────┐ ┌───────────┐               │
│       │ Library A │ │ Library B │               │
│       │ document  │ │ document  │               │
│       └───────────┘ └───────────┘               │
└─────────────────────────────────────────────────┘
```

The origin serves static artifacts; there is no dynamic application server. CDN
cache misses still require an origin. Build concurrency and browser frame
concurrency are separate controls.

## Core Components / Request Flows

### Shell and preview manager

The shell owns selected form IDs, library IDs, theme, and grouping. It validates
incoming URLs against the catalog, chooses defaults, and derives preview descriptors.
Each descriptor has a stable identity based on its library and form.

The proposed preview manager reserves layout space, mounts visible or nearby frames,
and retains only a limited number of recently used documents. It must not evict the
focused frame. A card distinguishes pending, ready, and unavailable states, with a
standalone link and retry action when appropriate.

### Library application

A library app reads its initial form and theme from its URL, validates those values,
and renders the matching form under the library's own styling setup. Shared form
specifications describe fields and validation expectations; per-library components
retain their native composition. Metadata types alone do not prove equivalent
runtime validation across implementations.

### Configuration and theme flow

1. Parse and validate the comparison URL. Explicit URL fields override saved preferences.
2. Derive one preview descriptor for each selected form/library pair.
3. Load nearby previews with a form ID and initial theme in their URL.
4. After a child reports readiness, send the latest theme without navigating the frame.
5. Validate message origin, sending window, message type, and value on receipt.
6. Keep the shell URL current so a fresh load can reconstruct the comparison.

URL initialization and live messaging have complementary roles. Sending a theme
message while also changing the iframe `src` still navigates the document and does
not guarantee that typed form data survives.

## Database Schema

There is no server database. The relevant data is a static catalog plus browser
preferences. A relational schema would add no value to this workload.

| Entity | Fields | Ownership and validation |
|--------|--------|--------------------------|
| Library | Stable ID, display name, asset path, theme support | Build-time catalog; validate path exists |
| Form | Stable ID, label, expected field behavior | Form specification; tested against implementations |
| Comparison | Library IDs, form IDs, theme, grouping | Shell; validate before rendering |
| Preview status | Identity, readiness, last use | Runtime only; omit from shareable state |
| Release | Revision, available library artifacts | Proposed build manifest; validate before publish |

Empty, all-selected, and omitted URL values must have distinct meanings. Otherwise
local preferences can change the result of a shared link.

## API Design

The public interface consists of static GET requests and a small browser message
contract. These examples use the implementation's form-ID convention.

| Interface | Purpose |
|-----------|---------|
| `GET /20forms-20designs/?forms=user-login&libraries=mui,chakra&theme=dark` | Load a comparison |
| `GET /20forms-20designs/mui/index.html?form=user-login&theme=dark` | Load a standalone preview |
| `GET /20forms-20designs/mui/assets/<content-hash>.js` | Fetch a built asset; exact filename comes from HTML |
| Child readiness message | Proposed application-ready signal with preview identity |
| `SET_THEME` message | Set an absolute theme value on a loaded preview |

There are no login, payment, or submission API endpoints for the demonstration forms.

## Key Design Decisions

### Iframes for style fidelity

An iframe supplies a separate document and CSS cascade, allowing each library's
reset and style-injection behavior to operate as it normally would. CSS Modules
scope selected class names but do not rewrite every third-party global stylesheet.
Shadow DOM can work with adapted styles and correctly targeted overlays, but every
library would need compatibility work for inherited properties and document-level
assumptions.

React context is not inherently broken by a shadow root: it follows the React tree,
and portals preserve access to parent context. That distinction prevents blaming
React for a CSS integration problem. See the [React portal reference](https://react.dev/reference/react-dom/createPortal).

The cost of iframes is extra documents, application instances, focus boundaries,
and memory. Style isolation alone does not make same-origin code untrusted-safe.

### URLs for reproducibility, messages for live updates

A URL makes a preview independently reproducible. Live theme messages can preserve
its input state if the parent avoids changing its `src`. A URL-only approach is
simpler but reloads the document on theme changes; a message-only approach needs a
separate initialization and sharing mechanism. The combined design pays for a small
readiness protocol and validation at the boundary.

### Bounded build workers and complete releases

Independent builds avoid forcing every component library into one dependency and
styling environment. A worker pool limits simultaneous compiler processes. Choose
its size from measured memory, not a fixed “optimal” number. Parent-process garbage
collection cannot release memory still owned by active compiler children.

Build into a clean staging area, validate all advertised previews, and publish only
a complete artifact. Partial releases can be reasonable if their catalog explicitly
omits failed previews, but silently retaining broken entries undermines comparison.

## Consistency and Idempotency

The consistency problem is release and UI state, rather than database transactions.
A shell must reference previews and assets from a compatible release. Content hashes
avoid overwriting asset bytes under the same name, but do not prevent missing assets
when old files are deleted too early.

An absolute theme-setting message is naturally idempotent: applying “dark” twice
has the same result as applying it once. A toggle message is not. A child should
receive the latest state after readiness, including changes made while it loaded.

## Security / Auth

The application has no authentication. Demo form inputs should remain within the
preview; persisted comparison preferences should contain IDs and presentation
settings, not entered credentials or personal data.

For curated same-origin apps, the current sandbox is a compatibility setting, not
a hostile-code boundary. Combining scripts and same-origin access permits behavior
that defeats strong isolation. If arbitrary third-party code becomes a requirement,
use a separate origin and reconsider permissions. See the [iframe sandbox reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).

## Observability

Proposed measurements are shell responsiveness, mounted frame count, preview
readiness latency, failed preview loads, and build failures by library. An iframe
`load` event is insufficient evidence that the application rendered successfully.
Prefer a readiness message and a smoke check of the assembled release.

Monitor transfer size separately from document initialization and memory. A warm
HTTP cache can hide network cost while hundreds of React roots still consume CPU.
There is no verified RUM or centralized error pipeline in the reviewed shell.

## Failure Handling

| Failure | Proposed behavior |
|---------|-------------------|
| Unknown URL IDs | Explain invalid selection and offer known forms/libraries |
| One preview fails | Keep other comparisons usable; retry or open standalone |
| Storage unavailable | Use URL and in-memory defaults |
| Theme changes before readiness | Deliver latest absolute theme after readiness |
| Preview compiler fails | Fail release validation or explicitly remove it from release catalog |
| Broken deployment | Restore a previously validated complete artifact |

## Scalability Considerations

Browser memory is likely to become a constraint before static request throughput.
Control mounted frames first, then consider per-form code splitting and representative
performance budgets. Supporting more libraries also increases maintenance and visual
verification work; building more assets does not prove consistent form behavior.

For distribution, content-hashed assets can receive a long cache lifetime where the
hosting configuration supports it. HTML should revalidate or use a suitably short
freshness period. `no-cache` permits storage but requires validation before reuse;
it does not mean “never stored.” See [Cache-Control semantics](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control).

The exact CDN policy depends on the host. This repository does not configure custom
one-year headers for GitHub Pages, and hashing does not cause instantaneous global
cache invalidation. Retain referenced assets through a defined compatibility period.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Style boundary | Separate iframe documents | Adapt every library to Shadow DOM | Preserve native resets and overlays with less integration work |
| Configuration | URL initialization plus live theme messages | Reload on every change | Reproducible entry point with less input loss |
| Browser resources | Visible frames plus bounded retention | Keep every visited frame alive | Bound memory at the cost of some remounts |
| Build execution | Measured worker pool | Unbounded parallel builds | Avoid exhausting build-machine memory |
| Publishing | Complete validated artifact | Silent partial deployment | Keep catalog and available previews consistent |
| Data storage | Static catalog and local preferences | Application database | No server-owned user records in scope |

## Implementation Notes

### Source-verified behavior

| Area | Actual implementation | Source path in the reviewed upstream commit |
|------|-----------------------|---------------------------------------------|
| Catalog | 46 enabled entries, including no-CSS baseline; 20 form IDs | `apps/shell/src/config.ts` |
| State | Zustand with manual localStorage reads/writes; URL overrides saved fields | `apps/shell/src/store.ts` |
| URL updates | Immediate `replaceState`; no debounce or shell `popstate` listener | `apps/shell/src/App.tsx` |
| Rendering | Selected form/library Cartesian product, mounted eagerly | `apps/shell/src/components/PreviewSection.tsx` |
| Frames | Form-specific fixed heights; theme in `src` and `SET_THEME` messages | `apps/shell/src/components/PreviewCard.tsx` |
| Example preview | MUI eagerly imports 20 forms; reads URL and listens for theme messages | `apps/mui/src/App.jsx` |
| Demo submission | MUI login prevents submission and calls an alert | `apps/mui/src/forms/UserLoginForm.jsx` |
| Build | Shell first, then up to 14 workers; 46 existing consolidated preview apps | `scripts/build-all.mjs` |
| Assembly | Clean aggregate output, copy existing app builds, warn about missing builds | `scripts/copy-builds-to-dist.mjs` |
| Deployment | Main/manual workflow, Node 22 and Bun, Pages artifact upload/deploy | `.github/workflows/deploy.yml` |
| Tests | Chromium in deployment; tests run against shell Vite server | `apps/shell/playwright.config.ts`, `apps/shell/tests/shell.spec.ts` |
| Local serving | Assembled static preview, project base path, port fallback | `scripts/serve-preview.mjs` |

The build allowlist also names `heroui` and `gluestack`, but filters against existing
app directories; those apps are absent in this snapshot. The older shared-package
catalog differs from the shell catalog, so the shell imports are the source of truth
for user-visible entries.

### Simplifications and gaps

- No Intersection Observer loading, frame eviction, or retained iframe cache exists
  in the shell. Deselecting removes previews; changing grouping can remount them.
- Theme messages use wildcard targets. The reviewed MUI receiver does not validate
  origin or sender. Updating the URL as well as messaging can reset input state.
- Partial selections are encoded in URLs, while empty and all-selected lists are
  omitted. Missing theme/grouping fields can also fall back to saved preferences;
  exact sharing semantics are therefore incomplete.
- Unknown form IDs in the reviewed MUI entry point have no fallback component.
- The build script does not implement per-app timeouts, retries, forced GC, or a
  minimum-success deployment threshold. A failed preview build is reported, but
  does not by itself make the orchestrator exit unsuccessfully.
- Assembly reads existing per-app output directories, so a failed local rebuild
  can leave stale preview assets available for copying.
- Shell browser tests assert controls and frame elements; they do not validate all
  preview documents in the assembled artifact. CI report retention is 30 days;
  there is no configured 14-day rollback-artifact policy in the workflow.

### Omitted production features

The reviewed source does not provide the proposed release manifest, complete-artifact
validation gate, incremental build cache, runtime readiness protocol, performance
budget gate, RUM collector, or centralized preview error forwarding. It also has no
server-side accounts, database, or form-processing service. These are explicit scope
boundaries, not missing microservices that must be added to a static showcase.

Setup commands are in [README.md](./README.md). This review inspected source and
configuration; it did not execute the upstream build, deploy, or browser suite.
