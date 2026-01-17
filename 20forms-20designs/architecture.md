# 20 Forms, 40 Designs - Architecture Design

## System Overview

A form library comparison platform that renders identical forms across 41 React design systems with complete CSS isolation, enabling side-by-side visual comparison of component libraries.

## Requirements

### Functional Requirements

- Display 20 common form types across 41 design system libraries
- Side-by-side comparison of any library combination
- Theme switching (light/dark) for supported libraries
- Grouping by form or by library
- Deep linking to specific form/library combinations

### Non-Functional Requirements

- **CSS Isolation:** Zero style bleed between design systems
- **Performance:** Fast navigation between comparisons
- **Build Time:** Reasonable build time for 42 apps (~2-3 min)
- **Static Deployment:** No server required

## High-Level Architecture

### Monorepo Structure

```
20forms-20designs/
├── apps/
│   ├── shell/                    # Main comparison UI
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── components/
│   │   │   │   ├── FormSelector.tsx
│   │   │   │   ├── LibrarySelector.tsx
│   │   │   │   ├── ThemeToggle.tsx
│   │   │   │   └── PreviewGrid.tsx
│   │   │   └── data/
│   │   │       ├── forms.ts      # Form definitions
│   │   │       └── libraries.ts  # Library metadata
│   │   └── vite.config.ts
│   │
│   ├── mui/                      # MUI implementation
│   │   ├── src/
│   │   │   ├── App.tsx           # Form router
│   │   │   └── forms/            # 20 form components
│   │   │       ├── UserLogin.tsx
│   │   │       ├── SignUp.tsx
│   │   │       └── ...
│   │   └── vite.config.ts
│   │
│   ├── chakra/                   # Chakra UI implementation
│   ├── antd/                     # Ant Design implementation
│   └── ... (41 library apps total)
│
├── scripts/
│   ├── build-all.mjs             # Parallel build orchestration
│   └── copy-builds-to-dist.mjs   # Deployment bundler
│
├── tests/
│   └── shell.spec.ts             # Playwright E2E tests
│
└── package.json                  # Workspace root
```

### Iframe Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Shell Application (Host)                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      Control Panel                          │ │
│  │  [Form: Login ▼]  [Libraries: ✓MUI ✓Chakra ...]  [🌙/☀️]   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      Preview Grid                            ││
│  │                                                              ││
│  │  ┌──────────────────────┐  ┌──────────────────────┐         ││
│  │  │      <iframe>        │  │      <iframe>        │         ││
│  │  │  src="/mui/?form=    │  │  src="/chakra/?form= │         ││
│  │  │       login&theme=   │  │       login&theme=   │         ││
│  │  │       dark"          │  │       dark"          │         ││
│  │  │                      │  │                      │         ││
│  │  │  ┌────────────────┐  │  │  ┌────────────────┐  │         ││
│  │  │  │   MUI Login    │  │  │  │  Chakra Login  │  │         ││
│  │  │  │   Form         │  │  │  │  Form          │  │         ││
│  │  │  └────────────────┘  │  │  └────────────────┘  │         ││
│  │  │                      │  │                      │         ││
│  │  └──────────────────────┘  └──────────────────────┘         ││
│  │                                                              ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Communication Flow

```
Shell App                          Library App (iframe)
    │                                    │
    │  1. Render <iframe src="...">      │
    │─────────────────────────────────▶│
    │                                    │
    │  2. iframe loads library app       │
    │                                    │
    │  3. URL params determine content   │
    │     ?form=login&theme=dark         │
    │                                    │
    │  4. Library app renders form       │
    │     with its own isolated CSS      │
    │                                    │
```

## Core Components

### 1. Shell Application

The main host application that orchestrates the comparison:

```typescript
// PreviewGrid.tsx
function PreviewGrid({ selectedForms, selectedLibraries, theme }) {
  return (
    <div className="grid">
      {selectedLibraries.map(lib => (
        selectedForms.map(form => (
          <IframeCard
            key={`${lib.id}-${form.id}`}
            src={`/${lib.id}/?form=${form.id}&theme=${theme}`}
            title={`${lib.name} - ${form.name}`}
          />
        ))
      ))}
    </div>
  );
}
```

### 2. Library Applications

Each library app is a standalone React application:

```typescript
// apps/mui/src/App.tsx
function App() {
  const params = new URLSearchParams(window.location.search);
  const formId = params.get('form') || 'login';
  const theme = params.get('theme') || 'light';

  return (
    <ThemeProvider theme={theme === 'dark' ? darkTheme : lightTheme}>
      <CssBaseline />
      <FormRouter formId={formId} />
    </ThemeProvider>
  );
}
```

### 3. Build Orchestration

Parallel build script for all 42 applications:

```javascript
// scripts/build-all.mjs
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const libraries = ['shell', 'mui', 'chakra', 'antd', /* ... 38 more */];

// Build in parallel batches of 4
const CONCURRENCY = 4;
for (let i = 0; i < libraries.length; i += CONCURRENCY) {
  const batch = libraries.slice(i, i + CONCURRENCY);
  await Promise.all(batch.map(lib => 
    execAsync(`cd apps/${lib} && npm run build`)
  ));
}
```

## Key Design Decisions

### 1. Iframe-Based Isolation vs Alternatives

**Decision:** Use iframes for complete CSS isolation.

**Alternatives Considered:**

| Approach | Pros | Cons |
|----------|------|------|
| **Iframe** | Complete isolation, true fidelity | Larger bundle, more network requests |
| **Shadow DOM** | Lighter weight | CSS custom properties leak, context issues |
| **CSS Modules** | Simple | Only scopes classes, not resets/variables |
| **CSS-in-JS isolation** | Programmatic | Complex across different libraries |

**Rationale:**
- Design systems rely on global resets (CssBaseline, preflight)
- CSS custom properties need isolation
- Context providers need separate React trees
- Only iframes provide true isolation

### 2. Monorepo with Separate Builds

**Decision:** Each library is a separate Vite application.

**Rationale:**
- Different libraries have different peer dependencies
- Allows independent versioning
- Cleaner dependency trees
- Parallel builds possible

**Trade-offs:**
- Duplicated React bundles (~40KB × 41)
- More complex CI/CD
- Longer total build time

### 3. Static Deployment

**Decision:** Deploy as static files to GitHub Pages.

**Rationale:**
- No server costs
- Simple deployment (git push)
- CDN-backed performance
- No runtime dependencies

**Implementation:**
```yaml
# GitHub Actions deployment
- name: Build all apps
  run: bun run build

- name: Deploy to GitHub Pages
  uses: peaceiris/actions-gh-pages@v3
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    publish_dir: ./dist
```

### 4. URL-Based Configuration

**Decision:** Pass form and theme via URL query parameters.

**Rationale:**
- Deep linking to specific comparisons
- No postMessage complexity
- Works with browser history
- Bookmarkable states

**URL Pattern:**
```
Shell: /20forms-20designs/
Library: /20forms-20designs/mui/?form=login&theme=dark
```

## CSS Isolation Deep Dive

### The Problem

When design systems coexist in one app:

```html
<!-- Breaks! -->
<div>
  <MUIButton>Save</MUIButton>
  <ChakraButton>Cancel</ChakraButton>
</div>
```

Issues:
1. MUI's `CssBaseline` resets Chakra's defaults
2. Tailwind's `preflight` overrides Blueprint's styles
3. CSS custom properties conflict (`--primary-color`)

### The Solution

```html
<!-- Works! -->
<iframe src="/mui/?form=login">
  <!-- Completely isolated browsing context -->
  <!-- Own <head>, stylesheets, CSS cascade -->
</iframe>

<iframe src="/chakra/?form=login">
  <!-- Completely isolated browsing context -->
  <!-- Cannot affect or be affected by MUI -->
</iframe>
```

## Form Standardization

All 20 forms have identical structure across libraries:

```typescript
interface FormProps {
  onSubmit: (data: FormData) => void;
}

// Each library implements the same form:
// - Same field labels
// - Same validation rules
// - Same placeholder text
// - Different styling and components

// Reference implementation (React with no CSS)
function LoginForm({ onSubmit }: FormProps) {
  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" required />
      
      <label htmlFor="password">Password</label>
      <input id="password" type="password" required />
      
      <button type="submit">Sign In</button>
    </form>
  );
}
```

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Monorepo | Bun workspaces | Package management |
| Framework | React 18 | UI components |
| Build | Vite | Fast builds per app |
| Styling | Per-library | Native library styling |
| Testing | Playwright | E2E testing |
| Deployment | GitHub Pages | Static hosting |
| CI/CD | GitHub Actions | Automated builds |

## Performance Considerations

### Build Optimization

1. **Parallel Builds:** 4 concurrent builds
2. **Shared Dependencies:** Hoisted to root
3. **Incremental Builds:** Only rebuild changed apps

### Runtime Optimization

1. **Lazy Iframe Loading:** Load on scroll into view
2. **Iframe Reuse:** Cache DOM elements
3. **Efficient Grid:** CSS Grid for responsive layout

### Bundle Analysis

| Concern | Size Impact | Mitigation |
|---------|-------------|------------|
| React per app | ~40KB gzipped | Acceptable for isolation |
| Library CSS | 10-200KB | Native, no reduction |
| Shared utilities | ~5KB | Extracted to shared |

## Testing Strategy

### E2E Tests (Playwright)

```typescript
test('form selector filters preview grid', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-testid="form-login"]');
  
  const cards = await page.locator('.preview-card').count();
  expect(cards).toBeGreaterThan(0);
  
  // Each card should show login form
  const iframeSrc = await page.locator('iframe').first().getAttribute('src');
  expect(iframeSrc).toContain('form=login');
});
```

### Visual Regression

- Screenshot comparison per library
- Theme variant coverage
- Responsive breakpoint testing

## Hosting and CDN Strategy

### Static Asset Configuration

Since GitHub Pages serves all files, we configure caching via build-time asset fingerprinting:

```
dist/
├── index.html                    # No-cache (always fresh)
├── assets/
│   ├── shell-a1b2c3d4.js        # Immutable (hash in filename)
│   ├── shell-e5f6g7h8.css       # Immutable (hash in filename)
│   └── ...
├── mui/
│   ├── index.html               # No-cache
│   └── assets/
│       ├── mui-i9j0k1l2.js      # Immutable
│       └── mui-m3n4o5p6.css     # Immutable
└── ... (40 more library apps)
```

**Vite Asset Fingerprinting:**
```typescript
// vite.config.ts (applied to all apps)
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Content hash in filenames for cache busting
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
```

### Cache Headers Strategy

GitHub Pages sets default caching. For explicit control (Netlify/Vercel alternative):

| Asset Type | Cache-Control Header | TTL | Reasoning |
|------------|---------------------|-----|-----------|
| `*.html` | `no-cache, must-revalidate` | 0 | Always fetch latest version |
| `*-[hash].js` | `public, max-age=31536000, immutable` | 1 year | Hash changes on content change |
| `*-[hash].css` | `public, max-age=31536000, immutable` | 1 year | Hash changes on content change |
| Images/fonts | `public, max-age=604800` | 1 week | Rarely change |

**Netlify `_headers` file (if migrating from GitHub Pages):**
```
# dist/_headers
/*.html
  Cache-Control: no-cache, must-revalidate

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/*/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

### Edge CDN Behavior

GitHub Pages uses Fastly CDN with automatic edge caching:

- **Global POPs:** Assets served from nearest edge location
- **Origin Shield:** Reduces origin hits
- **Purge on Deploy:** `gh-pages` push triggers global cache invalidation

For local development/testing without CDN:
```bash
# Serve dist folder with no-cache headers
npx serve dist -s --no-clipboard -l 4000
```

### Rollback Strategy for 42 App Builds

**Git-Based Rollback (Primary):**
```bash
# List recent deployments
git log --oneline gh-pages -10

# Rollback to previous deployment
git checkout gh-pages
git reset --hard HEAD~1
git push origin gh-pages --force

# Or rollback to specific commit
git reset --hard abc123
git push origin gh-pages --force
```

**Artifact Preservation (CI/CD):**
```yaml
# .github/workflows/deploy.yml
- name: Upload build artifacts
  uses: actions/upload-artifact@v4
  with:
    name: dist-${{ github.sha }}
    path: dist/
    retention-days: 30

# Download previous artifact for rollback
- name: Download previous build
  uses: actions/download-artifact@v4
  with:
    name: dist-<previous-sha>
```

**Per-App Rollback (Granular):**

If only one library app is broken, rebuild just that app:
```bash
# Rebuild single broken app
cd apps/problematic-lib
bun run build

# Copy to dist and redeploy
cp -r dist/* ../../dist/problematic-lib/
cd ../..
git add dist/problematic-lib
git commit -m "fix: rollback problematic-lib to working state"
git push origin gh-pages
```

**Rollback Validation Checklist:**
- [ ] Shell app loads without JS errors
- [ ] At least 3 random library iframes render correctly
- [ ] Theme toggle works
- [ ] Form selector updates iframe URLs

---

## Performance Budgets

### Bundle Size Limits

| Metric | Budget | Warning | Measured (typical) |
|--------|--------|---------|-------------------|
| Shell app JS (gzipped) | < 50 KB | > 40 KB | ~35 KB |
| Shell app CSS (gzipped) | < 10 KB | > 8 KB | ~5 KB |
| Library app JS (gzipped) | < 150 KB | > 120 KB | 50-140 KB |
| Library app CSS (gzipped) | < 50 KB | > 40 KB | 10-45 KB |
| Total dist size | < 25 MB | > 20 MB | ~18 MB |

**Enforcing Budgets in CI:**
```yaml
# .github/workflows/build.yml
- name: Check bundle sizes
  run: |
    SHELL_SIZE=$(gzip -c dist/assets/shell-*.js | wc -c)
    if [ $SHELL_SIZE -gt 51200 ]; then
      echo "Shell JS exceeds 50KB budget: $SHELL_SIZE bytes"
      exit 1
    fi
```

**Vite Bundle Analyzer:**
```bash
# Generate bundle size report per app
cd apps/shell && npx vite-bundle-visualizer
cd apps/mui && npx vite-bundle-visualizer
```

### Load Time Targets

| Metric | Target | Warning | How to Measure |
|--------|--------|---------|----------------|
| Shell FCP (First Contentful Paint) | < 1.5s | > 1.2s | Lighthouse |
| Shell LCP (Largest Contentful Paint) | < 2.5s | > 2.0s | Lighthouse |
| Iframe load (per library) | < 500ms | > 400ms | Performance API |
| Time to Interactive | < 3.0s | > 2.5s | Lighthouse |
| Total Blocking Time | < 200ms | > 150ms | Lighthouse |

**Local Performance Testing:**
```bash
# Run Lighthouse CI locally
npm install -g @lhci/cli
lhci autorun --collect.url=http://localhost:4000/

# Or use Chrome DevTools
# 1. Open DevTools > Performance tab
# 2. Throttle to "Fast 3G"
# 3. Record page load
# 4. Check FCP/LCP markers
```

### Real User Monitoring (RUM)

For a learning project, use lightweight open-source RUM:

**Option 1: Web Vitals Library (Minimal)**
```typescript
// apps/shell/src/vitals.ts
import { onCLS, onFCP, onLCP, onTTFB } from 'web-vitals';

function sendToAnalytics(metric) {
  // Log to console for local development
  console.log(`[Vitals] ${metric.name}: ${metric.value}`);

  // Optional: Send to free analytics (Plausible, Umami, etc.)
  if (import.meta.env.PROD) {
    navigator.sendBeacon('/api/vitals', JSON.stringify(metric));
  }
}

onCLS(sendToAnalytics);
onFCP(sendToAnalytics);
onLCP(sendToAnalytics);
onTTFB(sendToAnalytics);
```

**Option 2: Custom Iframe Load Tracking**
```typescript
// apps/shell/src/components/IframeCard.tsx
function IframeCard({ src, title }) {
  const startTime = useRef(performance.now());

  const handleLoad = () => {
    const loadTime = performance.now() - startTime.current;
    console.log(`[Iframe] ${title} loaded in ${loadTime.toFixed(0)}ms`);

    // Flag slow iframes (> 500ms budget)
    if (loadTime > 500) {
      console.warn(`[Perf] ${title} exceeded 500ms budget`);
    }
  };

  return <iframe src={src} title={title} onLoad={handleLoad} />;
}
```

### Error Tracking

**Option 1: Console-Based (Development)**
```typescript
// apps/shell/src/main.tsx
window.addEventListener('error', (event) => {
  console.error('[Error]', event.message, event.filename, event.lineno);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Promise Rejection]', event.reason);
});
```

**Option 2: Sentry Free Tier (Production)**
```typescript
// apps/shell/src/main.tsx
import * as Sentry from '@sentry/react';

if (import.meta.env.PROD) {
  Sentry.init({
    dsn: 'https://your-dsn@sentry.io/project',
    environment: 'production',
    sampleRate: 0.1, // 10% of errors (free tier friendly)
  });
}
```

**Iframe Error Capture:**
```typescript
// Listen for errors from library iframes
window.addEventListener('message', (event) => {
  if (event.data?.type === 'iframe-error') {
    console.error(`[Iframe Error] ${event.data.library}:`, event.data.error);
  }
});

// In each library app (apps/mui/src/main.tsx)
window.addEventListener('error', (event) => {
  window.parent.postMessage({
    type: 'iframe-error',
    library: 'mui',
    error: event.message,
  }, '*');
});
```

---

## Build Pipeline Resilience

### Parallel Build with Retry Logic

```javascript
// scripts/build-all.mjs
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const CONCURRENCY = 4;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

async function buildWithRetry(lib, attempt = 1) {
  try {
    console.log(`[Build] ${lib} (attempt ${attempt})`);
    await execAsync(`cd apps/${lib} && bun run build`, {
      timeout: 120000, // 2 minute timeout per app
    });
    console.log(`[Build] ${lib} completed`);
    return { lib, success: true };
  } catch (error) {
    if (attempt < MAX_RETRIES) {
      console.warn(`[Retry] ${lib} failed, retrying in ${RETRY_DELAY_MS}ms...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return buildWithRetry(lib, attempt + 1);
    }
    console.error(`[Failed] ${lib} after ${MAX_RETRIES} attempts`);
    return { lib, success: false, error: error.message };
  }
}

async function buildAll(libraries) {
  const results = [];

  for (let i = 0; i < libraries.length; i += CONCURRENCY) {
    const batch = libraries.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(buildWithRetry));
    results.push(...batchResults);

    // Force garbage collection between batches (prevents OOM)
    if (global.gc) global.gc();
  }

  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    console.error(`\n[Summary] ${failed.length} builds failed:`);
    failed.forEach(f => console.error(`  - ${f.lib}: ${f.error}`));
    process.exit(1);
  }

  console.log(`\n[Summary] All ${results.length} builds succeeded`);
}
```

### Artifact Storage Strategy

**Local Development:**
```
dist/                           # Full build output
├── shell/
├── mui/
└── ... (committed to gh-pages branch)

.build-cache/                   # Not committed, local only
├── shell-abc123.tar.gz        # Cached successful builds
├── mui-def456.tar.gz
└── ...
```

**CI/CD Artifact Caching:**
```yaml
# .github/workflows/deploy.yml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Cache Bun dependencies
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ hashFiles('**/bun.lockb') }}

      - name: Cache build outputs
        uses: actions/cache@v4
        with:
          path: |
            apps/*/dist
            dist
          key: build-${{ github.sha }}
          restore-keys: |
            build-

      - name: Build all apps
        run: bun run build:all

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: dist-${{ github.sha }}
          path: dist/
          retention-days: 14
```

### CI/CD Pipeline Configuration

```yaml
# .github/workflows/deploy.yml
name: Build and Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build all apps (with retries)
        run: node scripts/build-all.mjs

      - name: Check bundle sizes
        run: node scripts/check-budgets.mjs

      - name: Run Lighthouse CI
        run: |
          npm install -g @lhci/cli
          lhci autorun
        continue-on-error: true

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: dist-${{ github.sha }}
          path: dist/
          retention-days: 14

  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest

    steps:
      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          name: dist-${{ github.sha }}
          path: dist/

      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
          cname: 20forms.example.com  # Optional custom domain
```

### Build Failure Handling

| Failure Type | Detection | Recovery |
|-------------|-----------|----------|
| Single app timeout | `execAsync` timeout | Retry up to 2x |
| OOM during batch | Process exit code | Reduce CONCURRENCY to 2 |
| Dependency install fail | bun install exit code | Retry with cache clear |
| All apps fail | Zero successful builds | Block deploy, alert |

**Graceful Degradation:**
```javascript
// If some apps fail but shell + majority succeed, deploy with warning
const MINIMUM_APPS = 35; // Out of 42

if (successCount >= MINIMUM_APPS) {
  console.warn(`[Deploy] Proceeding with ${successCount}/${total} apps`);
  // Generate list of broken apps for the README
  await generateBrokenAppsNotice(failedApps);
}
```

---

## Cost Tradeoffs for Hosting

### Hosting Platform Comparison

| Platform | Free Tier | Paid | Best For |
|----------|-----------|------|----------|
| **GitHub Pages** | Unlimited for public repos | N/A | This project (free, simple) |
| **Netlify** | 100GB/month bandwidth | $19/month (pro) | Custom headers, forms |
| **Vercel** | 100GB/month bandwidth | $20/month (pro) | Edge functions (not needed) |
| **Cloudflare Pages** | Unlimited bandwidth | Free | High traffic (overkill here) |

**Recommendation:** GitHub Pages

- Zero cost for public repository
- Automatic HTTPS
- Fastly CDN included
- Sufficient for learning project (~10-100 daily visitors)

### Build Minutes Comparison

| Platform | Free Build Minutes | Our Usage (~3 min/build) |
|----------|-------------------|--------------------------|
| GitHub Actions | 2000 min/month | ~660 builds/month |
| Netlify | 300 min/month | ~100 builds/month |
| Vercel | 6000 min/month | ~2000 builds/month |

**Recommendation:** GitHub Actions (included with repo)

### Storage Costs

| Item | Size | Monthly Cost |
|------|------|--------------|
| dist folder | ~18 MB | Free (GitHub Pages) |
| Build artifacts (14 days) | ~250 MB | Free (GitHub Actions) |
| Source repo | ~5 MB | Free (GitHub) |

**Total Monthly Cost: $0**

### When to Consider Paid Hosting

Upgrade if:
- Traffic exceeds 100GB/month (~5000 visitors with full page loads)
- Need custom server-side logic (not applicable for static site)
- Need password protection (GitHub Pages doesn't support)
- Need custom headers for security compliance

---

## Future Optimizations

- [ ] Add more design systems as they emerge
- [ ] Form validation behavior comparison
- [ ] Accessibility audit per library
- [ ] Performance metrics per library
- [ ] Mobile responsiveness comparison
- [ ] Export comparison as image/PDF
