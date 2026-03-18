# 20 Forms, 40 Designs - Architecture Design

## System Overview

A form library comparison platform that renders identical forms across 41 React design systems with complete CSS isolation, enabling side-by-side visual comparison of component libraries. The platform is deployed as a static site, requiring no backend server.

**Learning goals:** CSS isolation strategies, monorepo build orchestration, iframe-based micro-frontend architecture, static site deployment at scale.

## Requirements

### Functional Requirements

- Display 20 common form types across 41 design system libraries
- Side-by-side comparison of any library combination
- Theme switching (light/dark) for supported libraries
- Grouping by form or by library
- Deep linking to specific form/library combinations

### Non-Functional Requirements

- **CSS Isolation:** Zero style bleed between design systems -- each library must render identically to its standalone behavior
- **Performance:** Shell FCP < 1.5s, individual iframe load < 500ms, LCP < 2.5s
- **Build Time:** Full 42-app build completes in < 5 minutes with retry resilience
- **Static Deployment:** Entire platform served from CDN with zero server-side compute
- **Bundle Budgets:** Shell JS < 50 KB gzipped, per-library JS < 150 KB gzipped, total dist < 25 MB

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CDN (Fastly / Cloudflare)                       │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Edge Cache: HTML (no-cache) │ Assets *-[hash].js/css (immutable, 1y) │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │ HTTPS
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Static Origin (GitHub Pages)                        │
│                                                                              │
│  dist/                                                                       │
│  ├── index.html              ─── Shell Application                           │
│  ├── assets/shell-[hash].js                                                  │
│  ├── mui/index.html          ─── MUI Library App                             │
│  ├── mui/assets/mui-[hash].js                                                │
│  ├── chakra/index.html       ─── Chakra Library App                          │
│  ├── antd/index.html         ─── Ant Design Library App                      │
│  └── ... (41 library apps total)                                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Shell + Iframe Architecture

The shell application orchestrates 41 independent library applications via iframes. Each iframe is a separate browsing context with its own CSS cascade, ensuring complete style isolation.

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Shell Application (Host)                          │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                       Control Panel                            │  │
│  │  [Form: Login ▼]  [Libraries: MUI, Chakra ...]  [Theme: ☀/🌙] │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                       Preview Grid                             │  │
│  │                                                                │  │
│  │  ┌─────────────────────┐    ┌─────────────────────┐           │  │
│  │  │     <iframe>        │    │     <iframe>        │           │  │
│  │  │  src="/mui/?form=   │    │  src="/chakra/?form=│           │  │
│  │  │    login&theme=dark" │    │    login&theme=dark" │           │  │
│  │  │                     │    │                     │           │  │
│  │  │  ┌───────────────┐  │    │  ┌───────────────┐  │           │  │
│  │  │  │  MUI Login    │  │    │  │ Chakra Login  │  │           │  │
│  │  │  │  Form         │  │    │  │ Form          │  │           │  │
│  │  │  └───────────────┘  │    │  └───────────────┘  │           │  │
│  │  └─────────────────────┘    └─────────────────────┘           │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### Communication Flow

```
Shell App                           Library App (iframe)
    │                                     │
    │  1. Render <iframe src="...">       │
    │────────────────────────────────────▶│
    │                                     │
    │  2. iframe loads standalone app     │
    │                                     │
    │  3. URL params determine content    │
    │     ?form=login&theme=dark          │
    │                                     │
    │  4. Library app renders form        │
    │     with its own isolated CSS       │
    │                                     │
```

No postMessage coordination is needed. The shell communicates with library apps entirely through URL query parameters, which enables deep linking and browser history support for free.

## Core Components

### 1. Shell Application

The host application that provides the control panel (form selector, library selector, theme toggle) and renders a responsive grid of iframes. Each iframe's `src` encodes the selected form and theme as query parameters.

**Responsibilities:**
- Render library/form selection UI
- Manage URL state for deep linking
- Lazy-load iframes via Intersection Observer (only load when scrolled into view)
- Cache iframe DOM elements to avoid re-fetching on form/library changes

### 2. Library Applications (41 total)

Each library app is a standalone React + Vite application that reads `?form=<id>&theme=<light|dark>` from the URL and renders the corresponding form using its native design system components. Each app includes its own React instance, CSS reset, and theme provider.

**Form standardization:** All 20 forms share identical field labels, validation rules, and placeholder text across libraries. A TypeScript interface defines the contract:

- Same fields, same labels, same validation
- Different styling, components, and UX patterns
- Each library uses its native form components (TextField, Input, FormControl, etc.)

### 3. Build Orchestration

A parallel build script compiles all 42 applications (1 shell + 41 libraries) in batches of 4 concurrent builds to prevent memory exhaustion. Each build has a 2-minute timeout and up to 2 retries with exponential backoff.

**Build pipeline:**
1. Install dependencies (hoisted via Bun workspaces)
2. Build in batches of 4 (with retry logic and GC between batches)
3. Copy all `dist/` outputs to a unified deployment folder
4. Validate bundle size budgets

## Key Design Decisions

### 1. Iframe-Based Isolation vs Alternatives

**Decision:** Use iframes for complete CSS isolation.

| Approach | Pros | Cons |
|----------|------|------|
| **Iframe** (chosen) | Complete isolation, true rendering fidelity, separate React trees | Larger total bundle, more network requests |
| Shadow DOM | Lighter weight | CSS custom properties leak through, React context does not cross shadow boundary |
| CSS Modules | Simple setup | Only scopes class names, not resets or CSS variables |
| CSS-in-JS isolation | Programmatic scoping | Complex across heterogeneous libraries, no global reset isolation |

Design systems rely on global CSS resets (CssBaseline, preflight), CSS custom properties, and React context providers. Only iframes provide true browsing context isolation where none of these mechanisms can leak between libraries. The overhead of duplicated React bundles (~40 KB gzipped x 41) is acceptable because the alternative -- style corruption between libraries -- defeats the entire purpose of the platform.

### 2. Monorepo with Separate Builds

**Decision:** Each library is a separate Vite application within a Bun workspaces monorepo.

This means each library can pin its own dependency versions (some require React 18, others work with 19), has independent build caching, and produces a standalone bundle. The trade-off is duplicated React bundles and longer total build time (~3 minutes vs. seconds for a single app), but this is offset by the clean dependency isolation and parallel build capability.

### 3. URL-Based Configuration over postMessage

**Decision:** Pass form and theme via URL query parameters rather than postMessage.

URL parameters provide deep linking for free -- a user can bookmark or share `/20forms-20designs/?form=login&libraries=mui,chakra&theme=dark` and see exactly the same comparison. There is no message coordination complexity, and browser caching works naturally because each iframe URL is a stable, cacheable resource. The trade-off is that configuration changes require an iframe `src` update (triggering a reload), but with iframe DOM caching this cost is minimal.

### 4. Static Deployment on GitHub Pages

**Decision:** Deploy as static files to GitHub Pages with Fastly CDN.

No server costs, automatic HTTPS, global CDN distribution, and deployment via `git push` to the `gh-pages` branch. The entire platform runs at $0/month. The trade-off is no server-side logic (no analytics endpoint, no A/B testing), but for a comparison showcase this is not needed.

## CSS Isolation Deep Dive

The core technical challenge: rendering 41 design systems without style conflicts.

**Why coexistence fails:** When MUI's `CssBaseline` and Tailwind's `preflight` run in the same document, they fight over `box-sizing`, `margin`, and `font-family` defaults. CSS custom properties like `--primary-color` collide across libraries. React context providers (ThemeProvider, ChakraProvider) cannot nest cleanly when they assume global scope.

**Why iframes work:** Each iframe creates a separate browsing context with its own `<head>`, stylesheet cascade, and JavaScript global scope. MUI's resets cannot reach Chakra's iframe, and vice versa. This is the only browser-native mechanism that provides complete CSS isolation without polyfills or build-time transformations.

**Cost of isolation:** Each iframe loads its own React bundle (~40 KB gzipped), its library's CSS (10-200 KB), and its form components. With 41 iframes visible, this could mean 41 parallel network requests. Mitigations include lazy loading (Intersection Observer), iframe DOM caching, and aggressive CDN caching with content-hash fingerprinting.

## Caching and CDN Strategy

### Asset Fingerprinting

Vite produces content-hashed filenames for all JS and CSS assets (`shell-a1b2c3d4.js`). HTML files are served with `no-cache, must-revalidate` to ensure users always get the latest shell. Hashed assets are served with `immutable, max-age=31536000` (1 year) since any content change produces a new hash.

### Cache Headers

| Asset Type | Cache-Control | TTL | Reasoning |
|------------|---------------|-----|-----------|
| `*.html` | `no-cache, must-revalidate` | 0 | Always fetch latest version |
| `*-[hash].js` | `public, max-age=31536000, immutable` | 1 year | Hash changes on content change |
| `*-[hash].css` | `public, max-age=31536000, immutable` | 1 year | Hash changes on content change |
| Images/fonts | `public, max-age=604800` | 1 week | Rarely change |

### CDN Behavior

GitHub Pages uses Fastly CDN with automatic edge caching. Assets are served from the nearest edge location. Pushing to the `gh-pages` branch triggers global cache invalidation.

## Performance Considerations

### Bundle Budgets

| Metric | Budget | Warning | Typical |
|--------|--------|---------|---------|
| Shell app JS (gzipped) | < 50 KB | > 40 KB | ~35 KB |
| Shell app CSS (gzipped) | < 10 KB | > 8 KB | ~5 KB |
| Library app JS (gzipped) | < 150 KB | > 120 KB | 50-140 KB |
| Library app CSS (gzipped) | < 50 KB | > 40 KB | 10-45 KB |
| Total dist size | < 25 MB | > 20 MB | ~18 MB |

Bundle sizes are enforced in CI -- builds exceeding budgets fail the pipeline.

### Load Time Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Shell FCP | < 1.5s | Lighthouse |
| Shell LCP | < 2.5s | Lighthouse |
| Iframe load (per library) | < 500ms | Performance API |
| Time to Interactive | < 3.0s | Lighthouse |
| Total Blocking Time | < 200ms | Lighthouse |

### Runtime Optimizations

1. **Lazy iframe loading:** Iframes are only loaded when they scroll into the viewport (Intersection Observer). This prevents 41 simultaneous network requests on initial page load.
2. **Iframe DOM caching:** Once an iframe is loaded, its DOM element is preserved in memory. Switching between forms updates the `src` attribute rather than destroying and recreating the iframe.
3. **CSS Grid layout:** The preview grid uses CSS Grid for responsive layout, avoiding JavaScript-based layout calculations.

## Build Pipeline Resilience

### Parallel Build with Retry

The build script processes 42 applications in batches of 4 concurrent builds. Each build has a 2-minute timeout and up to 2 retries with 2-second delays. Garbage collection is forced between batches to prevent OOM on CI runners.

### Failure Handling

| Failure Type | Detection | Recovery |
|-------------|-----------|----------|
| Single app timeout | 2-minute `execAsync` timeout | Retry up to 2x |
| OOM during batch | Process exit code | Reduce concurrency to 2 |
| Dependency install fail | bun install exit code | Retry with cache clear |
| Majority failure | < 35 successful builds | Block deployment |

**Graceful degradation:** If some library apps fail but the shell and at least 35 of 42 apps succeed, the pipeline can proceed with a warning. A notice is generated listing the broken libraries.

### Rollback Strategy

**Primary (git-based):** The `gh-pages` branch maintains deployment history. Roll back by resetting to a previous commit and force-pushing.

**Granular (per-app):** If only one library app is broken, rebuild just that app, copy its output to the `dist/` folder, and redeploy.

**Artifact preservation:** CI uploads `dist/` as a GitHub Actions artifact with 14-day retention, enabling rollback to any recent build without rebuilding.

## Observability

### Real User Monitoring (RUM)

The shell application uses the `web-vitals` library to capture Core Web Vitals (CLS, FCP, LCP, TTFB) from real user sessions. In development, metrics are logged to the console. In production, they can be beaconed to a lightweight analytics service.

### Iframe Load Tracking

Each iframe card tracks its load time using the Performance API. Iframes exceeding the 500ms budget are flagged with a console warning. This helps identify which library apps are the heaviest and may need optimization.

### Error Tracking

The shell listens for `error` and `unhandledrejection` events. Library apps forward their errors to the shell via `postMessage`, enabling centralized error visibility. In production, errors can be sampled (10%) and sent to Sentry's free tier.

## Scalability Considerations

### Adding New Libraries

Adding a new design system requires creating a new Vite app under `apps/`, implementing the 20 forms using the library's native components, and adding metadata to the shell's library registry. The build script auto-discovers apps in the `apps/` directory.

### Build Time Scaling

With 42 apps and 4-way parallelism, full builds take ~3 minutes. If the library count grows significantly:
- Increase CI runner memory and parallelism
- Implement incremental builds (only rebuild changed apps based on git diff)
- Use build artifact caching to skip unchanged apps entirely

### Traffic Scaling

As a static site behind a CDN, the platform scales horizontally with no server changes. If traffic exceeds GitHub Pages' bandwidth limits (~100 GB/month), migrate to Cloudflare Pages (unlimited bandwidth, free tier) with the same deployment model.

## Hosting Cost Analysis

| Platform | Free Tier | Best For |
|----------|-----------|----------|
| **GitHub Pages** (chosen) | Unlimited for public repos | This project -- zero cost, simple deployment |
| Cloudflare Pages | Unlimited bandwidth | High traffic migration path |
| Netlify | 100 GB/month | Custom headers, form handling |
| Vercel | 100 GB/month | Edge functions (not needed) |

**Current monthly cost: $0.** GitHub Actions provides 2,000 free build minutes/month, sufficient for ~660 builds at 3 minutes each.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| CSS isolation | Iframes | Shadow DOM | Only iframes provide complete browsing context isolation for CSS resets, custom properties, and context providers |
| App structure | Separate Vite apps | Single SPA | Clean dependency isolation per library, independent versioning |
| Communication | URL query params | postMessage | Deep linking, bookmarkability, no coordination complexity |
| Hosting | GitHub Pages | Netlify/Vercel | Free, sufficient for static showcase, CDN included |
| Package manager | Bun workspaces | npm/pnpm workspaces | Faster installs, native workspace support |
| Build strategy | Batched parallel (4) | Fully parallel | Memory-bounded; 42 concurrent Vite builds exhaust RAM |

## Implementation Notes

This project is a **design-only entry** in this repository. The implementation lives in an external repository:

**External Repository:** [github.com/evgenyvinnik/20forms-20designs](https://github.com/evgenyvinnik/20forms-20designs)

### What the External Implementation Covers

Based on the architecture document and the project's CLAUDE.md, the external repository implements:

- **Shell application** with form selector, library selector, theme toggle, and responsive iframe grid
- **41 library apps** as separate Vite applications in a Bun workspaces monorepo, each rendering 20 forms with native design system components
- **Iframe-based CSS isolation** for zero style bleed between libraries
- **URL-based configuration** with deep linking via query parameters (`?form=login&theme=dark`)
- **Parallel build script** (`scripts/build-all.mjs`) with batched 4-way concurrency, retry logic, and GC between batches
- **Static deployment** to GitHub Pages via GitHub Actions CI/CD pipeline
- **Playwright E2E tests** for shell functionality and visual regression

### What Is Simplified or Substituted

- **No RUM in production:** Web Vitals metrics are logged to console only; no analytics backend
- **No Sentry integration:** Error tracking is console-based
- **No incremental builds:** Full rebuild on every deployment (sufficient at 42 apps / ~3 minutes)
- **No custom CDN headers:** Relies on GitHub Pages' default caching via Fastly; Netlify `_headers` configuration is documented but not deployed

### What Is Omitted

- Server-side logic (the platform is entirely static)
- A/B testing or feature flags
- User authentication or personalization
- Performance budgets enforced in CI (documented but may not be implemented)
- Iframe error forwarding via postMessage (described in architecture, may not be fully wired)
