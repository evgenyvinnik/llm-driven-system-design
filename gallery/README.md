# Gallery

A frontend-only image gallery showcasing three different display modes: Slideshow, Masonry, and Tiles. Uses [picsum.photos](https://picsum.photos) for placeholder images.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 2,266 |
| Source Files | 28 |
| .md | 1,625 |
| .tsx | 397 |
| .ts | 125 |
| .json | 89 |
| .js | 14 |


## Features

- **Slideshow View**: Full-screen carousel with navigation arrows, thumbnail strip, and auto-play
- **Masonry View**: Pinterest-style variable-height grid layout
- **Tiles View**: Uniform square grid with hover effects
- **Lightbox**: Full-screen image viewer with keyboard navigation
- **Lazy Loading**: Images load on-demand for better performance
- **Keyboard Navigation**: Arrow keys for slideshow and lightbox, Escape to close

## Quick Start

```bash
cd gallery/frontend
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

## Technology Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Routing**: TanStack Router (file-based)
- **State**: Zustand
- **Styling**: Tailwind CSS
- **Images**: picsum.photos (placeholder service)

## Project Structure

```
gallery/
├── frontend/
│   ├── src/
│   │   ├── routes/
│   │   │   ├── __root.tsx      # Root layout with header
│   │   │   └── index.tsx       # Main gallery page with tabs
│   │   ├── components/
│   │   │   ├── gallery/
│   │   │   │   ├── GalleryTabs.tsx   # Tab navigation
│   │   │   │   ├── Slideshow.tsx     # Carousel view
│   │   │   │   ├── MasonryGrid.tsx   # Variable-height grid
│   │   │   │   ├── TilesGrid.tsx     # Uniform grid
│   │   │   │   └── Lightbox.tsx      # Full-screen viewer
│   │   │   └── icons/
│   │   │       └── index.tsx         # Icon components
│   │   ├── stores/
│   │   │   └── galleryStore.ts       # Global state
│   │   └── utils/
│   │       └── picsum.ts             # Image URL helpers
│   └── package.json
├── README.md
├── architecture.md
└── CLAUDE.md
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` / `→` | Navigate images (Slideshow & Lightbox) |
| `Space` | Play/Pause slideshow |
| `Escape` | Close lightbox |

## Image Source

All images are loaded from [picsum.photos](https://picsum.photos), a free placeholder image service. The gallery uses 50 pre-selected image IDs (10-59) for consistent display across sessions.

## Development

### Available Scripts

```bash
npm run dev        # Start development server
npm run build      # Build for production
npm run preview    # Preview production build
npm run lint       # Run ESLint
npm run type-check # TypeScript type checking
```

### Adding More Images

Edit `src/utils/picsum.ts` to modify the image list:

```typescript
// Default: 50 images starting from ID 10
export const imageIds = Array.from({ length: 50 }, (_, i) => i + 10)

// Custom list
export const imageIds = [10, 20, 30, 40, 50]
```

## Screenshots

| Slideshow | Masonry | Tiles |
|-----------|---------|-------|
| ![Slideshow](screenshots/slideshow.png) | ![Masonry](screenshots/masonry.png) | ![Tiles](screenshots/tiles.png) |
