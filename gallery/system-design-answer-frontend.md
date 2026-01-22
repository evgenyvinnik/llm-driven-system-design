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
App
├── Header
├── GalleryTabs
│   └── TabButton × 3
├── GalleryContent
│   ├── SlideshowView
│   │   ├── MainImage
│   │   ├── NavigationArrows
│   │   ├── PlayPauseControl
│   │   └── ThumbnailStrip
│   ├── MasonryView
│   │   └── MasonryItem × n
│   └── TilesView
│       └── TileItem × n
└── Lightbox (Portal)
    ├── LightboxImage
    ├── NavigationArrows
    └── CloseButton
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
   │ Tabs    │          │ Gallery  │       │Lightbox │
   │Component│          │ Views    │       │ Modal   │
   └─────────┘          └──────────┘       └─────────┘
```

---

## 3. Deep Dive: CSS Layout Implementations (10 min)

### A. Slideshow Layout (Flexbox + Positioning)

```typescript
// SlideshowView.tsx
import { useGalleryStore } from '../stores/galleryStore';
import { useEffect, useCallback } from 'react';

export function SlideshowView() {
  const {
    images,
    slideshowIndex,
    isPlaying,
    nextSlide,
    prevSlide,
    setIsPlaying,
  } = useGalleryStore();

  // Auto-play functionality
  useEffect(() => {
    if (!isPlaying) return;

    const interval = setInterval(() => {
      nextSlide();
    }, 3000);

    return () => clearInterval(interval);
  }, [isPlaying, nextSlide]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          prevSlide();
          break;
        case 'ArrowRight':
          nextSlide();
          break;
        case ' ':
          e.preventDefault();
          setIsPlaying(!isPlaying);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextSlide, prevSlide, isPlaying, setIsPlaying]);

  const currentImage = images[slideshowIndex];

  return (
    <div className="slideshow">
      {/* Main Image Container */}
      <div className="slideshow__main">
        <img
          src={`https://picsum.photos/id/${currentImage.id}/1200/675`}
          alt={currentImage.alt}
          className="slideshow__image"
        />

        {/* Navigation Arrows */}
        <button
          className="slideshow__nav slideshow__nav--prev"
          onClick={prevSlide}
          aria-label="Previous image"
        >
          ←
        </button>
        <button
          className="slideshow__nav slideshow__nav--next"
          onClick={nextSlide}
          aria-label="Next image"
        >
          →
        </button>

        {/* Play/Pause Control */}
        <button
          className="slideshow__play"
          onClick={() => setIsPlaying(!isPlaying)}
          aria-label={isPlaying ? 'Pause slideshow' : 'Play slideshow'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
      </div>

      {/* Thumbnail Strip */}
      <ThumbnailStrip
        images={images}
        activeIndex={slideshowIndex}
      />
    </div>
  );
}
```

**CSS Implementation:**

```css
/* Slideshow layout with Flexbox and absolute positioning */
.slideshow {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 1200px;
  margin: 0 auto;
}

.slideshow__main {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #1a1a1a;
  border-radius: 8px;
  overflow: hidden;
}

.slideshow__image {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.slideshow__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(0, 0, 0, 0.5);
  color: white;
  border: none;
  padding: 1rem;
  cursor: pointer;
  transition: background 0.2s;
}

.slideshow__nav:hover {
  background: rgba(0, 0, 0, 0.8);
}

.slideshow__nav--prev { left: 1rem; }
.slideshow__nav--next { right: 1rem; }

.slideshow__play {
  position: absolute;
  bottom: 1rem;
  right: 1rem;
  background: rgba(0, 0, 0, 0.5);
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
}
```

### B. Masonry Grid (CSS Columns)

```typescript
// MasonryView.tsx
import { useGalleryStore } from '../stores/galleryStore';

export function MasonryView() {
  const { images, openLightbox } = useGalleryStore();

  // Generate pseudo-random heights based on image ID
  const getImageHeight = (id: number): number => {
    // Heights vary between 200-400px based on ID
    return 200 + ((id * 7) % 200);
  };

  return (
    <div className="masonry">
      {images.map((image) => (
        <button
          key={image.id}
          className="masonry__item"
          onClick={() => openLightbox(image.id)}
          style={{
            height: getImageHeight(image.id),
          }}
        >
          <img
            src={`https://picsum.photos/id/${image.id}/400/${getImageHeight(image.id)}`}
            alt={image.alt}
            loading="lazy"
            className="masonry__image"
          />
        </button>
      ))}
    </div>
  );
}
```

**CSS Implementation:**

```css
/* True masonry using CSS columns */
.masonry {
  columns: 4 300px;        /* 4 columns, min 300px each */
  column-gap: 1rem;
  padding: 1rem;
}

.masonry__item {
  break-inside: avoid;     /* Prevent item from splitting across columns */
  margin-bottom: 1rem;
  display: block;
  width: 100%;
  border: none;
  padding: 0;
  cursor: pointer;
  border-radius: 8px;
  overflow: hidden;
  transition: transform 0.2s, box-shadow 0.2s;
}

.masonry__item:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
}

.masonry__item:focus {
  outline: 3px solid #3b82f6;
  outline-offset: 2px;
}

.masonry__image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* Responsive column count */
@media (max-width: 1200px) {
  .masonry { columns: 3 250px; }
}

@media (max-width: 768px) {
  .masonry { columns: 2 200px; }
}

@media (max-width: 480px) {
  .masonry { columns: 1; }
}
```

### C. Tiles Grid (CSS Grid)

```typescript
// TilesView.tsx
import { useGalleryStore } from '../stores/galleryStore';

export function TilesView() {
  const { images, openLightbox } = useGalleryStore();

  return (
    <div className="tiles">
      {images.map((image) => (
        <button
          key={image.id}
          className="tile"
          onClick={() => openLightbox(image.id)}
        >
          <img
            src={`https://picsum.photos/id/${image.id}/300/300`}
            alt={image.alt}
            loading="lazy"
            className="tile__image"
          />
        </button>
      ))}
    </div>
  );
}
```

**CSS Implementation:**

```css
/* Uniform grid with CSS Grid */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
  padding: 1rem;
}

.tile {
  aspect-ratio: 1;         /* Perfect squares */
  overflow: hidden;
  border: none;
  padding: 0;
  cursor: pointer;
  border-radius: 8px;
  background: #f3f4f6;
}

.tile__image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s ease;
}

.tile:hover .tile__image {
  transform: scale(1.05);
}

.tile:focus {
  outline: 3px solid #3b82f6;
  outline-offset: 2px;
}

/* Responsive tile sizes */
@media (max-width: 768px) {
  .tiles {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 0.5rem;
  }
}
```

---

## 4. Deep Dive: State Management with Zustand (8 min)

### Gallery Store Implementation

```typescript
// stores/galleryStore.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface ImageData {
  id: number;
  alt: string;
}

type TabType = 'Slideshow' | 'Masonry' | 'Tiles';

interface GalleryState {
  // Image data
  images: ImageData[];

  // Tab navigation
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;

  // Slideshow controls
  slideshowIndex: number;
  isPlaying: boolean;
  nextSlide: () => void;
  prevSlide: () => void;
  goToSlide: (index: number) => void;
  setIsPlaying: (playing: boolean) => void;

  // Lightbox controls
  lightboxImage: number | null;
  openLightbox: (imageId: number) => void;
  closeLightbox: () => void;
  nextLightboxImage: () => void;
  prevLightboxImage: () => void;
}

// Pre-selected stable image IDs (avoiding broken picsum IDs)
const STABLE_IMAGE_IDS = Array.from({ length: 50 }, (_, i) => i + 10);

export const useGalleryStore = create<GalleryState>()(
  subscribeWithSelector((set, get) => ({
    // Initialize with stable image IDs
    images: STABLE_IMAGE_IDS.map((id) => ({
      id,
      alt: `Gallery image ${id}`,
    })),

    // Tab state
    activeTab: 'Slideshow',
    setActiveTab: (tab) => {
      set({ activeTab: tab });
      // Pause slideshow when switching away
      if (tab !== 'Slideshow') {
        set({ isPlaying: false });
      }
    },

    // Slideshow state
    slideshowIndex: 0,
    isPlaying: false,

    nextSlide: () => {
      const { images, slideshowIndex } = get();
      set({
        slideshowIndex: (slideshowIndex + 1) % images.length,
      });
    },

    prevSlide: () => {
      const { images, slideshowIndex } = get();
      set({
        slideshowIndex: (slideshowIndex - 1 + images.length) % images.length,
      });
    },

    goToSlide: (index) => set({ slideshowIndex: index }),

    setIsPlaying: (playing) => set({ isPlaying: playing }),

    // Lightbox state
    lightboxImage: null,

    openLightbox: (imageId) => {
      set({ lightboxImage: imageId });
      // Prevent body scroll when lightbox is open
      document.body.style.overflow = 'hidden';
    },

    closeLightbox: () => {
      set({ lightboxImage: null });
      document.body.style.overflow = '';
    },

    nextLightboxImage: () => {
      const { images, lightboxImage } = get();
      if (lightboxImage === null) return;

      const currentIndex = images.findIndex((img) => img.id === lightboxImage);
      const nextIndex = (currentIndex + 1) % images.length;
      set({ lightboxImage: images[nextIndex].id });
    },

    prevLightboxImage: () => {
      const { images, lightboxImage } = get();
      if (lightboxImage === null) return;

      const currentIndex = images.findIndex((img) => img.id === lightboxImage);
      const prevIndex = (currentIndex - 1 + images.length) % images.length;
      set({ lightboxImage: images[prevIndex].id });
    },
  }))
);
```

### State Subscriptions for Side Effects

```typescript
// Subscribe to lightbox changes for keyboard handling
useGalleryStore.subscribe(
  (state) => state.lightboxImage,
  (lightboxImage) => {
    if (lightboxImage !== null) {
      // Add keyboard listener when lightbox opens
      const handler = (e: KeyboardEvent) => {
        const { closeLightbox, nextLightboxImage, prevLightboxImage } =
          useGalleryStore.getState();

        switch (e.key) {
          case 'Escape':
            closeLightbox();
            break;
          case 'ArrowRight':
            nextLightboxImage();
            break;
          case 'ArrowLeft':
            prevLightboxImage();
            break;
        }
      };

      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }
  }
);
```

---

## 5. Deep Dive: Lightbox Component (8 min)

### Portal-Based Modal

```typescript
// components/Lightbox.tsx
import { createPortal } from 'react-dom';
import { useGalleryStore } from '../stores/galleryStore';
import { useEffect, useRef } from 'react';

export function Lightbox() {
  const {
    images,
    lightboxImage,
    closeLightbox,
    nextLightboxImage,
    prevLightboxImage,
  } = useGalleryStore();

  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Focus management - focus close button when opened
  useEffect(() => {
    if (lightboxImage !== null) {
      closeButtonRef.current?.focus();
    }
  }, [lightboxImage]);

  // Keyboard navigation
  useEffect(() => {
    if (lightboxImage === null) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          closeLightbox();
          break;
        case 'ArrowRight':
          nextLightboxImage();
          break;
        case 'ArrowLeft':
          prevLightboxImage();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxImage, closeLightbox, nextLightboxImage, prevLightboxImage]);

  if (lightboxImage === null) return null;

  const currentImage = images.find((img) => img.id === lightboxImage);
  if (!currentImage) return null;

  return createPortal(
    <div
      className="lightbox"
      onClick={closeLightbox}
      role="dialog"
      aria-modal="true"
      aria-label="Image lightbox"
    >
      {/* Backdrop */}
      <div className="lightbox__backdrop" />

      {/* Content container - stop propagation to prevent close on image click */}
      <div
        className="lightbox__content"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          ref={closeButtonRef}
          className="lightbox__close"
          onClick={closeLightbox}
          aria-label="Close lightbox"
        >
          ×
        </button>

        {/* Navigation */}
        <button
          className="lightbox__nav lightbox__nav--prev"
          onClick={prevLightboxImage}
          aria-label="Previous image"
        >
          ←
        </button>

        {/* Main image */}
        <img
          src={`https://picsum.photos/id/${currentImage.id}/1920/1080`}
          alt={currentImage.alt}
          className="lightbox__image"
        />

        <button
          className="lightbox__nav lightbox__nav--next"
          onClick={nextLightboxImage}
          aria-label="Next image"
        >
          →
        </button>
      </div>
    </div>,
    document.body
  );
}
```

**CSS Implementation:**

```css
/* Lightbox modal styles */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lightbox__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.9);
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.lightbox__content {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  align-items: center;
  animation: scaleIn 0.2s ease;
}

@keyframes scaleIn {
  from { transform: scale(0.95); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.lightbox__image {
  max-width: 100%;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
}

.lightbox__close {
  position: absolute;
  top: -2rem;
  right: -2rem;
  background: none;
  border: none;
  color: white;
  font-size: 2rem;
  cursor: pointer;
  padding: 0.5rem;
  line-height: 1;
}

.lightbox__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(255, 255, 255, 0.1);
  color: white;
  border: none;
  padding: 1rem;
  cursor: pointer;
  font-size: 1.5rem;
  border-radius: 50%;
  transition: background 0.2s;
}

.lightbox__nav:hover {
  background: rgba(255, 255, 255, 0.2);
}

.lightbox__nav--prev { left: -4rem; }
.lightbox__nav--next { right: -4rem; }
```

---

## 6. Deep Dive: Image Loading Optimization (8 min)

### Responsive Image Component

```typescript
// components/ResponsiveImage.tsx
import { useState, useRef, useEffect } from 'react';

interface ResponsiveImageProps {
  imageId: number;
  alt: string;
  sizes: {
    thumbnail: { width: number; height: number };
    medium: { width: number; height: number };
    large: { width: number; height: number };
  };
  loading?: 'lazy' | 'eager';
  className?: string;
  onClick?: () => void;
}

export function ResponsiveImage({
  imageId,
  alt,
  sizes,
  loading = 'lazy',
  className,
  onClick,
}: ResponsiveImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Generate srcSet for responsive images
  const srcSet = [
    `https://picsum.photos/id/${imageId}/${sizes.thumbnail.width}/${sizes.thumbnail.height} ${sizes.thumbnail.width}w`,
    `https://picsum.photos/id/${imageId}/${sizes.medium.width}/${sizes.medium.height} ${sizes.medium.width}w`,
    `https://picsum.photos/id/${imageId}/${sizes.large.width}/${sizes.large.height} ${sizes.large.width}w`,
  ].join(', ');

  const sizesAttr = `
    (max-width: 480px) ${sizes.thumbnail.width}px,
    (max-width: 1024px) ${sizes.medium.width}px,
    ${sizes.large.width}px
  `;

  return (
    <div className={`responsive-image ${className || ''}`}>
      {/* Loading placeholder */}
      {!isLoaded && !error && (
        <div className="responsive-image__placeholder">
          <div className="responsive-image__spinner" />
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="responsive-image__error">
          Failed to load image
        </div>
      )}

      {/* Actual image */}
      <img
        ref={imgRef}
        srcSet={srcSet}
        sizes={sizesAttr}
        src={`https://picsum.photos/id/${imageId}/${sizes.medium.width}/${sizes.medium.height}`}
        alt={alt}
        loading={loading}
        className={`responsive-image__img ${isLoaded ? 'loaded' : ''}`}
        onLoad={() => setIsLoaded(true)}
        onError={() => setError(true)}
        onClick={onClick}
      />
    </div>
  );
}
```

### Intersection Observer for Custom Lazy Loading

```typescript
// hooks/useLazyLoad.ts
import { useEffect, useRef, useState } from 'react';

interface UseLazyLoadOptions {
  threshold?: number;
  rootMargin?: string;
}

export function useLazyLoad<T extends HTMLElement>({
  threshold = 0.1,
  rootMargin = '100px',
}: UseLazyLoadOptions = {}) {
  const ref = useRef<T>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect(); // Stop observing once visible
        }
      },
      { threshold, rootMargin }
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, [threshold, rootMargin]);

  return { ref, isVisible };
}
```

### Image Preloading for Slideshow

```typescript
// hooks/useImagePreloader.ts
import { useEffect } from 'react';
import { useGalleryStore } from '../stores/galleryStore';

export function useImagePreloader() {
  const { images, slideshowIndex, activeTab } = useGalleryStore();

  useEffect(() => {
    if (activeTab !== 'Slideshow') return;

    // Preload adjacent images
    const preloadIndices = [
      (slideshowIndex + 1) % images.length,
      (slideshowIndex - 1 + images.length) % images.length,
    ];

    const preloadedImages: HTMLImageElement[] = [];

    preloadIndices.forEach((index) => {
      const img = new Image();
      img.src = `https://picsum.photos/id/${images[index].id}/1200/675`;
      preloadedImages.push(img);
    });

    // Cleanup (helps with memory if component unmounts)
    return () => {
      preloadedImages.forEach((img) => {
        img.src = '';
      });
    };
  }, [images, slideshowIndex, activeTab]);
}
```

---

## 7. Accessibility Implementation (3 min)

### Keyboard Navigation Map

| Key | Context | Action |
|-----|---------|--------|
| `←` / `→` | Slideshow | Previous/Next image |
| `Space` | Slideshow | Toggle play/pause |
| `←` / `→` | Lightbox | Navigate images |
| `Escape` | Lightbox | Close lightbox |
| `Enter` | Grid item | Open lightbox |
| `Tab` | Global | Navigate focusable elements |

### Focus Management Hook

```typescript
// hooks/useFocusTrap.ts
import { useEffect, useRef } from 'react';

export function useFocusTrap<T extends HTMLElement>(isActive: boolean) {
  const containerRef = useRef<T>(null);
  const previousActiveElement = useRef<Element | null>(null);

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    // Store currently focused element
    previousActiveElement.current = document.activeElement;

    // Find all focusable elements
    const focusableElements = containerRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    // Focus first element
    firstElement?.focus();

    // Trap focus within container
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus when modal closes
      (previousActiveElement.current as HTMLElement)?.focus();
    };
  }, [isActive]);

  return containerRef;
}
```

---

## 8. Performance Optimizations (3 min)

### Optimizations Applied

| Technique | Implementation | Benefit |
|-----------|----------------|---------|
| Lazy loading | Native `loading="lazy"` | Reduces initial payload |
| Responsive images | `srcSet` + `sizes` | Appropriate resolution |
| CSS-only layouts | Columns, Grid | No JS layout thrashing |
| Memoization | `React.memo` on grid items | Prevents re-renders |
| Preloading | Adjacent slideshow images | Instant navigation |
| Portal rendering | Lightbox in body | Avoids stacking context |

### Component Memoization

```typescript
// components/MasonryItem.tsx
import { memo } from 'react';

interface MasonryItemProps {
  imageId: number;
  alt: string;
  height: number;
  onClick: () => void;
}

export const MasonryItem = memo(function MasonryItem({
  imageId,
  alt,
  height,
  onClick,
}: MasonryItemProps) {
  return (
    <button className="masonry__item" onClick={onClick} style={{ height }}>
      <img
        src={`https://picsum.photos/id/${imageId}/400/${height}`}
        alt={alt}
        loading="lazy"
        className="masonry__image"
      />
    </button>
  );
});
```

---

## 9. Trade-offs and Decisions

| Decision | Pros | Cons |
|----------|------|------|
| CSS columns masonry | Simple, performant, native | Column-first ordering |
| Zustand over Context | Less boilerplate, subscriptions | Additional dependency |
| Portal for lightbox | No z-index issues | Separate DOM subtree |
| Native lazy loading | Zero JS, browser optimized | Less control over timing |
| Hardcoded image IDs | Predictable, no broken images | Static content |

---

## 10. Summary

### Key Frontend Decisions

1. **CSS-native layouts** for performance over JavaScript-based masonry
2. **Zustand store** for simple but powerful global state management
3. **Portal-based lightbox** for proper modal layering
4. **Keyboard-first navigation** throughout all views
5. **Lazy loading with preloading** for optimal image delivery

### Future Enhancements

- Virtualized grids for 1000+ images
- Touch gestures (swipe, pinch-to-zoom)
- Blurhash placeholders during loading
- Image metadata from API (author, description)
- Infinite scroll with intersection observer
- Animation transitions between layouts
