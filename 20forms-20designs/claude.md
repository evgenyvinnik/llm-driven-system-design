# 20 Forms, 40 Designs - Development Notes

## Project Context

This document tracks design decisions and system design concepts explored in 20forms-20designs, a comparative showcase of React design system libraries.

**External Repository:** [github.com/evgenyvinnik/20forms-20designs](https://github.com/evgenyvinnik/20forms-20designs)

## System Design Concepts Explored

### 1. CSS Isolation Strategies

The core challenge: How to render multiple design systems without style conflicts?

**Approaches Evaluated:**

| Strategy | Isolation Level | Complexity | Chosen |
|----------|-----------------|------------|--------|
| Single SPA | None | Low | ❌ |
| CSS Modules | Class names only | Low | ❌ |
| Shadow DOM | Partial | Medium | ❌ |
| Iframe | Complete | High | ✅ |

**Key Learning:** Complete CSS isolation requires separate browsing contexts. Shadow DOM leaks CSS custom properties and doesn't work well with design system context providers.

### 2. Monorepo Architecture

Managing 42 interdependent applications:

```
root/
├── apps/shell/          # Host application
├── apps/mui/            # MUI forms
├── apps/chakra/         # Chakra forms
└── apps/...             # 39 more libraries
```

**Package Management Pattern:**
```json
// root package.json
{
  "workspaces": ["apps/*"]
}

// apps/mui/package.json
{
  "dependencies": {
    "@mui/material": "^5.0.0",
    "react": "^18.0.0"
  }
}
```

**Key Learning:** Bun workspaces handle dependency hoisting well, but each app needs its own React instance for isolation.

### 3. Parallel Build Orchestration

Building 42 apps efficiently:

```javascript
// Naive approach: 42 × 30s = 21 minutes
await Promise.all(apps.map(app => build(app)));

// Memory-limited approach: 4 concurrent = ~3 minutes
for (const batch of chunk(apps, 4)) {
  await Promise.all(batch.map(app => build(app)));
}
```

**Key Learning:** Parallel builds need memory limits. 42 concurrent Vite builds exhaust memory.

### 4. Static Site Generation

Deploying to GitHub Pages:

```
dist/
├── index.html          # Shell app
├── mui/
│   ├── index.html      # MUI app
│   └── assets/
├── chakra/
│   ├── index.html      # Chakra app
│   └── assets/
└── ...
```

**Key Learning:** GitHub Pages works well for multi-app static sites. Just need correct base paths in Vite config.

## Design Decisions Log

### 1. One App Per Library

**Decision:** Separate Vite application for each design system.

**Rationale:**
- Clean dependency isolation
- Different React versions if needed
- Independent build caching
- Simpler debugging

**Trade-off:** More disk space, longer total build time

### 2. Query Parameter Communication

**Decision:** Pass form/theme via URL query params.

**Alternative:** postMessage between shell and iframes.

**Rationale:**
- Deep linking works automatically
- No message coordination needed
- Browser handles caching
- Simpler implementation

### 3. Reference Implementation

**Decision:** React (No CSS) as the canonical reference.

**Rationale:**
- Pure structure, no styling opinions
- Clear baseline for comparison
- Documents expected field structure
- Ensures consistency across libraries

### 4. Theme Support Opt-In

**Decision:** Mark libraries as theme-supporting or not.

**Rationale:**
- Some libraries (Evergreen) only support light mode
- Don't force broken dark modes
- Clear visual indicator in UI

## Iterations and Learnings

### Iteration 1: Single SPA Attempt

Tried rendering all libraries in one React app:

```jsx
// This broke everything
<MUIThemeProvider>
  <ChakraProvider>
    <AntConfigProvider>
      {/* CSS chaos */}
    </AntConfigProvider>
  </ChakraProvider>
</MUIThemeProvider>
```

**Learning:** Design system providers and CSS resets conflict. Nesting doesn't help.

### Iteration 2: Shadow DOM Attempt

Tried using Shadow DOM for isolation:

```jsx
function IsolatedForm({ library, children }) {
  const shadowRef = useRef();
  useEffect(() => {
    const shadow = shadowRef.current.attachShadow({ mode: 'open' });
    // Inject library CSS into shadow
  }, []);
  return <div ref={shadowRef}>{children}</div>;
}
```

**Learning:** Shadow DOM doesn't isolate:
- CSS custom properties (inherit through)
- React context (doesn't cross shadow boundary)
- Some library internals that expect global scope

### Iteration 3: Iframe Architecture

Current solution with complete isolation:

```jsx
<iframe
  src={`/${library}/?form=${form}&theme=${theme}`}
  title={`${library} ${form}`}
/>
```

**Learning:** Iframes provide true isolation. The overhead is acceptable for this use case.

### Iteration 4: Build Optimization

Parallel builds with memory management:

```javascript
const BATCH_SIZE = 4; // Prevent OOM
for (const batch of batches) {
  await Promise.all(batch.map(buildApp));
  // GC between batches
  if (global.gc) global.gc();
}
```

**Learning:** Vite builds are memory-intensive. Batching prevents crashes.

## Technical Challenges

### Challenge 1: Consistent Form Structure

**Problem:** 41 implementations must have identical form fields.

**Solution:** TypeScript interface + linting rule:

```typescript
interface LoginFormFields {
  email: string;
  password: string;
}

// Lint rule: All LoginForm components must use this interface
```

### Challenge 2: Library Version Conflicts

**Problem:** Some libraries require different React versions.

**Solution:** Each app has its own node_modules:

```
apps/library-a/node_modules/react@18.2.0
apps/library-b/node_modules/react@18.3.0
```

### Challenge 3: Build Time

**Problem:** 42 apps × 30s = too long for CI.

**Solution:**
- Parallel builds (4 concurrent)
- Incremental builds (only changed apps)
- Cache Vite build artifacts

### Challenge 4: Iframe Loading Performance

**Problem:** 41 iframes loading simultaneously is slow.

**Solution:** Lazy loading with Intersection Observer:

```javascript
const [shouldLoad, setShouldLoad] = useState(false);

useEffect(() => {
  const observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      setShouldLoad(true);
      observer.disconnect();
    }
  });
  observer.observe(containerRef.current);
}, []);

return shouldLoad ? <iframe src={src} /> : <Placeholder />;
```

## Design System Observations

### Commonalities

- All support form elements (input, select, button)
- Most support theming (38/41)
- All work with React 18

### Differences

| Aspect | Variation |
|--------|-----------|
| Bundle Size | 20KB (Headless) to 500KB+ (Carbon) |
| Theme API | CSS vars, JS theme object, Tailwind |
| Form Handling | Controlled, uncontrolled, form libraries |
| Accessibility | Varies significantly |

### Surprising Findings

1. **Salesforce Lightning** is light-only (enterprise standard)
2. **Headless UI** requires significant custom styling
3. **Tamagui** designed for React Native, works in web
4. **Gestalt (Pinterest)** has unique interaction patterns

## Performance Metrics

| Metric | Target | Achieved |
|--------|--------|----------|
| Build Time (full) | < 5 min | ~3 min |
| Shell Load Time | < 2s | ~1.5s |
| Iframe Load | < 500ms | ~300ms |
| Lighthouse Score | > 80 | 85 |

## Resources

- [Design Systems Repo Collection](https://github.com/alexpate/awesome-design-systems)
- [CSS Isolation Patterns](https://css-tricks.com/encapsulating-style-and-structure-with-shadow-dom/)
- [Vite Monorepo Guide](https://vitejs.dev/guide/build.html#multi-page-app)
- [Bun Workspaces](https://bun.sh/docs/install/workspaces)

---

*This document captures design insights from the 20forms-20designs project for system design learning purposes.*
