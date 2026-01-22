# MD Reader - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design MD Reader, a Progressive Web App for editing and previewing Markdown in the browser. The frontend challenge focuses on Monaco Editor integration, real-time preview rendering, component architecture, and offline-first PWA implementation.

## Requirements Clarification

### Functional Requirements
- **Rich Editor**: Monaco Editor with Markdown syntax highlighting
- **Live Preview**: Real-time rendering as the user types
- **View Modes**: Editor-only, preview-only, and split view
- **Document Management**: Create, switch, delete documents with auto-save
- **Theme Support**: Light and dark mode toggle

### Non-Functional Requirements
- **Responsiveness**: Preview updates within 150ms of typing pause
- **Performance**: Handle 10,000+ line documents smoothly
- **Accessibility**: Keyboard navigation, screen reader support
- **Offline**: Full functionality without network connection

### Scale Estimates
- **Document Size**: Average 10KB, maximum 500KB
- **Typing Rate**: 5-10 keystrokes/second during active editing
- **Concurrent Documents**: Up to 100 documents stored locally

## High-Level Architecture

```
+------------------------------------------------------------------+
|                        Application Shell                          |
+------------------------------------------------------------------+
|  Toolbar                                                          |
|  +-------------------------------------------------------------+  |
|  | [New] [Import] [Export] | [Theme] | [Editor|Split|Preview]  |  |
|  +-------------------------------------------------------------+  |
+------------------------------------------------------------------+
|  Document Selector                                                |
|  +-------------------------------------------------------------+  |
|  | [Dropdown] Document Title (auto-generated)      [Delete]    |  |
|  +-------------------------------------------------------------+  |
+------------------------------------------------------------------+
|  View Container                                                   |
|  +---------------------------+-------------------------------+    |
|  |       Monaco Editor       |       Preview Pane            |    |
|  |                           |                               |    |
|  |  - Syntax highlighting    |  - markdown-it rendered       |    |
|  |  - Line numbers           |  - DOMPurify sanitized        |    |
|  |  - Virtual scrolling      |  - Scroll synced              |    |
|  |                           |                               |    |
|  +---------------------------+-------------------------------+    |
+------------------------------------------------------------------+
```

## Deep Dives

### 1. Monaco Editor Integration

**Why Monaco?**

Monaco provides a professional editing experience identical to VS Code:

| Feature | Monaco | CodeMirror | Textarea |
|---------|--------|------------|----------|
| Syntax highlighting | Excellent | Good | None |
| Large file support | Virtual scroll | Virtual scroll | Limited |
| Bundle size | ~2MB | ~400KB | 0 |
| TypeScript integration | Native | Plugin | None |
| VS Code familiarity | Identical | Similar | N/A |

**Editor Component Architecture:**

```tsx
interface EditorProps {
  content: string;
  onChange: (content: string) => void;
  theme: 'vs' | 'vs-dark';
  viewMode: ViewMode;
}

const Editor: React.FC<EditorProps> = ({ content, onChange, theme, viewMode }) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initialize Monaco Editor
  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;

    editorRef.current = monaco.editor.create(containerRef.current, {
      value: content,
      language: 'markdown',
      theme,
      wordWrap: 'on',
      lineNumbers: 'on',
      minimap: { enabled: false },
      fontSize: 14,
      scrollBeyondLastLine: false,
      automaticLayout: true,
    });

    // Listen for content changes
    editorRef.current.onDidChangeModelContent(() => {
      const newContent = editorRef.current?.getValue() || '';
      onChange(newContent);
    });

    return () => editorRef.current?.dispose();
  }, []);

  // Update theme dynamically
  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [theme]);

  // Handle resize for split view changes
  useEffect(() => {
    const timer = setTimeout(() => {
      editorRef.current?.layout();
    }, 100);
    return () => clearTimeout(timer);
  }, [viewMode]);

  return <div ref={containerRef} className={styles.editor} />;
};
```

**Monaco Configuration for Markdown:**

```typescript
// Register custom Markdown language features
monaco.languages.registerCompletionItemProvider('markdown', {
  provideCompletionItems: (model, position) => {
    const suggestions: monaco.languages.CompletionItem[] = [
      {
        label: 'code block',
        kind: monaco.languages.CompletionItemKind.Snippet,
        insertText: '```${1:language}\n${2:code}\n```',
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        documentation: 'Insert a code block',
      },
      {
        label: 'link',
        kind: monaco.languages.CompletionItemKind.Snippet,
        insertText: '[${1:text}](${2:url})',
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        documentation: 'Insert a hyperlink',
      },
      // Additional snippets...
    ];
    return { suggestions };
  },
});
```

### 2. Real-time Preview Pipeline

**Rendering Flow:**

```
Keystroke → Monaco State → Debounce (150ms) → Parse → Sanitize → DOM Update
                              |
                              +-- Cancel timer on new keystroke
```

**Debounced Preview Hook:**

```typescript
function useMarkdownPreview(content: string) {
  const [preview, setPreview] = useState<string>('');
  const [isRendering, setIsRendering] = useState(false);

  // Configure markdown-it with plugins
  const md = useMemo(() => {
    return markdownIt({
      html: false,        // Disable raw HTML for security
      linkify: true,      // Auto-convert URLs to links
      typographer: true,  // Smart quotes, dashes
    })
      .use(markdownItAnchor)      // Header anchors
      .use(markdownItTaskLists)   // GitHub-style task lists
      .use(markdownItEmoji)       // Emoji shortcodes :smile:
      .use(markdownItHighlightjs); // Code syntax highlighting
  }, []);

  // Debounced rendering effect
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsRendering(true);

      // Parse markdown
      const rawHtml = md.render(content);

      // Sanitize to prevent XSS
      const safeHtml = DOMPurify.sanitize(rawHtml, {
        ALLOWED_TAGS: [
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'p', 'br', 'hr',
          'ul', 'ol', 'li',
          'blockquote', 'pre', 'code',
          'strong', 'em', 'del', 's',
          'a', 'img',
          'table', 'thead', 'tbody', 'tr', 'th', 'td',
          'input', // For task list checkboxes
          'span', 'div',
        ],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id', 'type', 'checked', 'disabled'],
        ALLOW_DATA_ATTR: false,
      });

      setPreview(safeHtml);
      setIsRendering(false);
    }, 150); // Debounce time

    return () => clearTimeout(timer);
  }, [content, md]);

  return { preview, isRendering };
}
```

**Preview Component:**

```tsx
interface PreviewProps {
  html: string;
  theme: 'light' | 'dark';
  onScroll?: (scrollRatio: number) => void;
}

const Preview: React.FC<PreviewProps> = ({ html, theme, onScroll }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Handle scroll for synchronization
  const handleScroll = useCallback(() => {
    if (!containerRef.current || !onScroll) return;

    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const maxScroll = scrollHeight - clientHeight;
    const ratio = maxScroll > 0 ? scrollTop / maxScroll : 0;
    onScroll(ratio);
  }, [onScroll]);

  return (
    <div
      ref={containerRef}
      className={cn(styles.preview, theme === 'dark' && styles.dark)}
      onScroll={handleScroll}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
```

### 3. View Mode Management

**View Mode State:**

```typescript
type ViewMode = 'editor' | 'preview' | 'split';

interface ViewModeState {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  editorWidth: number;  // Percentage in split mode
  setEditorWidth: (width: number) => void;
}

const useViewModeStore = create<ViewModeState>((set) => ({
  mode: 'split',
  setMode: (mode) => set({ mode }),
  editorWidth: 50,
  setEditorWidth: (editorWidth) => set({ editorWidth }),
}));
```

**Resizable Split View:**

```tsx
const SplitView: React.FC<{ children: [React.ReactNode, React.ReactNode] }> = ({
  children,
}) => {
  const { editorWidth, setEditorWidth } = useViewModeStore();
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(() => {
    setIsDragging(true);
    document.body.style.cursor = 'col-resize';
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = ((e.clientX - rect.left) / rect.width) * 100;

      // Constrain between 20% and 80%
      setEditorWidth(Math.max(20, Math.min(80, newWidth)));
    },
    [isDragging, setEditorWidth]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    document.body.style.cursor = '';
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  return (
    <div ref={containerRef} className={styles.splitView}>
      <div style={{ width: `${editorWidth}%` }}>{children[0]}</div>
      <div className={styles.divider} onMouseDown={handleMouseDown} />
      <div style={{ width: `${100 - editorWidth}%` }}>{children[1]}</div>
    </div>
  );
};
```

### 4. Scroll Synchronization

**Proportional Scroll Sync:**

```typescript
function useScrollSync(editorRef: RefObject<monaco.editor.IStandaloneCodeEditor>, previewRef: RefObject<HTMLDivElement>) {
  const [syncEnabled, setSyncEnabled] = useState(true);
  const syncSourceRef = useRef<'editor' | 'preview' | null>(null);

  // Sync from editor to preview
  useEffect(() => {
    if (!syncEnabled || !editorRef.current) return;

    const editor = editorRef.current;
    const disposable = editor.onDidScrollChange((e) => {
      if (syncSourceRef.current === 'preview') return;
      if (!previewRef.current) return;

      syncSourceRef.current = 'editor';

      // Calculate scroll ratio
      const editorMaxScroll = editor.getScrollHeight() - editor.getLayoutInfo().height;
      const ratio = editorMaxScroll > 0 ? e.scrollTop / editorMaxScroll : 0;

      // Apply to preview
      const previewEl = previewRef.current;
      const previewMaxScroll = previewEl.scrollHeight - previewEl.clientHeight;
      previewEl.scrollTop = ratio * previewMaxScroll;

      // Reset sync source after animation frame
      requestAnimationFrame(() => {
        syncSourceRef.current = null;
      });
    });

    return () => disposable.dispose();
  }, [syncEnabled, editorRef, previewRef]);

  // Sync from preview to editor
  useEffect(() => {
    if (!syncEnabled || !previewRef.current) return;

    const previewEl = previewRef.current;
    const handleScroll = () => {
      if (syncSourceRef.current === 'editor') return;
      if (!editorRef.current) return;

      syncSourceRef.current = 'preview';

      const previewMaxScroll = previewEl.scrollHeight - previewEl.clientHeight;
      const ratio = previewMaxScroll > 0 ? previewEl.scrollTop / previewMaxScroll : 0;

      const editor = editorRef.current;
      const editorMaxScroll = editor.getScrollHeight() - editor.getLayoutInfo().height;
      editor.setScrollTop(ratio * editorMaxScroll);

      requestAnimationFrame(() => {
        syncSourceRef.current = null;
      });
    };

    previewEl.addEventListener('scroll', handleScroll);
    return () => previewEl.removeEventListener('scroll', handleScroll);
  }, [syncEnabled, editorRef, previewRef]);

  return { syncEnabled, setSyncEnabled };
}
```

### 5. Document Management UI

**Document Selector Component:**

```tsx
interface DocumentSelectorProps {
  documents: DocumentMeta[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

const DocumentSelector: React.FC<DocumentSelectorProps> = ({
  documents,
  currentId,
  onSelect,
  onCreate,
  onDelete,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Filter documents by search
  const filteredDocs = useMemo(() => {
    if (!searchQuery) return documents;
    const query = searchQuery.toLowerCase();
    return documents.filter((doc) =>
      doc.title.toLowerCase().includes(query)
    );
  }, [documents, searchQuery]);

  // Close on outside click
  useClickOutside(dropdownRef, () => setIsOpen(false));

  const currentDoc = documents.find((d) => d.id === currentId);

  return (
    <div className={styles.selector} ref={dropdownRef}>
      <button
        className={styles.trigger}
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <span className={styles.title}>
          {currentDoc?.title || 'Untitled Document'}
        </span>
        <ChevronDownIcon className={styles.chevron} />
      </button>

      {isOpen && (
        <div className={styles.dropdown} role="listbox">
          <input
            type="search"
            placeholder="Search documents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={styles.search}
            autoFocus
          />

          <button className={styles.newDoc} onClick={onCreate}>
            <PlusIcon /> New Document
          </button>

          <div className={styles.list}>
            {filteredDocs.map((doc) => (
              <div
                key={doc.id}
                className={cn(styles.item, doc.id === currentId && styles.active)}
                role="option"
                aria-selected={doc.id === currentId}
                onClick={() => {
                  onSelect(doc.id);
                  setIsOpen(false);
                }}
              >
                <span className={styles.docTitle}>{doc.title}</span>
                <span className={styles.docDate}>
                  {formatRelativeTime(doc.updatedAt)}
                </span>
                <button
                  className={styles.delete}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(doc.id);
                  }}
                  aria-label={`Delete ${doc.title}`}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
```

### 6. Theme System

**Theme Provider:**

```tsx
type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: 'light' | 'dark';
  userPreference: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [userPreference, setUserPreference] = useState<Theme>('system');

  // Detect system preference
  const systemTheme = useMediaQuery('(prefers-color-scheme: dark)') ? 'dark' : 'light';

  // Resolve actual theme
  const theme = userPreference === 'system' ? systemTheme : userPreference;

  // Persist preference
  useEffect(() => {
    localStorage.setItem('mdreader-theme', userPreference);
  }, [userPreference]);

  // Initialize from storage
  useEffect(() => {
    const saved = localStorage.getItem('mdreader-theme') as Theme | null;
    if (saved) setUserPreference(saved);
  }, []);

  // Apply theme class to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <ThemeContext.Provider
      value={{ theme, userPreference, setTheme: setUserPreference }}
    >
      {children}
    </ThemeContext.Provider>
  );
};
```

**CSS Variables for Theming:**

```css
:root {
  /* Light theme (default) */
  --color-bg-primary: #ffffff;
  --color-bg-secondary: #f5f5f5;
  --color-text-primary: #1a1a1a;
  --color-text-secondary: #666666;
  --color-border: #e0e0e0;
  --color-accent: #0066cc;
  --color-code-bg: #f4f4f4;
}

[data-theme='dark'] {
  --color-bg-primary: #1e1e1e;
  --color-bg-secondary: #252526;
  --color-text-primary: #d4d4d4;
  --color-text-secondary: #9d9d9d;
  --color-border: #3c3c3c;
  --color-accent: #4fc3f7;
  --color-code-bg: #2d2d2d;
}

/* Preview styling adapts automatically */
.preview {
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
}

.preview code {
  background: var(--color-code-bg);
}

.preview a {
  color: var(--color-accent);
}
```

### 7. Accessibility Implementation

**Keyboard Navigation:**

```tsx
const useKeyboardShortcuts = () => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + S: Save (already auto-saves, show confirmation)
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        showSaveConfirmation();
      }

      // Cmd/Ctrl + N: New document
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        createNewDocument();
      }

      // Cmd/Ctrl + P: Toggle preview mode
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        toggleViewMode();
      }

      // Cmd/Ctrl + \: Toggle split view
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setViewMode('split');
      }

      // Cmd/Ctrl + D: Toggle dark mode
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault();
        toggleTheme();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
};
```

**ARIA Labels and Roles:**

```tsx
const Toolbar: React.FC = () => {
  const { theme, setTheme } = useTheme();
  const { mode, setMode } = useViewModeStore();

  return (
    <nav
      className={styles.toolbar}
      role="toolbar"
      aria-label="Document actions"
    >
      <div className={styles.group} role="group" aria-label="File operations">
        <button aria-label="Create new document" onClick={handleNew}>
          <PlusIcon aria-hidden="true" />
          <span>New</span>
        </button>
        <button aria-label="Import markdown file" onClick={handleImport}>
          <UploadIcon aria-hidden="true" />
          <span>Import</span>
        </button>
        <button aria-label="Export as markdown" onClick={handleExport}>
          <DownloadIcon aria-hidden="true" />
          <span>Export</span>
        </button>
      </div>

      <div className={styles.group} role="group" aria-label="View options">
        <button
          aria-label="Toggle theme"
          aria-pressed={theme === 'dark'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>

        <div role="radiogroup" aria-label="View mode">
          {(['editor', 'split', 'preview'] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
            >
              {m === 'editor' && <EditIcon />}
              {m === 'split' && <SplitIcon />}
              {m === 'preview' && <EyeIcon />}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
};
```

### 8. PWA Installation

**Install Prompt Handling:**

```tsx
const useInstallPrompt = () => {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    // Check if already installed
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setIsInstalled(true);
      return;
    }

    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setInstallPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return false;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    return outcome === 'accepted';
  };

  return { canInstall: !!installPrompt, isInstalled, install };
};
```

**Install Banner Component:**

```tsx
const InstallBanner: React.FC = () => {
  const { canInstall, install } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(false);

  if (!canInstall || dismissed) return null;

  return (
    <div className={styles.installBanner} role="banner">
      <p>Install MD Reader for offline access and a native app experience.</p>
      <div className={styles.actions}>
        <button onClick={() => setDismissed(true)}>Not now</button>
        <button onClick={install} className={styles.primary}>
          Install App
        </button>
      </div>
    </div>
  );
};
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Editor | Monaco Editor | CodeMirror 6 | VS Code familiarity, better TypeScript, richer features |
| Markdown Parser | markdown-it | remark/unified | Faster, smaller bundle, rich plugin ecosystem |
| Sanitizer | DOMPurify | sanitize-html | Industry standard, well-maintained, configurable |
| State Management | Zustand | Redux/Context | Lightweight, simple API, built-in persistence |
| View Layout | CSS Grid + Flexbox | CSS-in-JS | Native performance, no runtime overhead |
| Theme Approach | CSS Variables | Styled-components | Better performance, no CSS-in-JS bundle |

## Future Enhancements

1. **Collaborative Editing**: WebRTC with Yjs for real-time multi-user editing
2. **Multi-Tab Documents**: Tab bar for switching between multiple open documents
3. **Export Options**: PDF and HTML export with custom styling
4. **Custom Themes**: User-defined color schemes beyond light/dark
5. **Vim/Emacs Keybindings**: Modal editing support for power users
6. **Markdown Linting**: Real-time warnings for common Markdown issues
7. **Table of Contents**: Auto-generated sidebar navigation from headers
8. **Image Paste**: Paste images from clipboard with Base64 or blob storage
