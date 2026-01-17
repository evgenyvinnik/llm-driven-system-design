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

## Future Optimizations

- [ ] Add more design systems as they emerge
- [ ] Form validation behavior comparison
- [ ] Accessibility audit per library
- [ ] Performance metrics per library
- [ ] Mobile responsiveness comparison
- [ ] Export comparison as image/PDF
