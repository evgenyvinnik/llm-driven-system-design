# Spotlight - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design Spotlight, Apple's universal search system that provides instant results across files, apps, contacts, messages, and the web. From a frontend perspective, the core challenge is building a search interface that feels instantaneous - showing results as the user types with sub-100ms feedback, handling diverse result types with appropriate previews, and implementing keyboard-first navigation that power users expect.

The frontend architecture centers on three pillars: a performant search bar component with debounced input and optimistic result rendering, a flexible result list that handles heterogeneous content types (files, apps, contacts, calculations), and a preview pane that shows rich content without blocking the search experience. The UI must feel native and responsive, prioritizing keyboard navigation over mouse interactions."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Search Bar**: Instant typeahead with prefix matching
- **Results Display**: Categorized list with icons, metadata, and keyboard selection
- **Previews**: Quick Look for files, contact cards, calculation results
- **Actions**: Launch apps, open files, copy results, web search fallback
- **Suggestions**: Proactive Siri Suggestions when search is empty

### Non-Functional Requirements
- **Perceived Latency**: < 100ms from keystroke to first results
- **Keyboard Navigation**: Full control without mouse
- **Accessibility**: Screen reader support, high contrast, reduced motion
- **Performance**: Smooth 60fps scrolling through results

### User Interactions
- **Activation**: Cmd+Space opens Spotlight
- **Typing**: Results appear instantly as user types
- **Navigation**: Arrow keys move selection, Enter activates
- **Preview**: Spacebar shows Quick Look preview
- **Dismiss**: Escape closes Spotlight

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Spotlight Window                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Search Bar                              │  │
│  │  [🔍 Search icon] [Input field with placeholder]           │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Results List                            │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │ [Icon] Result Name          [Type Badge] [Shortcut] │  │  │
│  │  │        Secondary text / path                         │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │ [Icon] Result Name          [Type Badge] [Shortcut] │  │  │
│  │  │        Secondary text / path                         │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Preview Pane                            │  │
│  │            (Quick Look preview of selected item)           │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Component Architecture

```
SpotlightApp
├── SpotlightProvider (state management)
│   ├── SearchStore (Zustand)
│   └── KeyboardHandler
├── SpotlightWindow
│   ├── SearchBar
│   │   ├── SearchIcon
│   │   ├── SearchInput
│   │   └── ClearButton
│   ├── ResultsList
│   │   ├── CategoryHeader
│   │   ├── ResultItem
│   │   │   ├── IconRenderer
│   │   │   ├── ResultContent
│   │   │   └── ActionBadge
│   │   └── WebSearchFallback
│   └── PreviewPane
│       ├── FilePreview
│       ├── ContactCard
│       ├── CalculationResult
│       └── WebPreview
└── SiriSuggestions
    ├── SuggestionGrid
    └── SuggestionCard
```

## Deep Dive: Search Bar Component (7 minutes)

### Optimized Input Handling

The search bar must feel instantaneous while avoiding excessive API calls.

```typescript
// SearchBar.tsx
import { useCallback, useRef, useEffect } from 'react';
import { useSearchStore } from '../stores/searchStore';

export function SearchBar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { query, setQuery, search, clearResults } = useSearchStore();

  // Debounce for API calls but update UI immediately
  const debouncedSearch = useRef(
    debounce((q: string) => search(q), 50)
  ).current;

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;

    // Update query immediately for responsive UI
    setQuery(value);

    if (value.length === 0) {
      clearResults();
      return;
    }

    // Debounce actual search
    debouncedSearch(value);
  }, [setQuery, debouncedSearch, clearResults]);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Global keyboard shortcut (Cmd+Space)
  useEffect(() => {
    const handleGlobalKeydown = (e: KeyboardEvent) => {
      if (e.metaKey && e.code === 'Space') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleGlobalKeydown);
    return () => window.removeEventListener('keydown', handleGlobalKeydown);
  }, []);

  return (
    <div className="search-bar">
      <SearchIcon className="search-icon" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleChange}
        placeholder="Spotlight Search"
        className="search-input"
        aria-label="Search"
        aria-autocomplete="list"
        aria-controls="results-list"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {query.length > 0 && (
        <button
          onClick={() => { setQuery(''); clearResults(); }}
          className="clear-button"
          aria-label="Clear search"
        >
          <ClearIcon />
        </button>
      )}
    </div>
  );
}
```

### Search Bar Styling

```css
.search-bar {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 10px 10px 0 0;
}

.search-icon {
  width: 20px;
  height: 20px;
  color: #888;
  margin-right: 12px;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 22px;
  font-weight: 300;
  color: #333;
  outline: none;
}

.search-input::placeholder {
  color: #999;
}

.clear-button {
  padding: 4px;
  border: none;
  background: rgba(0, 0, 0, 0.1);
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Reduced motion preference */
@media (prefers-reduced-motion: reduce) {
  .search-bar,
  .search-input {
    transition: none;
  }
}
```

## Deep Dive: Zustand State Management (7 minutes)

### Search Store

```typescript
// stores/searchStore.ts
import { create } from 'zustand';

interface SearchResult {
  id: string;
  type: 'application' | 'file' | 'contact' | 'message' | 'calculation' | 'web_search';
  name: string;
  subtitle?: string;
  icon?: string;
  path?: string;
  action?: ResultAction;
  score: number;
}

interface ResultAction {
  type: 'open' | 'launch' | 'copy' | 'web_search';
  payload: string;
}

interface SearchState {
  // Query state
  query: string;
  setQuery: (query: string) => void;

  // Results state
  results: SearchResult[];
  isLoading: boolean;
  error: string | null;

  // Selection state
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;

  // Preview state
  showPreview: boolean;
  togglePreview: () => void;

  // Actions
  search: (query: string) => Promise<void>;
  clearResults: () => void;
  executeSelected: () => void;

  // Navigation
  moveSelection: (direction: 'up' | 'down') => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  // Initial state
  query: '',
  results: [],
  isLoading: false,
  error: null,
  selectedIndex: 0,
  showPreview: false,

  setQuery: (query) => set({ query }),

  search: async (query) => {
    if (query.length === 0) {
      set({ results: [], selectedIndex: 0 });
      return;
    }

    set({ isLoading: true, error: null });

    try {
      // Query the backend API
      const response = await fetch(`/api/v1/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error('Search failed');

      const results = await response.json();

      set({
        results,
        isLoading: false,
        selectedIndex: 0 // Reset selection on new results
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Search failed',
        isLoading: false
      });
    }
  },

  clearResults: () => set({
    query: '',
    results: [],
    selectedIndex: 0,
    showPreview: false
  }),

  setSelectedIndex: (index) => set({ selectedIndex: index }),

  togglePreview: () => set((state) => ({ showPreview: !state.showPreview })),

  moveSelection: (direction) => {
    const { results, selectedIndex } = get();
    if (results.length === 0) return;

    let newIndex: number;
    if (direction === 'up') {
      newIndex = selectedIndex <= 0 ? results.length - 1 : selectedIndex - 1;
    } else {
      newIndex = selectedIndex >= results.length - 1 ? 0 : selectedIndex + 1;
    }

    set({ selectedIndex: newIndex });
  },

  executeSelected: () => {
    const { results, selectedIndex } = get();
    const selected = results[selectedIndex];
    if (!selected) return;

    executeAction(selected.action);
  }
}));

function executeAction(action?: ResultAction) {
  if (!action) return;

  switch (action.type) {
    case 'launch':
      window.electronAPI?.launchApp(action.payload);
      break;
    case 'open':
      window.electronAPI?.openFile(action.payload);
      break;
    case 'copy':
      navigator.clipboard.writeText(action.payload);
      break;
    case 'web_search':
      window.open(action.payload, '_blank');
      break;
  }
}
```

## Deep Dive: Results List with Keyboard Navigation (7 minutes)

### Results List Component

```typescript
// ResultsList.tsx
import { useEffect, useRef } from 'react';
import { useSearchStore } from '../stores/searchStore';

export function ResultsList() {
  const listRef = useRef<HTMLDivElement>(null);
  const {
    results,
    isLoading,
    selectedIndex,
    setSelectedIndex,
    moveSelection,
    executeSelected,
    togglePreview
  } = useSearchStore();

  // Keyboard navigation
  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveSelection('down');
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveSelection('up');
          break;
        case 'Enter':
          e.preventDefault();
          executeSelected();
          break;
        case ' ': // Spacebar for preview
          if (!e.metaKey) {
            e.preventDefault();
            togglePreview();
          }
          break;
        case 'Escape':
          e.preventDefault();
          window.electronAPI?.hideSpotlight();
          break;
      }
    };

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [moveSelection, executeSelected, togglePreview]);

  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = listRef.current?.querySelector(
      `[data-index="${selectedIndex}"]`
    );
    selectedElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (results.length === 0) {
    return null;
  }

  // Group results by type
  const groupedResults = groupByType(results);

  return (
    <div
      ref={listRef}
      className="results-list"
      role="listbox"
      id="results-list"
      aria-label="Search results"
    >
      {Object.entries(groupedResults).map(([type, items]) => (
        <div key={type} className="result-group">
          <CategoryHeader type={type} />
          {items.map((result, i) => {
            const globalIndex = getGlobalIndex(groupedResults, type, i);
            return (
              <ResultItem
                key={result.id}
                result={result}
                isSelected={globalIndex === selectedIndex}
                index={globalIndex}
                onSelect={() => setSelectedIndex(globalIndex)}
                onActivate={executeSelected}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
```

### Result Item Component

```typescript
// ResultItem.tsx
interface ResultItemProps {
  result: SearchResult;
  isSelected: boolean;
  index: number;
  onSelect: () => void;
  onActivate: () => void;
}

export function ResultItem({
  result,
  isSelected,
  index,
  onSelect,
  onActivate
}: ResultItemProps) {
  return (
    <div
      data-index={index}
      role="option"
      aria-selected={isSelected}
      className={`result-item ${isSelected ? 'selected' : ''}`}
      onClick={onActivate}
      onMouseEnter={onSelect}
    >
      <IconRenderer type={result.type} icon={result.icon} />

      <div className="result-content">
        <span className="result-name">{result.name}</span>
        {result.subtitle && (
          <span className="result-subtitle">{result.subtitle}</span>
        )}
      </div>

      <div className="result-meta">
        <TypeBadge type={result.type} />
        {isSelected && <KeyboardHint keys={['↵']} />}
      </div>
    </div>
  );
}

function IconRenderer({ type, icon }: { type: string; icon?: string }) {
  if (icon) {
    return <img src={icon} alt="" className="result-icon" />;
  }

  // Default icons by type
  const defaultIcons: Record<string, React.ReactNode> = {
    application: <AppIcon />,
    file: <FileIcon />,
    contact: <ContactIcon />,
    message: <MessageIcon />,
    calculation: <CalculatorIcon />,
    web_search: <GlobeIcon />
  };

  return <span className="result-icon">{defaultIcons[type]}</span>;
}
```

### Results List Styling

```css
.results-list {
  max-height: 400px;
  overflow-y: auto;
  padding: 8px 0;
  scrollbar-width: thin;
}

.result-group {
  margin-bottom: 8px;
}

.category-header {
  padding: 4px 16px;
  font-size: 11px;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.result-item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  cursor: pointer;
  transition: background-color 0.1s;
}

.result-item:hover,
.result-item.selected {
  background-color: rgba(0, 122, 255, 0.1);
}

.result-item.selected {
  background-color: #007AFF;
  color: white;
}

.result-item.selected .result-subtitle,
.result-item.selected .type-badge {
  color: rgba(255, 255, 255, 0.8);
}

.result-icon {
  width: 32px;
  height: 32px;
  margin-right: 12px;
  flex-shrink: 0;
  border-radius: 6px;
}

.result-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.result-name {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-subtitle {
  font-size: 12px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 12px;
}

.type-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.05);
  color: #888;
}
```

## Deep Dive: Special Results Display (5 minutes)

### Calculation Results

```typescript
// CalculationResult.tsx
export function CalculationResult({ expression, result }: {
  expression: string;
  result: string;
}) {
  const handleCopy = () => {
    navigator.clipboard.writeText(result);
    showToast('Copied to clipboard');
  };

  return (
    <div className="calculation-result">
      <div className="calculation-display">
        <span className="expression">{expression}</span>
        <span className="equals">=</span>
        <span className="result">{result}</span>
      </div>
      <button
        onClick={handleCopy}
        className="copy-button"
        aria-label="Copy result"
      >
        <CopyIcon />
      </button>
    </div>
  );
}
```

### Unit Conversion Display

```typescript
// ConversionResult.tsx
export function ConversionResult({ conversion }: {
  conversion: {
    value: number;
    fromUnit: string;
    toUnit: string;
    result: number;
  };
}) {
  return (
    <div className="conversion-result">
      <div className="conversion-from">
        <span className="value">{conversion.value}</span>
        <span className="unit">{conversion.fromUnit}</span>
      </div>
      <ArrowRightIcon className="conversion-arrow" />
      <div className="conversion-to">
        <span className="value">{conversion.result}</span>
        <span className="unit">{conversion.toUnit}</span>
      </div>
    </div>
  );
}
```

### Styling for Special Results

```css
.calculation-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 8px;
  margin: 8px 16px;
  color: white;
}

.calculation-display {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.calculation-display .expression {
  font-size: 18px;
  opacity: 0.8;
}

.calculation-display .equals {
  font-size: 20px;
  opacity: 0.6;
}

.calculation-display .result {
  font-size: 28px;
  font-weight: 600;
}

.conversion-result {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 16px;
  background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
  border-radius: 8px;
  margin: 8px 16px;
  color: white;
}

.conversion-from,
.conversion-to {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.conversion-from .value,
.conversion-to .value {
  font-size: 24px;
  font-weight: 600;
}

.conversion-from .unit,
.conversion-to .unit {
  font-size: 12px;
  opacity: 0.8;
  text-transform: uppercase;
}
```

## Deep Dive: Preview Pane (5 minutes)

### Quick Look Preview

```typescript
// PreviewPane.tsx
import { useSearchStore } from '../stores/searchStore';

export function PreviewPane() {
  const { results, selectedIndex, showPreview } = useSearchStore();
  const selected = results[selectedIndex];

  if (!showPreview || !selected) {
    return null;
  }

  return (
    <div className="preview-pane" role="complementary" aria-label="Preview">
      <PreviewContent result={selected} />
    </div>
  );
}

function PreviewContent({ result }: { result: SearchResult }) {
  switch (result.type) {
    case 'file':
      return <FilePreview path={result.path!} />;
    case 'contact':
      return <ContactPreview contact={result} />;
    case 'application':
      return <AppPreview app={result} />;
    default:
      return <GenericPreview result={result} />;
  }
}

function FilePreview({ path }: { path: string }) {
  const extension = path.split('.').pop()?.toLowerCase();
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension || '');
  const isPDF = extension === 'pdf';
  const isText = ['txt', 'md', 'json', 'js', 'ts', 'css'].includes(extension || '');

  if (isImage) {
    return (
      <div className="preview-image">
        <img src={`file://${path}`} alt="" />
      </div>
    );
  }

  if (isPDF) {
    return (
      <div className="preview-pdf">
        <PDFViewer path={path} />
      </div>
    );
  }

  if (isText) {
    return <TextPreview path={path} />;
  }

  return (
    <div className="preview-generic">
      <FileIcon className="preview-icon" />
      <span className="preview-filename">{path.split('/').pop()}</span>
      <span className="preview-path">{path}</span>
    </div>
  );
}
```

### Preview Pane Styling

```css
.preview-pane {
  border-top: 1px solid rgba(0, 0, 0, 0.1);
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  padding: 16px;
  max-height: 300px;
  overflow: auto;
}

.preview-image {
  display: flex;
  justify-content: center;
  align-items: center;
}

.preview-image img {
  max-width: 100%;
  max-height: 250px;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.preview-generic {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 24px;
}

.preview-icon {
  width: 64px;
  height: 64px;
  margin-bottom: 16px;
}

.preview-filename {
  font-size: 16px;
  font-weight: 500;
  margin-bottom: 4px;
}

.preview-path {
  font-size: 12px;
  color: #666;
  word-break: break-all;
}
```

## Deep Dive: Siri Suggestions (4 minutes)

### Suggestions Grid

```typescript
// SiriSuggestions.tsx
import { useEffect, useState } from 'react';

interface Suggestion {
  id: string;
  type: 'app' | 'contact' | 'continue';
  name: string;
  icon: string;
  reason: string;
}

export function SiriSuggestions() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const { query } = useSearchStore();

  useEffect(() => {
    if (query.length === 0) {
      fetchSuggestions();
    }
  }, [query]);

  async function fetchSuggestions() {
    const response = await fetch('/api/v1/suggestions');
    const data = await response.json();
    setSuggestions(data);
  }

  if (query.length > 0) {
    return null; // Hide suggestions when searching
  }

  return (
    <div className="siri-suggestions">
      <h3 className="suggestions-title">Siri Suggestions</h3>
      <div className="suggestions-grid">
        {suggestions.map((suggestion) => (
          <SuggestionCard key={suggestion.id} suggestion={suggestion} />
        ))}
      </div>
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const handleClick = () => {
    if (suggestion.type === 'app') {
      window.electronAPI?.launchApp(suggestion.id);
    }
  };

  return (
    <button className="suggestion-card" onClick={handleClick}>
      <img src={suggestion.icon} alt="" className="suggestion-icon" />
      <span className="suggestion-name">{suggestion.name}</span>
    </button>
  );
}
```

### Suggestions Styling

```css
.siri-suggestions {
  padding: 16px;
}

.suggestions-title {
  font-size: 11px;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.suggestions-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.suggestion-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px;
  border: none;
  background: rgba(0, 0, 0, 0.03);
  border-radius: 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.suggestion-card:hover {
  background: rgba(0, 0, 0, 0.06);
}

.suggestion-card:focus {
  outline: 2px solid #007AFF;
  outline-offset: 2px;
}

.suggestion-icon {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  margin-bottom: 8px;
}

.suggestion-name {
  font-size: 12px;
  color: #333;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
```

## Accessibility (3 minutes)

### ARIA Implementation

```typescript
// Accessibility enhancements
<div
  role="combobox"
  aria-expanded={results.length > 0}
  aria-haspopup="listbox"
  aria-owns="results-list"
>
  <input
    aria-autocomplete="list"
    aria-controls="results-list"
    aria-activedescendant={`result-${selectedIndex}`}
  />
</div>

<div
  id="results-list"
  role="listbox"
  aria-label="Search results"
>
  {results.map((result, index) => (
    <div
      id={`result-${index}`}
      role="option"
      aria-selected={index === selectedIndex}
    >
      {result.name}
    </div>
  ))}
</div>
```

### Keyboard Shortcuts Summary

| Key | Action |
|-----|--------|
| Cmd+Space | Open/focus Spotlight |
| Arrow Up/Down | Navigate results |
| Enter | Execute selected result |
| Space | Toggle preview |
| Escape | Close Spotlight |
| Cmd+C | Copy result |

### Screen Reader Announcements

```typescript
// Announce result count changes
useEffect(() => {
  const announcement = results.length === 0
    ? 'No results found'
    : `${results.length} results found`;

  announceToScreenReader(announcement);
}, [results.length]);

function announceToScreenReader(message: string) {
  const announcement = document.createElement('div');
  announcement.setAttribute('aria-live', 'polite');
  announcement.setAttribute('aria-atomic', 'true');
  announcement.className = 'sr-only';
  announcement.textContent = message;
  document.body.appendChild(announcement);

  setTimeout(() => announcement.remove(), 1000);
}
```

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux | Simpler API, less boilerplate for focused scope |
| Input Debounce | 50ms | 150ms | Prioritize perceived speed over API reduction |
| Navigation | Keyboard-first | Mouse-first | Power user target audience |
| Preview | On-demand (Spacebar) | Always visible | Faster initial render, user control |
| Result Grouping | By type | Flat list | Better organization for diverse results |

## Future Enhancements (Frontend)

1. **Voice Input**: "Hey Siri, search for..." with Web Speech API
2. **Result Previews on Hover**: Show mini previews without pressing Spacebar
3. **Custom Themes**: Dark mode, accent color customization
4. **Drag and Drop**: Drag files from results to Finder or other apps
5. **History Navigation**: Arrow left/right to navigate search history

## Closing Summary

"Spotlight's frontend architecture is built around three principles:

1. **Instant feedback**: Debounced search with optimistic UI updates, showing results within 50ms of keystroke. The Zustand store manages query, results, and selection state for predictable updates.

2. **Keyboard-first navigation**: Full arrow key navigation with selection state tracking, automatic scroll-into-view for selected items, and Spacebar preview toggle for power users.

3. **Flexible result rendering**: Component composition handles diverse result types (files, apps, calculations, contacts) with type-specific icons, previews, and actions, all styled with a native macOS aesthetic.

The main trade-off is complexity vs. flexibility. By supporting multiple result types with specialized renderers, we add component complexity but deliver a significantly better user experience for each content type."
