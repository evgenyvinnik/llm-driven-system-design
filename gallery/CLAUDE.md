# Gallery (Image Gallery Layouts) — Development with Claude

## Project Context

A **frontend-only** image gallery that demonstrates three layout paradigms side by side — Slideshow (carousel), Masonry (Pinterest-style variable heights), and Tiles (uniform grid) — with a shared full-screen Lightbox. The interesting problem isn't storage or scale; it's *rendering strategy*: getting three genuinely different visual layouts to share one image set, one lightbox, and one keyboard model without a heavyweight layout library. Placeholder images come from `picsum.photos`; there is no backend.

**Learning goals:** CSS-native layout (multi-column masonry, CSS Grid tiles, flex carousel), native browser lazy loading, full keyboard accessibility, and minimal global UI state with Zustand.

## Architecture at a Glance (what actually runs)

There is **no backend, database, Docker, or API server** in this project — it is a single Vite SPA. Documenting the absence honestly because most sibling projects have a backend and it would be easy to assume one here.

| Layer | Technology | Role |
|-------|-----------|------|
| UI | React 19 + TypeScript | Components for the three views + lightbox + tabs |
| Routing | TanStack Router (file-based) | One route (`/`); views switch via in-page tab state, not navigation |
| State | Zustand (`galleryStore.ts`) | Active tab, lightbox target, slideshow index, `totalImages` |
| Styling | Tailwind CSS | Layout primitives (`columns-*`, grid, flex) live in class names |
| Images | `picsum.photos` (external) | URLs built in `utils/picsum.ts`; no upload/processing/storage |

`architecture.md` additionally sketches a *production-ideal* backend (S3 + CDN, responsive `srcset`, an image-processing pipeline) — that is the aspirational layer of the dual-layer doc, explicitly marked as not built. It is not describing code that exists here.

## Key Design Decisions

### 1. CSS `columns` for masonry, not a JS masonry library
`MasonryGrid` uses Tailwind `columns-2 md:columns-3 lg:columns-4` — the browser flows items into balanced columns natively, with zero layout math and no `react-masonry-css`/Packery dependency. Trade-off given up: CSS columns order items *column-first* (top-to-bottom then next column), not row-first reading order, and item heights aren't measured, so precise gap balancing across columns isn't possible. Acceptable for a visual gallery; wrong for ordered content.

### 2. Single page, tab-switched views sharing one lightbox
All three views live on the `/` route and switch on `activeTab` in the Zustand store rather than on separate routes. This makes view switching instant (no route load, no image refetch) and lets the Lightbox be one component driven by a single `lightboxImage` id across all views. Trade-off: the current view isn't reflected in the URL, so it isn't deep-linkable or back-button navigable.

### 3. Deterministic image set (IDs 10–59) with derived aspect ratios
`utils/picsum.ts` hardcodes 50 IDs (`Array.from({length:50}, (_,i)=>i+10)`) because some picsum IDs are missing/broken, and derives masonry heights deterministically from `id % ratios` (`getAspectRatio`). Deterministic ratios give stable, varied masonry heights every session without an API round-trip for real dimensions. Trade-off: heights are synthetic, not the images' true aspect ratios — a real gallery would read dimensions from the image service (`/id/{id}/info`).

### 4. Native `loading="lazy"`, no IntersectionObserver
Tiles and Masonry `<img>` tags use the native `loading="lazy"` attribute so off-screen images defer until near the viewport, with no scroll observer or virtualization code. Trade-off: no infinite scroll or windowing — fine for a fixed 50-image set, but a large feed would need an IntersectionObserver-driven pager or `@tanstack/react-virtual`.

## Current State

**Implemented and working:** all three views (Slideshow with arrow nav + thumbnail strip + 3s autoplay via `setInterval`, Masonry via CSS columns, Tiles uniform grid); shared Lightbox with keyboard navigation (arrows to move, Escape to close); tab navigation; Zustand store; native lazy loading; icon components. Default landing view is **Tiles** (`activeTab: 'Tiles'`).

**Intentionally omitted:** any backend, database, or auth; image upload/storage/processing; responsive `srcset`/`<picture>` negotiation (fixed-size picsum URLs are used instead); infinite scroll / virtualization; URL-reflected view state; mobile swipe/pinch gestures.

## Iteration & Repair Log

- **Scaffolding → three views.** Project began as gallery + google-calendar scaffolding (`a4362089`); the gallery grew into the three-layout demo with a shared store and lightbox.
- **Routing/imports fix (`1639aacc`).** Routes, imports, and Vite config were corrected across the frontend-only projects in a batch pass; `routeTree.gen.ts` is the generated TanStack Router tree.
- **architecture.md dual-layer pass (`32b5c40d`).** The architecture doc gained the production-ideal S3+CDN backend as an explicit *aspirational* layer, with an Implementation Notes section stating plainly that the running project is frontend-only. This CLAUDE.md is aligned to that: the only thing that runs is the SPA + picsum.
- No backend repair classes (migrate.ts, ESM/connect-redis fixes, DB connection fallbacks, seed password hashes) apply here — there is no backend, database, or seed data.

## Open Questions

1. Should view state move into the URL (e.g. `/masonry`, `/tiles`) so views are deep-linkable and back-button-navigable, or does in-page tab state better match the "one gallery, three lenses" mental model?
2. For a real (non-placeholder) image set, where should true aspect ratios come from — the image service's info endpoint, an intrinsic-size probe, or a build-time manifest — to avoid layout shift while keeping masonry balanced?
3. At what image count does native `loading="lazy"` stop being enough and windowing (`@tanstack/react-virtual`) become necessary, given masonry's variable heights make row estimation harder?

## Resources

- [picsum.photos](https://picsum.photos) — the placeholder image service
- [MDN: CSS multi-column layout](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_multicol_layout) — the masonry technique
- [MDN: lazy loading](https://developer.mozilla.org/en-US/docs/Web/Performance/Lazy_loading) — native `loading="lazy"`
