# System Design Interview: GitHub - Code Hosting Platform (Frontend Focus)

## Role Focus

> This answer emphasizes **frontend architecture**: repository file browser, code viewer with syntax highlighting, pull request diff visualization, inline review comments, search results with highlighting, and real-time notifications.

---

## Opening Statement

"Today I'll design the frontend for a code hosting platform like GitHub. The core UI challenges are building a performant file browser for large repositories, rendering code with syntax highlighting, displaying pull request diffs with inline commenting, and implementing real-time notifications for collaborative workflows."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Repository Browser**: Navigate file trees, view file contents with syntax highlighting
2. **Pull Request UI**: Display diffs, inline comments, review submission
3. **Code Search**: Search results with highlighted matches
4. **Notifications**: Real-time updates for mentions, reviews, CI status
5. **Responsive Design**: Desktop-first with mobile support

### Non-Functional Requirements

- **Performance**: File tree renders < 100ms, diffs virtualized for large PRs
- **Accessibility**: Full keyboard navigation, screen reader support
- **SEO**: Server-rendered for public repositories (optional)
- **Offline**: Basic caching for recently viewed files

### Scale Assumptions

- Single repository may have 100,000+ files
- PR diffs can span 1000+ files with 10,000+ line changes
- Users expect instant navigation between files

---

## Step 2: Component Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Root Layout                                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Header / Navigation                       │   │
│  │  [Logo] [Search Bar] [Notifications] [User Menu]            │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Repository Header                         │   │
│  │  owner/repo-name  [Watch] [Fork] [Star]                     │   │
│  │  [Code] [Issues] [Pull Requests] [Actions] [Settings]       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────┬──────────────────────────────────────────────┐   │
│  │  File Tree   │              Main Content                     │   │
│  │              │  (FileViewer / DiffViewer / IssueList / ...)  │   │
│  │  ├── src/    │                                               │   │
│  │  │   └── ... │                                               │   │
│  │  └── README  │                                               │   │
│  └──────────────┴──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### State Management Architecture

```typescript
// Zustand store structure
interface GitHubStore {
  // Repository state
  currentRepo: Repository | null
  fileTree: TreeNode[] | null
  expandedPaths: Set<string>

  // File viewer state
  currentFile: FileContent | null
  currentRef: string  // branch or commit SHA

  // Pull request state
  currentPR: PullRequest | null
  diffFiles: DiffFile[]
  expandedDiffs: Set<string>
  pendingComments: Map<string, ReviewComment>

  // Notifications
  notifications: Notification[]
  unreadCount: number

  // UI state
  sidebarOpen: boolean
  searchQuery: string
  searchResults: SearchResult[]
}
```

---

## Step 3: Deep Dive - File Tree Browser (8 minutes)

### The Challenge

Large repositories have 100,000+ files. Rendering all nodes at once causes:
- Memory bloat
- Slow initial render
- Laggy interactions

### Virtualized Tree Implementation

```tsx
// FileTree.tsx - Virtualized tree for large repositories
import { useVirtualizer } from '@tanstack/react-virtual'

interface TreeNode {
  path: string
  name: string
  type: 'file' | 'directory'
  children?: TreeNode[]
}

export function FileTree({ tree, currentPath }: FileTreeProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const { expandedPaths, toggleExpand, setCurrentFile } = useRepoStore()

  // Flatten tree for virtualization (only expanded nodes)
  const flattenedNodes = useMemo(() => {
    const nodes: FlatNode[] = []

    function traverse(node: TreeNode, depth: number) {
      nodes.push({ ...node, depth })

      if (node.type === 'directory' && expandedPaths.has(node.path)) {
        node.children?.forEach(child => traverse(child, depth + 1))
      }
    }

    tree.forEach(node => traverse(node, 0))
    return nodes
  }, [tree, expandedPaths])

  const virtualizer = useVirtualizer({
    count: flattenedNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,  // Each row is 28px
    overscan: 10,
  })

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      role="tree"
      aria-label="Repository file tree"
    >
      <div
        style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const node = flattenedNodes[virtualRow.index]
          const isSelected = node.path === currentPath

          return (
            <div
              key={node.path}
              role="treeitem"
              aria-selected={isSelected}
              aria-expanded={node.type === 'directory' ? expandedPaths.has(node.path) : undefined}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className={`flex items-center px-2 cursor-pointer hover:bg-gray-100
                ${isSelected ? 'bg-blue-100' : ''}`}
              onClick={() => {
                if (node.type === 'directory') {
                  toggleExpand(node.path)
                } else {
                  setCurrentFile(node.path)
                }
              }}
              onKeyDown={(e) => handleTreeKeyboard(e, node, virtualRow.index)}
            >
              <span style={{ paddingLeft: `${node.depth * 16}px` }} />
              {node.type === 'directory' ? (
                <ChevronIcon expanded={expandedPaths.has(node.path)} />
              ) : null}
              <FileIcon type={getFileType(node.name)} />
              <span className="ml-1 truncate">{node.name}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Keyboard navigation handler
function handleTreeKeyboard(
  e: KeyboardEvent,
  node: FlatNode,
  index: number
) {
  switch (e.key) {
    case 'ArrowDown':
      // Focus next visible node
      break
    case 'ArrowUp':
      // Focus previous visible node
      break
    case 'ArrowRight':
      // Expand directory or move to first child
      break
    case 'ArrowLeft':
      // Collapse directory or move to parent
      break
    case 'Enter':
    case ' ':
      // Toggle expand or open file
      break
  }
}
```

### Lazy Loading Tree Nodes

```typescript
// Fetch tree contents on demand (not all at once)
async function fetchTreeNode(owner: string, repo: string, ref: string, path: string) {
  // API returns only immediate children, not full recursive tree
  const response = await fetch(
    `/api/repos/${owner}/${repo}/tree/${ref}?path=${encodeURIComponent(path)}`
  )
  return response.json()
}

// useTreeLoader hook
function useTreeLoader(owner: string, repo: string, ref: string) {
  const [tree, setTree] = useState<Map<string, TreeNode[]>>(new Map())

  const loadPath = useCallback(async (path: string) => {
    if (tree.has(path)) return

    const children = await fetchTreeNode(owner, repo, ref, path)
    setTree(prev => new Map(prev).set(path, children))
  }, [owner, repo, ref])

  return { tree, loadPath }
}
```

### Performance Optimizations

| Technique | Benefit |
|-----------|---------|
| Virtual list | Only render visible nodes (50 vs 100,000) |
| Lazy loading | Fetch subdirectories on expand |
| Memoized flattening | Recalculate only on expand/collapse |
| CSS containment | Isolate repaints to tree container |

---

## Step 4: Deep Dive - Code Viewer with Syntax Highlighting (10 minutes)

### Syntax Highlighting Strategy

```tsx
// CodeViewer.tsx
import { useEffect, useState, useRef } from 'react'
import { refractor } from 'refractor'
import { toHtml } from 'hast-util-to-html'

interface CodeViewerProps {
  content: string
  language: string
  path: string
}

export function CodeViewer({ content, language, path }: CodeViewerProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  // Split content into lines for line numbers
  const lines = useMemo(() => content.split('\n'), [content])

  // Lazy load language grammar
  useEffect(() => {
    async function highlight() {
      setIsLoading(true)

      try {
        // Dynamically import language grammar
        const grammar = await loadLanguageGrammar(language)
        if (grammar) {
          refractor.register(grammar)
        }

        // Perform highlighting
        const tree = refractor.highlight(content, language)
        const html = toHtml(tree)
        setHighlightedHtml(html)
      } catch (error) {
        // Fallback to plain text
        setHighlightedHtml(escapeHtml(content))
      } finally {
        setIsLoading(false)
      }
    }

    highlight()
  }, [content, language])

  return (
    <div className="code-viewer" ref={containerRef}>
      {/* Toolbar */}
      <div className="flex justify-between items-center px-4 py-2 bg-gray-50 border-b">
        <span className="text-sm font-mono">{path}</span>
        <div className="flex gap-2">
          <span className="text-sm text-gray-500">{lines.length} lines</span>
          <button onClick={() => copyToClipboard(content)}>
            <CopyIcon /> Copy
          </button>
          <button onClick={() => downloadFile(content, path)}>
            <DownloadIcon /> Download
          </button>
        </div>
      </div>

      {/* Code container with line numbers */}
      <div className="flex overflow-x-auto">
        {/* Line numbers column */}
        <div
          className="flex-shrink-0 text-right pr-4 select-none text-gray-400 bg-gray-50"
          aria-hidden="true"
        >
          {lines.map((_, i) => (
            <div key={i} className="leading-6 font-mono text-sm">
              <a
                href={`#L${i + 1}`}
                id={`L${i + 1}`}
                className="hover:text-blue-600"
              >
                {i + 1}
              </a>
            </div>
          ))}
        </div>

        {/* Code content */}
        <pre className="flex-grow overflow-x-auto">
          {isLoading ? (
            <code className="font-mono text-sm leading-6">{content}</code>
          ) : (
            <code
              className="font-mono text-sm leading-6"
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          )}
        </pre>
      </div>
    </div>
  )
}

// Language grammar lazy loader
const grammarCache = new Map<string, Promise<any>>()

async function loadLanguageGrammar(language: string) {
  if (grammarCache.has(language)) {
    return grammarCache.get(language)
  }

  const grammarMap: Record<string, () => Promise<any>> = {
    javascript: () => import('refractor/lang/javascript'),
    typescript: () => import('refractor/lang/typescript'),
    python: () => import('refractor/lang/python'),
    rust: () => import('refractor/lang/rust'),
    go: () => import('refractor/lang/go'),
    java: () => import('refractor/lang/java'),
    // ... more languages
  }

  const loader = grammarMap[language]
  if (loader) {
    const promise = loader()
    grammarCache.set(language, promise)
    return promise
  }

  return null
}
```

### Line Selection and Permalinks

```tsx
// useLineSelection hook for permalink support
function useLineSelection(containerRef: RefObject<HTMLElement>) {
  const [selectedLines, setSelectedLines] = useState<{ start: number; end: number } | null>(null)

  // Parse hash on mount (e.g., #L10-L20)
  useEffect(() => {
    const hash = window.location.hash
    const match = hash.match(/^#L(\d+)(?:-L(\d+))?$/)

    if (match) {
      const start = parseInt(match[1], 10)
      const end = match[2] ? parseInt(match[2], 10) : start
      setSelectedLines({ start, end })

      // Scroll to selected lines
      const lineElement = document.getElementById(`L${start}`)
      lineElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [])

  // Handle line click (with shift for range)
  const handleLineClick = useCallback((lineNumber: number, shiftKey: boolean) => {
    if (shiftKey && selectedLines) {
      const newRange = {
        start: Math.min(selectedLines.start, lineNumber),
        end: Math.max(selectedLines.start, lineNumber)
      }
      setSelectedLines(newRange)
      updateHash(`L${newRange.start}-L${newRange.end}`)
    } else {
      setSelectedLines({ start: lineNumber, end: lineNumber })
      updateHash(`L${lineNumber}`)
    }
  }, [selectedLines])

  return { selectedLines, handleLineClick }
}
```

### Blame View Integration

```tsx
// BlameView.tsx - Shows commit info for each line
function BlameView({ owner, repo, ref, path }: BlameViewProps) {
  const { data: blame } = useQuery({
    queryKey: ['blame', owner, repo, ref, path],
    queryFn: () => fetchBlame(owner, repo, ref, path),
  })

  return (
    <div className="flex">
      {/* Blame column */}
      <div className="w-64 flex-shrink-0 border-r">
        {blame?.lines.map((line, i) => (
          <div
            key={i}
            className={`h-6 px-2 text-xs truncate ${
              line.commitSha === blame.lines[i - 1]?.commitSha
                ? 'text-gray-300'  // Dim repeated commits
                : 'text-gray-600'
            }`}
          >
            <a href={`/${owner}/${repo}/commit/${line.commitSha}`}>
              {line.commitSha.slice(0, 7)}
            </a>
            <span className="ml-2">{line.author}</span>
            <span className="ml-2">{formatRelativeDate(line.date)}</span>
          </div>
        ))}
      </div>

      {/* Code content */}
      <CodeViewer content={blame?.content} language={getLanguage(path)} path={path} />
    </div>
  )
}
```

---

## Step 5: Deep Dive - Pull Request Diff Viewer (10 minutes)

### Diff Rendering Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PR Header                                     │
│  [Conversation] [Commits (12)] [Checks (3)] [Files Changed (42)]    │
└─────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│  Files Changed (42)                    [Unified] [Split] [Hide WS]  │
├─────────────────────────────────────────────────────────────────────┤
│  ▼ src/components/Button.tsx (+24, -12)                             │
│  ├─────────────────────────────────────────────────────────────────┤│
│  │ @@ -15,6 +15,8 @@ export function Button...                     ││
│  │   15    15  │ const classes = clsx(                             ││
│  │   16       │-  'px-4 py-2',                                     ││
│  │        16  │+  'px-4 py-2 rounded-md',                          ││
│  │        17  │+  'transition-colors duration-200',                ││
│  │   17    18 │   variant === 'primary' && 'bg-blue-500',          ││
│  │  [+] Add comment                                                 ││
│  ├─────────────────────────────────────────────────────────────────┤│
│  │ 💬 Review Comment                                                ││
│  │    @reviewer: Consider using a CSS variable here                ││
│  │    [Reply]                                                       ││
│  └─────────────────────────────────────────────────────────────────┘│
│  ▶ src/components/Input.tsx (+8, -2)         (collapsed)            │
│  ▶ src/styles/theme.css (+100, -0)                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Virtualized Diff Component

```tsx
// DiffViewer.tsx
import { useVirtualizer } from '@tanstack/react-virtual'

interface DiffFile {
  path: string
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

interface DiffHunk {
  header: string
  lines: DiffLine[]
}

interface DiffLine {
  type: 'context' | 'addition' | 'deletion'
  oldLineNumber: number | null
  newLineNumber: number | null
  content: string
}

export function DiffViewer({ files }: { files: DiffFile[] }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const { expandedFiles, viewMode, toggleFile, pendingComments } = usePRStore()

  // Calculate total rows for virtualization
  const flattenedRows = useMemo(() => {
    const rows: DiffRow[] = []

    for (const file of files) {
      // File header row
      rows.push({ type: 'file-header', file })

      if (expandedFiles.has(file.path)) {
        for (const hunk of file.hunks) {
          // Hunk header
          rows.push({ type: 'hunk-header', hunk })

          // Diff lines
          for (const line of hunk.lines) {
            rows.push({ type: 'diff-line', file, line })

            // Include any inline comments on this line
            const commentKey = `${file.path}:${line.newLineNumber || line.oldLineNumber}`
            const comments = pendingComments.get(commentKey)
            if (comments) {
              rows.push({ type: 'comments', comments, lineKey: commentKey })
            }
          }
        }
      }
    }

    return rows
  }, [files, expandedFiles, pendingComments])

  const virtualizer = useVirtualizer({
    count: flattenedRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const row = flattenedRows[index]
      switch (row.type) {
        case 'file-header': return 48
        case 'hunk-header': return 32
        case 'diff-line': return 24
        case 'comments': return 100 + (row.comments.length * 80)
        default: return 24
      }
    },
    overscan: 20,
  })

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = flattenedRows[virtualRow.index]

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: virtualRow.start,
                width: '100%',
              }}
            >
              {renderRow(row, viewMode)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function renderRow(row: DiffRow, viewMode: 'unified' | 'split') {
  switch (row.type) {
    case 'file-header':
      return <FileHeader file={row.file} />
    case 'hunk-header':
      return <HunkHeader hunk={row.hunk} />
    case 'diff-line':
      return viewMode === 'unified'
        ? <UnifiedDiffLine line={row.line} filePath={row.file.path} />
        : <SplitDiffLine line={row.line} filePath={row.file.path} />
    case 'comments':
      return <CommentThread comments={row.comments} lineKey={row.lineKey} />
  }
}
```

### Inline Comment Component

```tsx
// InlineCommentForm.tsx
function InlineCommentForm({ filePath, lineNumber, side }: InlineCommentProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [body, setBody] = useState('')
  const { addPendingComment } = usePRStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [body])

  if (!isOpen) {
    return (
      <button
        className="absolute right-2 opacity-0 group-hover:opacity-100 text-blue-500"
        onClick={() => setIsOpen(true)}
        aria-label="Add comment on this line"
      >
        <PlusIcon className="w-4 h-4" />
      </button>
    )
  }

  return (
    <div className="ml-16 mr-4 my-2 border rounded-md bg-white shadow-sm">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Leave a comment..."
        className="w-full p-3 border-b resize-none focus:outline-none"
        rows={3}
      />
      <div className="flex justify-between items-center p-2 bg-gray-50">
        <span className="text-xs text-gray-500">
          Markdown supported
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setIsOpen(false)
              setBody('')
            }}
            className="px-3 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              addPendingComment({
                filePath,
                lineNumber,
                side,
                body,
                status: 'pending'
              })
              setIsOpen(false)
              setBody('')
            }}
            disabled={!body.trim()}
            className="px-3 py-1 text-sm bg-green-600 text-white rounded disabled:opacity-50"
          >
            Add review comment
          </button>
        </div>
      </div>
    </div>
  )
}
```

### Diff View Modes

```tsx
// UnifiedDiffLine.tsx
function UnifiedDiffLine({ line, filePath }: DiffLineProps) {
  const bgColor = {
    addition: 'bg-green-50',
    deletion: 'bg-red-50',
    context: '',
  }[line.type]

  const prefixColor = {
    addition: 'text-green-600',
    deletion: 'text-red-600',
    context: 'text-gray-400',
  }[line.type]

  return (
    <div className={`flex group ${bgColor} font-mono text-sm`}>
      {/* Line numbers */}
      <span className="w-12 text-right pr-2 text-gray-400 select-none">
        {line.oldLineNumber || ''}
      </span>
      <span className="w-12 text-right pr-2 text-gray-400 select-none">
        {line.newLineNumber || ''}
      </span>

      {/* Change indicator */}
      <span className={`w-4 ${prefixColor} select-none`}>
        {line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '}
      </span>

      {/* Content */}
      <pre className="flex-grow px-2 whitespace-pre overflow-x-auto">
        <code>{line.content}</code>
      </pre>

      {/* Inline comment button */}
      <InlineCommentForm
        filePath={filePath}
        lineNumber={line.newLineNumber || line.oldLineNumber!}
        side={line.newLineNumber ? 'RIGHT' : 'LEFT'}
      />
    </div>
  )
}

// SplitDiffLine.tsx - Side-by-side view
function SplitDiffLine({ line, filePath }: DiffLineProps) {
  return (
    <div className="flex font-mono text-sm">
      {/* Left side (deletions/context) */}
      <div className={`flex-1 flex ${line.type === 'deletion' ? 'bg-red-50' : ''}`}>
        <span className="w-12 text-right pr-2 text-gray-400">
          {line.oldLineNumber || ''}
        </span>
        <pre className="flex-grow px-2">
          {line.type !== 'addition' && <code>{line.content}</code>}
        </pre>
      </div>

      {/* Divider */}
      <div className="w-px bg-gray-200" />

      {/* Right side (additions/context) */}
      <div className={`flex-1 flex ${line.type === 'addition' ? 'bg-green-50' : ''}`}>
        <span className="w-12 text-right pr-2 text-gray-400">
          {line.newLineNumber || ''}
        </span>
        <pre className="flex-grow px-2">
          {line.type !== 'deletion' && <code>{line.content}</code>}
        </pre>
      </div>
    </div>
  )
}
```

---

## Step 6: Search Results with Highlighting (7 minutes)

### Search Component Architecture

```tsx
// SearchResults.tsx
interface SearchResult {
  repoId: string
  repoFullName: string
  path: string
  language: string
  highlights: SearchHighlight[]
}

interface SearchHighlight {
  lineNumber: number
  content: string
  matchRanges: Array<{ start: number; end: number }>
}

function SearchResults({ query, filters }: SearchProps) {
  const { data, isLoading, fetchNextPage, hasNextPage } = useInfiniteQuery({
    queryKey: ['search', query, filters],
    queryFn: ({ pageParam = 0 }) => searchCode(query, filters, pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: query.length > 2,
  })

  // Intersection observer for infinite scroll
  const loadMoreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasNextPage) {
          fetchNextPage()
        }
      },
      { threshold: 0.1 }
    )

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current)
    }

    return () => observer.disconnect()
  }, [hasNextPage, fetchNextPage])

  const allResults = data?.pages.flatMap(page => page.results) ?? []

  return (
    <div className="divide-y">
      {/* Search header */}
      <div className="p-4 bg-gray-50">
        <span className="text-sm text-gray-600">
          {data?.pages[0]?.totalCount.toLocaleString()} results
        </span>

        {/* Filters */}
        <div className="flex gap-2 mt-2">
          <LanguageFilter
            selected={filters.language}
            onChange={(lang) => setFilters({ ...filters, language: lang })}
          />
          <RepoFilter
            selected={filters.repo}
            onChange={(repo) => setFilters({ ...filters, repo })}
          />
        </div>
      </div>

      {/* Results */}
      {allResults.map((result) => (
        <SearchResultItem key={`${result.repoId}:${result.path}`} result={result} />
      ))}

      {/* Load more trigger */}
      <div ref={loadMoreRef} className="h-10">
        {isLoading && <LoadingSpinner />}
      </div>
    </div>
  )
}
```

### Highlighted Code Snippet

```tsx
// SearchResultItem.tsx
function SearchResultItem({ result }: { result: SearchResult }) {
  return (
    <article className="p-4 hover:bg-gray-50">
      {/* File path header */}
      <header className="flex items-center gap-2 mb-2">
        <a
          href={`/${result.repoFullName}`}
          className="text-sm text-blue-600 hover:underline"
        >
          {result.repoFullName}
        </a>
        <span className="text-gray-400">/</span>
        <a
          href={`/${result.repoFullName}/blob/main/${result.path}`}
          className="text-sm font-medium text-blue-600 hover:underline"
        >
          {result.path}
        </a>
        <LanguageBadge language={result.language} />
      </header>

      {/* Highlighted code snippets */}
      <div className="bg-gray-50 rounded border overflow-hidden">
        {result.highlights.map((highlight, i) => (
          <div key={i} className="flex font-mono text-sm">
            <span className="w-12 text-right pr-2 py-1 bg-gray-100 text-gray-500 select-none">
              {highlight.lineNumber}
            </span>
            <code className="flex-grow px-2 py-1 whitespace-pre overflow-x-auto">
              <HighlightedText
                text={highlight.content}
                ranges={highlight.matchRanges}
              />
            </code>
          </div>
        ))}
      </div>
    </article>
  )
}

// HighlightedText - Renders text with highlighted matches
function HighlightedText({ text, ranges }: { text: string; ranges: Array<{ start: number; end: number }> }) {
  if (ranges.length === 0) return <>{text}</>

  const parts: JSX.Element[] = []
  let lastEnd = 0

  for (const range of ranges) {
    // Text before match
    if (range.start > lastEnd) {
      parts.push(
        <span key={`pre-${range.start}`}>
          {text.slice(lastEnd, range.start)}
        </span>
      )
    }

    // Highlighted match
    parts.push(
      <mark
        key={`match-${range.start}`}
        className="bg-yellow-200 rounded px-0.5"
      >
        {text.slice(range.start, range.end)}
      </mark>
    )

    lastEnd = range.end
  }

  // Text after last match
  if (lastEnd < text.length) {
    parts.push(
      <span key="post">{text.slice(lastEnd)}</span>
    )
  }

  return <>{parts}</>
}
```

---

## Step 7: Real-time Notifications (5 minutes)

### WebSocket Notification System

```tsx
// useNotifications hook
function useNotifications() {
  const { notifications, addNotification, markRead, unreadCount } = useNotificationStore()
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    const ws = new WebSocket(`${WS_URL}/notifications`)
    wsRef.current = ws

    ws.onmessage = (event) => {
      const notification = JSON.parse(event.data)
      addNotification(notification)

      // Show browser notification if permitted
      if (Notification.permission === 'granted') {
        new Notification(notification.title, {
          body: notification.body,
          icon: '/github-icon.png',
        })
      }
    }

    ws.onclose = () => {
      // Reconnect with exponential backoff
      setTimeout(() => {
        // Reconnect logic
      }, 1000)
    }

    return () => ws.close()
  }, [])

  return { notifications, markRead, unreadCount }
}

// NotificationBell component
function NotificationBell() {
  const { notifications, unreadCount, markRead } = useNotifications()
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 hover:bg-gray-100 rounded-full"
        aria-label={`Notifications (${unreadCount} unread)`}
      >
        <BellIcon className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute top-0 right-0 bg-blue-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-lg border z-50">
          <div className="flex justify-between items-center p-3 border-b">
            <h3 className="font-semibold">Notifications</h3>
            <button
              onClick={() => markRead('all')}
              className="text-sm text-blue-600 hover:underline"
            >
              Mark all as read
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {notifications.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onRead={() => markRead(notification.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
```

### Notification Types

```tsx
// NotificationItem.tsx
function NotificationItem({ notification, onRead }: NotificationItemProps) {
  const icon = {
    'pr.review_requested': <GitPullRequestIcon />,
    'pr.merged': <GitMergeIcon />,
    'issue.mentioned': <AtIcon />,
    'ci.failed': <XCircleIcon className="text-red-500" />,
    'ci.success': <CheckCircleIcon className="text-green-500" />,
  }[notification.type]

  return (
    <a
      href={notification.url}
      onClick={onRead}
      className={`flex gap-3 p-3 hover:bg-gray-50 ${
        notification.isRead ? 'opacity-60' : ''
      }`}
    >
      <span className="flex-shrink-0 mt-1">{icon}</span>
      <div className="flex-grow min-w-0">
        <p className="text-sm truncate">{notification.title}</p>
        <p className="text-xs text-gray-500 truncate">{notification.body}</p>
        <time className="text-xs text-gray-400">
          {formatRelativeTime(notification.createdAt)}
        </time>
      </div>
      {!notification.isRead && (
        <span className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0 mt-2" />
      )}
    </a>
  )
}
```

---

## Step 8: Accessibility Implementation (5 minutes)

### Keyboard Navigation Map

| Context | Key | Action |
|---------|-----|--------|
| File Tree | Arrow Up/Down | Navigate between nodes |
| File Tree | Arrow Right | Expand directory |
| File Tree | Arrow Left | Collapse directory |
| File Tree | Enter | Open file |
| Code Viewer | g + l | Go to line |
| Code Viewer | y | Copy permalink |
| Diff Viewer | j/k | Next/previous file |
| Diff Viewer | x | Expand/collapse file |
| Diff Viewer | c | Add comment |
| Global | / | Focus search |
| Global | ? | Show keyboard shortcuts |

### Focus Management

```tsx
// useFocusTrap for modals and overlays
function useFocusTrap(containerRef: RefObject<HTMLElement>, isActive: boolean) {
  useEffect(() => {
    if (!isActive) return

    const container = containerRef.current
    if (!container) return

    const focusableElements = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )

    const firstElement = focusableElements[0] as HTMLElement
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement

    // Focus first element on open
    firstElement?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault()
        lastElement?.focus()
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault()
        firstElement?.focus()
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [isActive])
}
```

### Screen Reader Announcements

```tsx
// Live region for dynamic updates
function useAnnounce() {
  const announce = useCallback((message: string, priority: 'polite' | 'assertive' = 'polite') => {
    const el = document.getElementById('sr-announcer')
    if (el) {
      el.setAttribute('aria-live', priority)
      el.textContent = message

      // Clear after announcement
      setTimeout(() => {
        el.textContent = ''
      }, 1000)
    }
  }, [])

  return announce
}

// In root layout
function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      {/* Screen reader announcer */}
      <div
        id="sr-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
    </>
  )
}
```

---

## Step 9: Key Design Decisions and Trade-offs (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Tree virtualization | TanStack Virtual | Full render | 100,000+ files would crash browser |
| Syntax highlighting | Refractor (Prism-based) | Shiki, Monaco | Lighter weight, lazy grammar loading |
| Diff view | Custom virtualized | Monaco diff | More control over inline comments |
| State management | Zustand | Redux, Context | Simple API, good devtools, small bundle |
| Real-time updates | WebSocket | SSE, polling | Bi-directional for typing indicators |

### Performance Optimizations Summary

| Technique | Applied To | Impact |
|-----------|-----------|--------|
| Virtualization | File tree, diff viewer, search | Render 50 items vs 10,000+ |
| Lazy loading | Tree nodes, language grammars | Smaller initial bundle |
| Memoization | Tree flattening, diff rows | Prevent recalculation |
| Code splitting | Routes, heavy components | Faster initial load |
| CSS containment | Tree, diff containers | Isolated repaints |

---

## Closing Summary

I've designed a frontend for a code hosting platform with four core UI systems:

1. **File Tree Browser**: Virtualized tree with lazy loading for repositories with 100,000+ files, full keyboard navigation, and expand-on-demand

2. **Code Viewer**: Syntax highlighting with lazy grammar loading, line selection for permalinks, and blame integration

3. **Pull Request Diff Viewer**: Virtualized diff display supporting unified and split views, inline commenting with pending comment collection, and expandable file sections

4. **Search and Notifications**: Infinite scroll search results with highlighted matches, real-time WebSocket notifications with browser notification integration

**Key frontend trade-offs:**
- Virtualization over full render (performance vs implementation complexity)
- Custom diff viewer over Monaco (control vs built-in features)
- Lazy grammar loading over preloading (initial load vs highlight delay)

**Future enhancements:**
- Monaco editor integration for file editing
- Collaborative editing with operational transforms
- Offline support with service workers
- Mobile-optimized touch gestures for diff review
