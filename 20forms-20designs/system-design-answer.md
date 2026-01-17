# 20 Forms, 40 Designs - System Design Interview Answer

## Introduction (2 minutes)

"Today I'll design 20 Forms, 40 Designs - a platform that renders identical forms across 41 React design systems for comparison. The name refers to 20 forms × 2 themes (light/dark) = 40 designs per library, though the project now supports 41 libraries. This is an interesting problem because it requires:

1. Complete CSS isolation between competing design systems
2. Efficient monorepo architecture for 42 applications (41 libraries + 1 shell)
3. Parallel build orchestration at scale
4. Static deployment for cost-effective hosting

Let me clarify the requirements."

---

## Requirements Clarification (3 minutes)

### Functional Requirements

"For the comparison platform:

1. **Form Rendering**: Display 20 common forms (login, signup, checkout, etc.)
2. **Library Support**: 41 React design system libraries
3. **Comparison Matrix**: Side-by-side viewing of any library combination
4. **Theme Toggle**: Light/dark mode for supported libraries
5. **Deep Linking**: Shareable URLs to specific comparisons

The CSS isolation problem is the core technical challenge."

### Non-Functional Requirements

"For developer experience:

- **Zero CSS Bleed**: No style conflicts between any two libraries
- **Build Time**: Under 5 minutes for 42 apps
- **Load Time**: Fast navigation between comparisons
- **Static Hosting**: No server required (GitHub Pages)

The CSS isolation requirement eliminates most obvious approaches."

---

## The CSS Isolation Problem (5 minutes)

### Why This Is Hard

"Consider loading MUI and Chakra in the same React app:

```jsx
// This breaks!
<div>
  <MuiThemeProvider>
    <MuiButton>MUI Button</MuiButton>
  </MuiThemeProvider>
  <ChakraProvider>
    <ChakraButton>Chakra Button</ChakraButton>
  </ChakraProvider>
</div>
```

**What goes wrong:**
- MUI's `CssBaseline` resets Chakra's defaults
- Chakra's global styles override MUI's typography
- CSS custom properties (`--chakra-colors-blue-500`) conflict
- Both libraries fight over `body` and `html` styles"

### Options Evaluated

| Approach | Isolation Level | Verdict |
|----------|-----------------|---------|
| Single SPA | None | ❌ Styles clash immediately |
| CSS Modules | Class names only | ❌ Doesn't isolate resets, variables |
| Shadow DOM | Partial | ❌ CSS vars leak, context breaks |
| **Iframe** | **Complete** | ✅ Separate browsing contexts |

"Only iframes provide true isolation - each has its own document, stylesheets, and JavaScript runtime."

---

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Shell Application (Host)                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Control Panel                               │    │
│  │  [Form: Login ▼] [Libraries: ✓MUI ✓Chakra] [🌙/☀️]      │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Preview Grid                          │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │    │
│  │  │   <iframe>   │  │   <iframe>   │  │   <iframe>   │   │    │
│  │  │  src="/mui/  │  │ src="/chakra │  │ src="/antd/  │   │    │
│  │  │  ?form=login │  │ ?form=login" │  │ ?form=login" │   │    │
│  │  │              │  │              │  │              │   │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                    ▼                ▼                ▼
        ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
        │   MUI App     │  │  Chakra App   │  │   Antd App    │
        │   (Vite)      │  │   (Vite)      │  │   (Vite)      │
        └───────────────┘  └───────────────┘  └───────────────┘
```

"The shell orchestrates the comparison view. Each library runs in its own iframe, which is a completely separate React application built with Vite."

---

## Monorepo Structure (5 minutes)

### Project Layout

```
20forms-20designs/
├── apps/
│   ├── shell/                 # Host application
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   └── components/
│   │   └── vite.config.ts
│   │
│   ├── mui/                   # 20 forms with MUI
│   │   ├── src/
│   │   │   └── forms/         # Login, Signup, etc.
│   │   └── vite.config.ts
│   │
│   ├── chakra/                # 20 forms with Chakra
│   ├── antd/                  # 20 forms with Ant Design
│   └── ... (38 more libraries)
│
├── scripts/
│   ├── build-all.mjs          # Parallel build
│   └── copy-to-dist.mjs       # Deployment
│
└── package.json               # Bun workspaces
```

### Why Separate Apps?

"Each library app has:
- Its own `package.json` with library dependencies
- Its own `node_modules` (some libraries conflict)
- Its own Vite build configuration
- Its own React instance

This isolation at build time mirrors the runtime iframe isolation."

---

## Communication: Shell ↔ Iframe (5 minutes)

### URL-Based Configuration

"The shell communicates via URL query parameters:

```
/mui/?form=login&theme=dark
      │          │
      │          └── Theme preference
      └── Which form to render
```

**Why URL parameters over postMessage?**
- Deep linking works automatically
- Browser history works (back button)
- No coordination logic needed
- Bookmarkable states"

### Implementation

```typescript
// Shell: Render iframe for each selected library
function PreviewCard({ library, form, theme }) {
  return (
    <iframe
      src={`/${library}/?form=${form}&theme=${theme}`}
      title={`${library} - ${form}`}
    />
  )
}

// Library App: Read URL params
function App() {
  const params = new URLSearchParams(window.location.search)
  const form = params.get('form') || 'login'
  const theme = params.get('theme') || 'light'
  
  return (
    <LibraryProvider theme={theme}>
      <FormRouter form={form} />
    </LibraryProvider>
  )
}
```

---

## Build Orchestration (5 minutes)

### The Challenge

"Building 42 Vite apps:
- Sequential: 42 × 30s = 21 minutes ❌
- All parallel: Out of memory ❌
- Batched parallel: ~3 minutes ✅"

### Implementation

```javascript
// scripts/build-all.mjs
const apps = ['shell', 'mui', 'chakra', 'antd', /* ... */]
const BATCH_SIZE = 4  // Concurrent builds

async function buildAll() {
  for (let i = 0; i < apps.length; i += BATCH_SIZE) {
    const batch = apps.slice(i, i + BATCH_SIZE)
    
    console.log(`Building: ${batch.join(', ')}`)
    
    await Promise.all(batch.map(app => 
      exec(`cd apps/${app} && npm run build`)
    ))
    
    // Explicit GC if available
    if (global.gc) global.gc()
  }
}
```

### Why Limit Concurrency?

"Vite builds are memory-intensive:
- Each build: ~500MB RAM
- 42 concurrent: 21GB RAM (crashes)
- 4 concurrent: 2GB RAM (manageable)

The batch approach balances speed with memory constraints."

---

## Form Standardization (3 minutes)

### Consistency Challenge

"All 41 implementations must have identical:
- Field labels and placeholder text
- Validation rules
- Submit button text
- Required fields

Otherwise comparisons are unfair."

### Reference Implementation

"React (No CSS) serves as the canonical reference:

```typescript
// Shared interface across all libraries
interface LoginFormProps {
  onSubmit: (data: { email: string; password: string }) => void
}

// Reference implementation
function LoginForm({ onSubmit }: LoginFormProps) {
  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <label htmlFor="email">Email address</label>
      <input id="email" type="email" required />
      
      <label htmlFor="password">Password</label>
      <input id="password" type="password" required />
      
      <button type="submit">Sign in</button>
    </form>
  )
}
```

Every library's LoginForm must render semantically equivalent HTML with identical labels."

---

## Deployment: GitHub Pages (3 minutes)

### Build Output Structure

```
dist/
├── index.html              # Shell
├── assets/                 # Shell assets
├── mui/
│   ├── index.html          # MUI app
│   └── assets/
├── chakra/
│   ├── index.html          # Chakra app
│   └── assets/
└── ... (39 more libraries)
```

### Deployment Script

```javascript
// scripts/copy-to-dist.mjs
async function copyBuilds() {
  // Copy shell
  await copy('apps/shell/dist', 'dist')
  
  // Copy each library app
  for (const lib of libraries) {
    await copy(`apps/${lib}/dist`, `dist/${lib}`)
  }
}
```

### Why Static Hosting?

"No server costs or scaling concerns:
- GitHub Pages is free for public repos
- CDN-backed for global performance
- Automatic HTTPS
- Push to deploy"

---

## Performance Considerations (3 minutes)

### Bundle Duplication

"Each library app bundles React independently:

```
Total overhead: 41 × ~40KB (gzipped) = ~1.6MB duplicated
```

Trade-off: Accept duplication for isolation. Users only load 2-3 iframes at a time, not all 41."

### Lazy Loading Iframes

"Don't load all iframes immediately:

```jsx
function LazyIframe({ src }) {
  const [shouldLoad, setShouldLoad] = useState(false)
  const ref = useRef()
  
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setShouldLoad(true)
        observer.disconnect()
      }
    })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  
  return (
    <div ref={ref}>
      {shouldLoad ? <iframe src={src} /> : <Skeleton />}
    </div>
  )
}
```

Only iframes visible in viewport are loaded."

---

## Trade-offs and Decisions (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Isolation | Iframe | Shadow DOM | Complete CSS isolation |
| Structure | Separate apps | Single app | Clean dependencies |
| Build | Bun | npm | Faster installs |
| Hosting | GitHub Pages | Vercel | Free, simple |
| Communication | URL params | postMessage | Deep linking |

### What I'd Add With More Time

1. **Visual regression testing**: Screenshot comparison per library
2. **Accessibility audit**: WCAG compliance scoring per form
3. **Bundle size comparison**: Show library sizes
4. **Mobile responsiveness**: Form comparison at different viewports

---

## Summary

"To summarize, I've designed 20 Forms, 40 Designs with:

1. **Iframe-based isolation** for zero CSS bleed between libraries
2. **Monorepo architecture** with 42 independent Vite apps
3. **Batched parallel builds** for reasonable build times (~3 min)
4. **URL-based communication** between shell and library apps
5. **Static deployment** to GitHub Pages for cost-free hosting

The key insight is that true CSS isolation requires separate browsing contexts. The overhead of 42 separate builds is acceptable for guaranteed visual fidelity in comparisons.

What aspects would you like to explore further?"
