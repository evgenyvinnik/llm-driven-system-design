# Image Gallery - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

---

## 1. Requirements Clarification (2 min)

### Functional Requirements
- Display images in three layouts: slideshow, masonry grid, tiles grid
- Navigation between images (arrows, thumbnails, click)
- Full-screen lightbox view with keyboard controls
- Responsive design adapting to viewport sizes

### Non-Functional Requirements
- Fast initial load (< 3 seconds for first meaningful paint)
- Smooth animations and transitions (60fps)
- Full keyboard accessibility
- Works on all modern browsers

### UI/UX Requirements
- Tab-based layout switching for instant transitions
- Visual feedback on hover and focus states
- Intuitive controls matching user expectations
- Mobile-friendly touch interactions

---

## 2. High-Level Architecture (3 min)

### Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────────┐
│                              App                                     │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                          Header                                │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  GalleryTabs                                                   │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐              │ │
│  │  │ Slideshow   │ │  Masonry    │ │   Tiles     │              │ │
│  │  └─────────────┘ └─────────────┘ └─────────────┘              │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  GalleryContent (shows one of:)                                │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │ │
│  │  │  SlideshowView                                           │  │ │
│  │  │  ├── MainImage                                           │  │ │
│  │  │  ├── NavigationArrows (left/right)                       │  │ │
│  │  │  ├── PlayPauseControl                                    │  │ │
│  │  │  └── ThumbnailStrip                                      │  │ │
│  │  └─────────────────────────────────────────────────────────┘  │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │ │
│  │  │  MasonryView                                             │  │ │
│  │  │  └── MasonryItem × n (variable heights)                  │  │ │
│  │  └─────────────────────────────────────────────────────────┘  │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │ │
│  │  │  TilesView                                               │  │ │
│  │  │  └── TileItem × n (uniform squares)                      │  │ │
│  │  └─────────────────────────────────────────────────────────┘  │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  Lightbox (Portal to document.body)                           │ │
│  │  ├── LightboxImage                                            │ │
│  │  ├── NavigationArrows                                         │ │
│  │  └── CloseButton                                              │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### State Flow

```
┌──────────────────────────────────────────────────────┐
│                  Zustand Store                        │
├──────────────────────────────────────────────────────┤
│  activeTab: 'Slideshow' | 'Masonry' | 'Tiles'       │
│  slideshowIndex: number                              │
│  isPlaying: boolean                                  │
│  lightboxImage: number | null                        │
│  images: ImageData[]                                 │
└──────────────────────────────────────────────────────┘
         │                    │                  │
         ▼                    ▼                  ▼
   ┌─────────┐          ┌──────────┐       ┌─────────┐
   │  Tabs   │          │ Gallery  │       │Lightbox │
   │Component│          │  Views   │       │  Modal  │
   └─────────┘          └──────────┘       └─────────┘
```

---

## 3. Deep Dive: CSS Layout Implementations (10 min)

### A. Slideshow Layout (Flexbox + Positioning)

"The slideshow uses a flex column layout with the main image container using relative positioning. Navigation arrows and play/pause controls are absolutely positioned within the container."

```
┌─────────────────────────────────────────────────────────────────────┐
│                      SlideshowView                                   │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  slideshow__main (relative, aspect-ratio: 16/9)               │ │
│  │                                                               │ │
│  │  ┌─────┐                                           ┌─────┐   │ │
│  │  │  ←  │                                           │  →  │   │ │
│  │  │ nav │          [Main Image]                     │ nav │   │ │
│  │  │prev │         (object-fit: contain)             │next │   │ │
│  │  └─────┘                                           └─────┘   │ │
│  │                                                               │ │
│  │                                              ┌─────────────┐ │ │
│  │                                              │ ▶ Play/Pause│ │ │
│  │                                              └─────────────┘ │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  ThumbnailStrip (horizontal scroll)                           │ │
│  │  [img] [img] [img] [img] [img] [img] [img] ...               │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  Keyboard Controls:                                                 │
│  ├── ArrowLeft: prevSlide()                                        │
│  ├── ArrowRight: nextSlide()                                       │
│  └── Space: toggle isPlaying                                       │
│                                                                     │
│  Auto-play: setInterval(nextSlide, 3000) when isPlaying=true       │
└─────────────────────────────────────────────────────────────────────┘
```

**CSS Properties:**
- `.slideshow`: flex, column, gap: 1rem, max-width: 1200px
- `.slideshow__main`: relative, aspect-ratio: 16/9, overflow: hidden
- `.slideshow__nav`: absolute, top: 50%, translateY(-50%), semi-transparent background
- `.slideshow__play`: absolute, bottom: 1rem, right: 1rem

### B. Masonry Grid (CSS Columns)

"The masonry layout uses pure CSS columns property, avoiding JavaScript-based masonry libraries. Items flow top-to-bottom within each column, then left-to-right across columns."

```
┌─────────────────────────────────────────────────────────────────────┐
│                       MasonryView                                    │
│                                                                     │
│  CSS: columns: 4 300px (4 columns, min 300px each)                  │
│       column-gap: 1rem                                              │
│                                                                     │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐                    │
│  │  img1  │  │  img2  │  │  img3  │  │  img4  │                    │
│  │ 280px  │  │ 350px  │  │ 200px  │  │ 320px  │                    │
│  └────────┘  └────────┘  └────────┘  └────────┘                    │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐                    │
│  │  img5  │  │  img6  │  │  img7  │  │  img8  │                    │
│  │ 320px  │  │ 240px  │  │ 380px  │  │ 260px  │                    │
│  └────────┘  └────────┘  └────────┘  └────────┘                    │
│  ...                                                                │
│                                                                     │
│  Image heights: pseudo-random based on ID                           │
│  getImageHeight(id) = 200 + ((id * 7) % 200)  // 200-400px         │
│                                                                     │
│  .masonry__item:                                                    │
│  ├── break-inside: avoid (prevent splitting across columns)        │
│  ├── hover: translateY(-4px), box-shadow                           │
│  └── focus: outline: 3px solid #3b82f6                             │
│                                                                     │
│  Responsive breakpoints:                                            │
│  ├── > 1200px: 4 columns                                           │
│  ├── > 768px:  3 columns                                           │
│  ├── > 480px:  2 columns                                           │
│  └── mobile:   1 column                                            │
└─────────────────────────────────────────────────────────────────────┘
```

**CSS Properties:**
- `.masonry`: columns: 4 300px, column-gap: 1rem
- `.masonry__item`: break-inside: avoid, transition: transform 0.2s
- `.masonry__image`: width: 100%, height: 100%, object-fit: cover

### C. Tiles Grid (CSS Grid)

"The tiles layout uses CSS Grid with auto-fill to create a responsive grid of equal-sized square tiles."

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TilesView                                     │
│                                                                     │
│  CSS: grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)) │
│       gap: 1rem                                                     │
│                                                                     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │  1:1    │ │  1:1    │ │  1:1    │ │  1:1    │ │  1:1    │       │
│  │ square  │ │ square  │ │ square  │ │ square  │ │ square  │       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │  1:1    │ │  1:1    │ │  1:1    │ │  1:1    │ │  1:1    │       │
│  │ square  │ │ square  │ │ square  │ │ square  │ │ square  │       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
│  ...                                                                │
│                                                                     │
│  .tile:                                                             │
│  ├── aspect-ratio: 1 (perfect squares)                             │
│  └── hover: .tile__image scale(1.05) with overflow: hidden         │
│                                                                     │
│  Responsive: minmax(150px, 1fr) on tablets                          │
└─────────────────────────────────────────────────────────────────────┘
```

**CSS Properties:**
- `.tiles`: display: grid, grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))
- `.tile`: aspect-ratio: 1, overflow: hidden
- `.tile__image`: transition: transform 0.3s, scale on hover

---

## 4. Deep Dive: State Management with Zustand (8 min)

### Gallery Store Implementation

```
┌─────────────────────────────────────────────────────────────────────┐
│                      useGalleryStore                                 │
│                                                                     │
│  State:                                                             │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  images: ImageData[]                                         │   │
│  │    - Pre-initialized with 50 stable picsum IDs (10-59)       │   │
│  │    - Each: { id: number, alt: string }                       │   │
│  │                                                              │   │
│  │  activeTab: 'Slideshow' | 'Masonry' | 'Tiles'               │   │
│  │  slideshowIndex: number                                      │   │
│  │  isPlaying: boolean                                          │   │
│  │  lightboxImage: number | null                                │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Actions:                                                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Tab Navigation:                                             │   │
│  │  └── setActiveTab(tab) ──▶ Updates tab, pauses slideshow    │   │
│  │                                                              │   │
│  │  Slideshow Controls:                                         │   │
│  │  ├── nextSlide() ──▶ index = (index + 1) % length           │   │
│  │  ├── prevSlide() ──▶ index = (index - 1 + length) % length  │   │
│  │  ├── goToSlide(i) ──▶ index = i                             │   │
│  │  └── setIsPlaying(bool) ──▶ isPlaying = bool                │   │
│  │                                                              │   │
│  │  Lightbox Controls:                                          │   │
│  │  ├── openLightbox(id) ──▶ lightboxImage = id                │   │
│  │  │                        document.body.overflow = 'hidden'  │   │
│  │  ├── closeLightbox() ──▶ lightboxImage = null               │   │
│  │  │                       document.body.overflow = ''         │   │
│  │  ├── nextLightboxImage() ──▶ Circular navigation            │   │
│  │  └── prevLightboxImage() ──▶ Circular navigation            │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### State Subscriptions Pattern

"Using Zustand's subscribeWithSelector middleware, we can subscribe to specific state changes for side effects like adding keyboard listeners when the lightbox opens."

```
┌─────────────────────────────────────────────────────────────────────┐
│               Lightbox Keyboard Subscription                         │
│                                                                     │
│  useGalleryStore.subscribe(                                         │
│    (state) => state.lightboxImage,  // Selector                    │
│    (lightboxImage) => {              // Callback                   │
│      if (lightboxImage !== null) {                                  │
│        // Add keyboard handler                                      │
│        handler = (e) => {                                          │
│          switch(e.key) {                                           │
│            case 'Escape': closeLightbox()                          │
│            case 'ArrowRight': nextLightboxImage()                  │
│            case 'ArrowLeft': prevLightboxImage()                   │
│          }                                                         │
│        }                                                           │
│        window.addEventListener('keydown', handler)                  │
│        return () => window.removeEventListener('keydown', handler) │
│      }                                                              │
│    }                                                                │
│  )                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Deep Dive: Lightbox Component (8 min)

### Portal-Based Modal Architecture

"The lightbox uses React's createPortal to render directly into document.body, avoiding z-index stacking context issues."

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Lightbox                                     │
│                                                                     │
│  Renders via: createPortal(..., document.body)                      │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  .lightbox (position: fixed, inset: 0, z-index: 1000)         │ │
│  │                                                               │ │
│  │  ┌─────────────────────────────────────────────────────────┐ │ │
│  │  │  .lightbox__backdrop                                     │ │ │
│  │  │  (absolute, inset: 0, rgba(0,0,0,0.9))                  │ │ │
│  │  │  Animation: fadeIn 0.2s                                  │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  │                                                               │ │
│  │  ┌─────────────────────────────────────────────────────────┐ │ │
│  │  │  .lightbox__content (relative, max-90vw, max-90vh)      │ │ │
│  │  │  Animation: scaleIn 0.2s                                 │ │ │
│  │  │                                                          │ │ │
│  │  │          ┌───────────────────────────┐                   │ │ │
│  │  │          │                           │ [X] Close        │ │ │
│  │  │   [←]    │    .lightbox__image       │    (absolute     │ │ │
│  │  │  prev    │   (max-w/h 100%/90vh)     │    top-right)    │ │ │
│  │  │          │   object-fit: contain     │                  │ │ │
│  │  │          │                           │    [→]           │ │ │
│  │  │          └───────────────────────────┘    next          │ │ │
│  │  │                                                          │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  Focus Management:                                                  │
│  - useRef for close button                                         │
│  - Focus close button on open                                      │
│  - Return focus on close                                           │
│                                                                     │
│  Click Handling:                                                    │
│  - Backdrop click: closeLightbox()                                 │
│  - Content click: e.stopPropagation() (prevent close)              │
│                                                                     │
│  ARIA:                                                              │
│  - role="dialog"                                                    │
│  - aria-modal="true"                                               │
│  - aria-label="Image lightbox"                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Lightbox Animations

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CSS Animations                                   │
│                                                                     │
│  @keyframes fadeIn:                                                 │
│  ├── from: opacity: 0                                               │
│  └── to: opacity: 1                                                 │
│                                                                     │
│  @keyframes scaleIn:                                                │
│  ├── from: transform: scale(0.95), opacity: 0                       │
│  └── to: transform: scale(1), opacity: 1                            │
│                                                                     │
│  Navigation buttons:                                                │
│  - .lightbox__nav--prev: left: -4rem                               │
│  - .lightbox__nav--next: right: -4rem                              │
│  - hover: background: rgba(255,255,255,0.2)                        │
│  - border-radius: 50%                                               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Deep Dive: Image Loading Optimization (8 min)

### Responsive Image Component

"The ResponsiveImage component generates srcSet for multiple resolutions, letting the browser choose the appropriate size based on viewport."

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ResponsiveImage                                   │
│                                                                     │
│  Props:                                                             │
│  ├── imageId: number                                                │
│  ├── alt: string                                                    │
│  ├── sizes: { thumbnail, medium, large }                           │
│  ├── loading: 'lazy' | 'eager'                                     │
│  └── onClick?: () => void                                          │
│                                                                     │
│  State:                                                             │
│  ├── isLoaded: boolean (shows placeholder until loaded)            │
│  └── error: boolean (shows error state)                            │
│                                                                     │
│  Generated srcSet:                                                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  picsum.photos/id/{id}/{thumbnail.w}/{thumbnail.h} {w}w     │   │
│  │  picsum.photos/id/{id}/{medium.w}/{medium.h} {w}w           │   │
│  │  picsum.photos/id/{id}/{large.w}/{large.h} {w}w             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  sizes attribute:                                                   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  (max-width: 480px) {thumbnail.w}px,                         │   │
│  │  (max-width: 1024px) {medium.w}px,                           │   │
│  │  {large.w}px                                                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  States:                                                            │
│  ├── Loading: Show spinner placeholder                             │
│  ├── Error: Show "Failed to load image" message                    │
│  └── Loaded: Show image with 'loaded' class                        │
└─────────────────────────────────────────────────────────────────────┘
```

### Intersection Observer for Lazy Loading

```
┌─────────────────────────────────────────────────────────────────────┐
│                      useLazyLoad Hook                                │
│                                                                     │
│  Options:                                                           │
│  ├── threshold: 0.1 (10% visible triggers load)                    │
│  └── rootMargin: '100px' (preload 100px before visible)            │
│                                                                     │
│  Returns:                                                           │
│  ├── ref: RefObject<T> (attach to element)                         │
│  └── isVisible: boolean (true once element enters viewport)        │
│                                                                     │
│  Behavior:                                                          │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  1. Create IntersectionObserver                              │   │
│  │  2. Observe element                                          │   │
│  │  3. On intersect: setIsVisible(true), disconnect             │   │
│  │  4. Cleanup: disconnect on unmount                           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Note: Once visible, never goes back to hidden (one-way)           │
└─────────────────────────────────────────────────────────────────────┘
```

### Slideshow Image Preloading

```
┌─────────────────────────────────────────────────────────────────────┐
│                   useImagePreloader Hook                             │
│                                                                     │
│  Dependencies: images, slideshowIndex, activeTab                    │
│                                                                     │
│  Effect (only when activeTab === 'Slideshow'):                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  1. Calculate adjacent indices:                              │   │
│  │     - next: (index + 1) % length                             │   │
│  │     - prev: (index - 1 + length) % length                    │   │
│  │                                                              │   │
│  │  2. Create Image objects and set src:                        │   │
│  │     new Image().src = picsum.photos/id/{id}/1200/675        │   │
│  │                                                              │   │
│  │  3. Store references for cleanup                             │   │
│  │                                                              │   │
│  │  4. Cleanup: Clear src on unmount (memory optimization)      │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Result: Adjacent images are cached, navigation feels instant      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Accessibility Implementation (3 min)

### Keyboard Navigation Map

| Key | Context | Action |
|-----|---------|--------|
| ArrowLeft / ArrowRight | Slideshow | Previous/Next image |
| Space | Slideshow | Toggle play/pause |
| ArrowLeft / ArrowRight | Lightbox | Navigate images |
| Escape | Lightbox | Close lightbox |
| Enter | Grid item | Open lightbox |
| Tab | Global | Navigate focusable elements |

### Focus Trap Hook

```
┌─────────────────────────────────────────────────────────────────────┐
│                      useFocusTrap Hook                               │
│                                                                     │
│  Purpose: Trap keyboard focus within modal when open                │
│                                                                     │
│  Behavior:                                                          │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  On open:                                                    │   │
│  │  1. Store document.activeElement (to restore later)          │   │
│  │  2. Find all focusable elements in container                 │   │
│  │     (button, [href], input, select, textarea, [tabindex])   │   │
│  │  3. Focus first element                                      │   │
│  │  4. Add keydown handler for Tab cycling:                     │   │
│  │     - Shift+Tab on first ──▶ focus last                     │   │
│  │     - Tab on last ──▶ focus first                           │   │
│  │                                                              │   │
│  │  On close:                                                   │   │
│  │  1. Remove keydown handler                                   │   │
│  │  2. Restore focus to previously active element               │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Returns: containerRef to attach to modal element                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 8. Performance Optimizations (3 min)

### Optimizations Applied

| Technique | Implementation | Benefit |
|-----------|----------------|---------|
| Lazy loading | Native `loading="lazy"` | Reduces initial payload |
| Responsive images | `srcSet` + `sizes` | Appropriate resolution per device |
| CSS-only layouts | Columns, Grid | No JS layout thrashing |
| Memoization | `React.memo` on grid items | Prevents unnecessary re-renders |
| Preloading | Adjacent slideshow images | Instant navigation |
| Portal rendering | Lightbox in body | Avoids stacking context issues |

### Component Memoization Pattern

```
┌─────────────────────────────────────────────────────────────────────┐
│                    MasonryItem (memoized)                            │
│                                                                     │
│  export const MasonryItem = memo(function MasonryItem({              │
│    imageId,                                                         │
│    alt,                                                             │
│    height,                                                          │
│    onClick,                                                         │
│  }) {                                                               │
│    return (                                                         │
│      <button className="masonry__item" onClick={onClick}>           │
│        <img                                                         │
│          src={`picsum.photos/id/${imageId}/400/${height}`}          │
│          alt={alt}                                                  │
│          loading="lazy"                                             │
│        />                                                           │
│      </button>                                                      │
│    );                                                               │
│  });                                                                │
│                                                                     │
│  Prevents re-render when parent updates but props unchanged         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 9. Trade-offs and Decisions

| Decision | Pros | Cons |
|----------|------|------|
| CSS columns masonry | Simple, performant, native | Column-first ordering (not row) |
| Zustand over Context | Less boilerplate, subscriptions | Additional dependency (small) |
| Portal for lightbox | No z-index issues | Separate DOM subtree |
| Native lazy loading | Zero JS, browser optimized | Less control over timing |
| Hardcoded image IDs | Predictable, no broken images | Static content only |

---

## 10. Summary

### Key Frontend Decisions

1. **CSS-native layouts** for performance over JavaScript-based masonry
2. **Zustand store** for simple but powerful global state management
3. **Portal-based lightbox** for proper modal layering
4. **Keyboard-first navigation** throughout all views
5. **Lazy loading with preloading** for optimal image delivery

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Key Patterns Used                                                   │
│                                                                     │
│  Layout:                                                            │
│  ├── Slideshow: Flexbox + absolute positioning                     │
│  ├── Masonry: CSS columns (column-first flow)                      │
│  └── Tiles: CSS Grid (auto-fill responsive)                        │
│                                                                     │
│  State:                                                             │
│  ├── Zustand with subscribeWithSelector                            │
│  └── Side effects via subscriptions                                │
│                                                                     │
│  Optimization:                                                      │
│  ├── Native lazy loading                                           │
│  ├── Responsive srcSet                                             │
│  ├── React.memo for grid items                                     │
│  └── Image preloading for slideshow                                │
│                                                                     │
│  Accessibility:                                                     │
│  ├── Full keyboard navigation                                      │
│  ├── Focus trap in modal                                           │
│  ├── ARIA roles and labels                                         │
│  └── Focus restoration on close                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### Future Enhancements

- Virtualized grids for 1000+ images
- Touch gestures (swipe, pinch-to-zoom)
- Blurhash placeholders during loading
- Image metadata from API (author, description)
- Infinite scroll with intersection observer
- Animation transitions between layouts
