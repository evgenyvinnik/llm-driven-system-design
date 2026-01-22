# Collaborative Editor - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

## Opening Statement (1 minute)

"I'll design the frontend for a real-time collaborative document editor like Google Docs. My focus will be on building a responsive rich text editor with optimistic local updates, implementing client-side Operational Transformation for instant feedback, creating an intuitive presence system showing other users' cursors, and designing state management that handles concurrent edits gracefully.

The core UX challenges are: making edits feel instant despite network latency, visualizing other users' cursors and selections without distraction, handling reconnection gracefully when network drops, and providing clear feedback during conflict resolution."

## Requirements Clarification (3 minutes)

### User Experience Requirements
- **Instant Feedback**: Local edits appear immediately (< 16ms)
- **Presence Awareness**: See who's editing and where
- **Seamless Sync**: Remote changes merge smoothly without disrupting typing
- **Offline Resilience**: Continue editing when disconnected
- **Clear History**: Navigate document versions easily

### Frontend-Specific Requirements
- **Performance**: 60fps during typing, smooth cursor animations
- **Accessibility**: Full keyboard navigation, screen reader support
- **Responsive**: Works on desktop and tablet
- **Touch Support**: Mobile-friendly text selection

### Target Metrics
- Time to interactive: < 2s
- Input latency: < 16ms (1 frame)
- Remote cursor updates: < 100ms
- Bundle size: < 200KB gzipped

## Component Architecture (5 minutes)

```
+------------------------------------------------------------------+
|                     EditorApp                                      |
|                                                                    |
|  +------------------------------------------------------------+  |
|  |  EditorHeader                                                |  |
|  |  +------------------+  +------------------+  +-------------+ |  |
|  |  | DocumentTitle    |  | ShareButton      |  | PresenceBar | |  |
|  |  +------------------+  +------------------+  +-------------+ |  |
|  +------------------------------------------------------------+  |
|                                                                    |
|  +------------------------------------------------------------+  |
|  |  EditorToolbar                                               |  |
|  |  +--------+ +--------+ +--------+ +--------+ +--------+     |  |
|  |  | Bold   | | Italic | | Lists  | | Link   | | History|     |  |
|  |  +--------+ +--------+ +--------+ +--------+ +--------+     |  |
|  +------------------------------------------------------------+  |
|                                                                    |
|  +------------------------------------------------------------+  |
|  |  EditorCanvas                                                |  |
|  |  +--------------------------------------------------------+ |  |
|  |  |  RichTextEditor                                         | |  |
|  |  |  +----------------------------------------------------+ | |  |
|  |  |  |  ContentEditable                                    | | |  |
|  |  |  |  +----------------------------------+               | | |  |
|  |  |  |  | Paragraph 1                      |               | | |  |
|  |  |  |  +----------------------------------+               | | |  |
|  |  |  |  +----------------------------------+               | | |  |
|  |  |  |  | Paragraph 2  [Remote Cursor]     |               | | |  |
|  |  |  |  +----------------------------------+               | | |  |
|  |  |  +----------------------------------------------------+ | |  |
|  |  |  +----------------------------------------------------+ | |  |
|  |  |  |  CursorOverlay (remote cursors)                     | | |  |
|  |  |  +----------------------------------------------------+ | |  |
|  |  +--------------------------------------------------------+ |  |
|  +------------------------------------------------------------+  |
|                                                                    |
|  +------------------------------------------------------------+  |
|  |  SidePanel (contextual)                                      |  |
|  |  +------------------+  +------------------+                  |  |
|  |  | VersionHistory   |  | Comments         |                  |  |
|  |  +------------------+  +------------------+                  |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

### Component Hierarchy

```
EditorApp
├── EditorHeader
│   ├── DocumentTitle (inline editable)
│   ├── SaveIndicator (auto-save status)
│   ├── ShareButton + ShareModal
│   └── PresenceBar (user avatars)
├── EditorToolbar
│   ├── FormatButtons (bold, italic, underline)
│   ├── BlockButtons (heading, list, quote)
│   ├── InsertButtons (link, image, table)
│   └── HistoryButtons (undo, redo, version history)
├── EditorCanvas
│   ├── RichTextEditor
│   │   ├── ContentEditable
│   │   └── SelectionManager
│   ├── CursorOverlay
│   │   └── RemoteCursor (one per collaborator)
│   └── SelectionOverlay
│       └── RemoteSelection (highlight ranges)
├── SidePanel
│   ├── VersionHistory (timeline + restore)
│   └── CommentsPanel (threaded comments)
└── ConnectionStatus (banner when disconnected)
```

## Deep Dive: Collaborative Editor Component (10 minutes)

### Core Editor with OT Integration

```tsx
// CollaborativeEditor.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../stores/editorStore';
import { useSyncEngine } from '../hooks/useSyncEngine';
import { usePresence } from '../hooks/usePresence';
import { TextOperation } from '../lib/ot/TextOperation';
import { RichTextEditor } from './RichTextEditor';
import { CursorOverlay } from './CursorOverlay';
import { SelectionOverlay } from './SelectionOverlay';

interface Props {
  documentId: string;
  userId: string;
}

export function CollaborativeEditor({ documentId, userId }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);

  const {
    content,
    setContent,
    serverVersion,
    inflightOp,
    pendingOps,
    applyLocalOperation,
    applyRemoteOperation,
    setInitialState
  } = useEditorStore();

  const {
    connected,
    sendOperation,
    sendCursor,
    subscribe
  } = useSyncEngine(documentId, userId);

  const {
    remoteCursors,
    remoteSelections,
    updateLocalCursor
  } = usePresence(documentId, userId);

  // Initialize document
  useEffect(() => {
    const unsubscribe = subscribe({
      onInit: (data) => {
        setInitialState(data.content, data.version, data.clientId);
      },
      onAck: (data) => {
        useEditorStore.getState().acknowledgeOperation(data.version);
      },
      onOperation: (data) => {
        applyRemoteOperation(data.operation, data.version);
      },
      onResync: (data) => {
        setInitialState(data.content, data.version);
      }
    });

    return unsubscribe;
  }, [documentId]);

  // Handle local changes
  const handleChange = useCallback((operation: TextOperation) => {
    // Apply locally immediately (optimistic)
    applyLocalOperation(operation);

    // Send to server
    const operationId = generateOperationId();
    sendOperation(serverVersion, operation.toJSON(), operationId);
  }, [serverVersion, sendOperation, applyLocalOperation]);

  // Handle cursor movement
  const handleSelectionChange = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || !editorRef.current) return;

    const position = getSelectionPosition(editorRef.current, selection);
    updateLocalCursor(position);
    sendCursor(position);
  }, [sendCursor, updateLocalCursor]);

  return (
    <div className="collaborative-editor relative">
      {/* Connection status banner */}
      {!connected && (
        <div className="bg-amber-100 text-amber-800 px-4 py-2 text-sm">
          Reconnecting... Changes will sync when back online.
        </div>
      )}

      {/* Main editor */}
      <div ref={editorRef} className="editor-container relative">
        <RichTextEditor
          content={content}
          onChange={handleChange}
          onSelectionChange={handleSelectionChange}
        />

        {/* Remote cursors overlay */}
        <CursorOverlay
          cursors={remoteCursors}
          containerRef={editorRef}
        />

        {/* Remote selections overlay */}
        <SelectionOverlay
          selections={remoteSelections}
          containerRef={editorRef}
        />
      </div>

      {/* Sync status indicator */}
      <SyncIndicator
        hasInflight={inflightOp !== null}
        pendingCount={pendingOps.length}
        connected={connected}
      />
    </div>
  );
}

function SyncIndicator({ hasInflight, pendingCount, connected }: SyncIndicatorProps) {
  if (!connected) {
    return (
      <div className="flex items-center gap-2 text-amber-600">
        <CloudOffIcon className="w-4 h-4" />
        <span className="text-sm">Offline</span>
      </div>
    );
  }

  if (hasInflight || pendingCount > 0) {
    return (
      <div className="flex items-center gap-2 text-gray-500">
        <SyncingIcon className="w-4 h-4 animate-spin" />
        <span className="text-sm">Saving...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-green-600">
      <CloudCheckIcon className="w-4 h-4" />
      <span className="text-sm">Saved</span>
    </div>
  );
}
```

### Rich Text Editor Component

```tsx
// RichTextEditor.tsx
import { useCallback, useRef, useEffect } from 'react';
import { TextOperation } from '../lib/ot/TextOperation';
import { diffToOperation } from '../lib/ot/diff';

interface Props {
  content: string;
  onChange: (operation: TextOperation) => void;
  onSelectionChange: () => void;
}

export function RichTextEditor({ content, onChange, onSelectionChange }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastContentRef = useRef(content);
  const isApplyingRemoteRef = useRef(false);

  // Sync content to editor when changed externally
  useEffect(() => {
    if (!editorRef.current) return;

    // Skip if change came from local input
    if (editorRef.current.textContent === content) return;

    // Mark as applying remote change
    isApplyingRemoteRef.current = true;

    // Preserve selection
    const selection = window.getSelection();
    const savedSelection = selection ? saveSelection(editorRef.current, selection) : null;

    // Update content
    editorRef.current.textContent = content;
    lastContentRef.current = content;

    // Restore selection
    if (savedSelection) {
      restoreSelection(editorRef.current, savedSelection);
    }

    isApplyingRemoteRef.current = false;
  }, [content]);

  const handleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    // Ignore changes triggered by remote updates
    if (isApplyingRemoteRef.current) return;

    const newContent = e.currentTarget.textContent || '';
    const oldContent = lastContentRef.current;

    // Compute operation from diff
    const operation = diffToOperation(oldContent, newContent);
    lastContentRef.current = newContent;

    if (operation) {
      onChange(operation);
    }
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Handle special keys
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    }

    // Undo/Redo
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          // Redo
          useEditorStore.getState().redo();
        } else {
          // Undo
          useEditorStore.getState().undo();
        }
      }
    }
  }, []);

  return (
    <div
      ref={editorRef}
      contentEditable
      className="editor-content min-h-[500px] px-16 py-8 focus:outline-none
                 text-lg leading-relaxed font-serif"
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onSelect={onSelectionChange}
      onMouseUp={onSelectionChange}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Document editor"
    />
  );
}

// Selection utilities
function saveSelection(container: HTMLElement, selection: Selection): SavedSelection | null {
  if (selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  return {
    startOffset: getTextOffset(container, range.startContainer, range.startOffset),
    endOffset: getTextOffset(container, range.endContainer, range.endOffset)
  };
}

function restoreSelection(container: HTMLElement, saved: SavedSelection): void {
  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  const start = getNodeAtOffset(container, saved.startOffset);
  const end = getNodeAtOffset(container, saved.endOffset);

  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);

  selection.removeAllRanges();
  selection.addRange(range);
}

function getTextOffset(container: HTMLElement, node: Node, offset: number): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let totalOffset = 0;

  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode === node) {
      return totalOffset + offset;
    }
    totalOffset += currentNode.textContent?.length || 0;
    currentNode = walker.nextNode();
  }

  return totalOffset + offset;
}
```

### Cursor and Selection Overlays

```tsx
// CursorOverlay.tsx
import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface RemoteCursor {
  clientId: string;
  userId: string;
  userName: string;
  color: string;
  position: number;
  lastUpdated: number;
}

interface Props {
  cursors: RemoteCursor[];
  containerRef: React.RefObject<HTMLDivElement>;
}

export function CursorOverlay({ cursors, containerRef }: Props) {
  const cursorElements = useMemo(() => {
    if (!containerRef.current) return [];

    return cursors
      .filter(cursor => Date.now() - cursor.lastUpdated < 30000) // Hide stale cursors
      .map(cursor => {
        const coords = getCoordinatesAtOffset(containerRef.current!, cursor.position);
        return { ...cursor, coords };
      });
  }, [cursors, containerRef]);

  return (
    <div className="cursor-overlay pointer-events-none absolute inset-0">
      <AnimatePresence>
        {cursorElements.map(cursor => (
          <motion.div
            key={cursor.clientId}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
            className="absolute"
            style={{
              left: cursor.coords.x,
              top: cursor.coords.y,
              transform: 'translateX(-1px)'
            }}
          >
            {/* Cursor line */}
            <div
              className="w-0.5 h-5"
              style={{ backgroundColor: cursor.color }}
            />

            {/* Name tag */}
            <div
              className="absolute -top-5 left-0 px-1.5 py-0.5 rounded text-xs
                         text-white whitespace-nowrap shadow-sm"
              style={{ backgroundColor: cursor.color }}
            >
              {cursor.userName}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// SelectionOverlay.tsx
interface RemoteSelection {
  clientId: string;
  color: string;
  startOffset: number;
  endOffset: number;
}

interface Props {
  selections: RemoteSelection[];
  containerRef: React.RefObject<HTMLDivElement>;
}

export function SelectionOverlay({ selections, containerRef }: Props) {
  const selectionRects = useMemo(() => {
    if (!containerRef.current) return [];

    return selections.flatMap(selection => {
      const rects = getRangeRects(
        containerRef.current!,
        selection.startOffset,
        selection.endOffset
      );
      return rects.map((rect, i) => ({
        key: `${selection.clientId}-${i}`,
        color: selection.color,
        rect
      }));
    });
  }, [selections, containerRef]);

  return (
    <div className="selection-overlay pointer-events-none absolute inset-0">
      {selectionRects.map(({ key, color, rect }) => (
        <div
          key={key}
          className="absolute"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            backgroundColor: color,
            opacity: 0.3
          }}
        />
      ))}
    </div>
  );
}

function getCoordinatesAtOffset(container: HTMLElement, offset: number): { x: number, y: number } {
  const { node, offset: nodeOffset } = getNodeAtOffset(container, offset);

  const range = document.createRange();
  range.setStart(node, nodeOffset);
  range.setEnd(node, nodeOffset);

  const rect = range.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  return {
    x: rect.left - containerRect.left,
    y: rect.top - containerRect.top
  };
}
```

## Deep Dive: State Management (8 minutes)

### Editor Store with OT

```typescript
// stores/editorStore.ts
import { create } from 'zustand';
import { TextOperation } from '../lib/ot/TextOperation';
import { OTTransformer } from '../lib/ot/OTTransformer';

interface EditorState {
  // Document state
  content: string;
  serverVersion: number;
  clientId: string | null;

  // Operation state
  inflightOp: TextOperation | null;
  inflightOpId: string | null;
  pendingOps: TextOperation[];

  // History for undo/redo
  undoStack: TextOperation[];
  redoStack: TextOperation[];

  // Actions
  setInitialState: (content: string, version: number, clientId?: string) => void;
  applyLocalOperation: (op: TextOperation) => void;
  applyRemoteOperation: (opData: any, version: number) => void;
  acknowledgeOperation: (version: number) => void;
  undo: () => TextOperation | null;
  redo: () => TextOperation | null;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  content: '',
  serverVersion: 0,
  clientId: null,
  inflightOp: null,
  inflightOpId: null,
  pendingOps: [],
  undoStack: [],
  redoStack: [],

  setInitialState: (content, version, clientId) => {
    set({
      content,
      serverVersion: version,
      clientId: clientId || get().clientId,
      inflightOp: null,
      inflightOpId: null,
      pendingOps: [],
      undoStack: [],
      redoStack: []
    });
  },

  applyLocalOperation: (op) => {
    const state = get();

    // Apply to content immediately
    const newContent = op.apply(state.content);

    // Add to pending operations
    let newPending = [...state.pendingOps];
    if (newPending.length > 0) {
      // Compose with last pending operation
      const last = newPending.pop()!;
      newPending.push(OTTransformer.compose(last, op));
    } else {
      newPending.push(op);
    }

    // Compute inverse for undo
    const inverse = computeInverse(op, state.content);

    set({
      content: newContent,
      pendingOps: newPending,
      undoStack: [...state.undoStack, inverse],
      redoStack: [] // Clear redo on new edit
    });
  },

  applyRemoteOperation: (opData, version) => {
    const state = get();
    let op = TextOperation.fromJSON(opData);

    // Update server version
    set({ serverVersion: version });

    // Transform against inflight operation
    if (state.inflightOp) {
      const [opPrime, inflightPrime] = OTTransformer.transform(op, state.inflightOp);
      op = opPrime;
      set({ inflightOp: inflightPrime });
    }

    // Transform against all pending operations
    const newPending: TextOperation[] = [];
    for (const pending of state.pendingOps) {
      const [opPrime, pendingPrime] = OTTransformer.transform(op, pending);
      op = opPrime;
      newPending.push(pendingPrime);
    }

    // Apply transformed operation
    const newContent = op.apply(state.content);

    // Transform undo stack
    const newUndoStack = state.undoStack.map(undoOp => {
      const [transformed] = OTTransformer.transform(undoOp, op);
      return transformed;
    });

    set({
      content: newContent,
      pendingOps: newPending,
      undoStack: newUndoStack
    });
  },

  acknowledgeOperation: (version) => {
    const state = get();

    set({
      serverVersion: version,
      inflightOp: null,
      inflightOpId: null
    });

    // Send next pending operation if any
    if (state.pendingOps.length > 0) {
      // This triggers the sync engine to send
      // via subscription in the component
    }
  },

  undo: () => {
    const state = get();
    if (state.undoStack.length === 0) return null;

    const undoOp = state.undoStack[state.undoStack.length - 1];
    const newContent = undoOp.apply(state.content);
    const redoOp = computeInverse(undoOp, state.content);

    set({
      content: newContent,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, redoOp]
    });

    return undoOp;
  },

  redo: () => {
    const state = get();
    if (state.redoStack.length === 0) return null;

    const redoOp = state.redoStack[state.redoStack.length - 1];
    const newContent = redoOp.apply(state.content);
    const undoOp = computeInverse(redoOp, state.content);

    set({
      content: newContent,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, undoOp]
    });

    return redoOp;
  }
}));

function computeInverse(op: TextOperation, beforeContent: string): TextOperation {
  const inverse = new TextOperation();
  let index = 0;

  for (const o of op.ops) {
    if (o.retain) {
      inverse.retain(o.retain);
      index += o.retain;
    } else if (o.insert) {
      inverse.delete(o.insert.length);
    } else if (o.delete) {
      inverse.insert(beforeContent.slice(index, index + o.delete));
      index += o.delete;
    }
  }

  return inverse;
}
```

### WebSocket Sync Hook

```typescript
// hooks/useSyncEngine.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../stores/editorStore';

interface SyncCallbacks {
  onInit: (data: InitMessage) => void;
  onAck: (data: AckMessage) => void;
  onOperation: (data: OperationMessage) => void;
  onResync: (data: ResyncMessage) => void;
}

export function useSyncEngine(documentId: string, userId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const [connected, setConnected] = useState(false);
  const callbacksRef = useRef<SyncCallbacks | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`wss://api.example.com/doc/${documentId}?userId=${userId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      flushPendingOperations();
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);

      switch (message.type) {
        case 'init':
          callbacksRef.current?.onInit(message);
          break;
        case 'ack':
          callbacksRef.current?.onAck(message);
          flushPendingOperations();
          break;
        case 'operation':
          callbacksRef.current?.onOperation(message);
          break;
        case 'resync':
          callbacksRef.current?.onResync(message);
          break;
      }
    };

    ws.onclose = () => {
      setConnected(false);

      // Exponential backoff reconnect
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectAttempts++;
        connect();
      }, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [documentId, userId]);

  let reconnectAttempts = 0;

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const flushPendingOperations = useCallback(() => {
    const state = useEditorStore.getState();
    const ws = wsRef.current;

    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (state.inflightOp !== null) return; // Wait for ack
    if (state.pendingOps.length === 0) return;

    // Compose all pending into one
    let composedOp = state.pendingOps[0];
    for (let i = 1; i < state.pendingOps.length; i++) {
      composedOp = OTTransformer.compose(composedOp, state.pendingOps[i]);
    }

    const operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Mark as inflight
    useEditorStore.setState({
      inflightOp: composedOp,
      inflightOpId: operationId,
      pendingOps: []
    });

    // Send to server
    ws.send(JSON.stringify({
      type: 'operation',
      version: state.serverVersion,
      operation: composedOp.toJSON(),
      operationId
    }));
  }, []);

  const sendOperation = useCallback((version: number, operation: any, operationId: string) => {
    // Operations are batched via the store
    flushPendingOperations();
  }, [flushPendingOperations]);

  const sendCursor = useCallback((position: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      type: 'cursor',
      position
    }));
  }, []);

  const subscribe = useCallback((callbacks: SyncCallbacks) => {
    callbacksRef.current = callbacks;
    return () => {
      callbacksRef.current = null;
    };
  }, []);

  return {
    connected,
    sendOperation,
    sendCursor,
    subscribe
  };
}
```

### Presence Hook

```typescript
// hooks/usePresence.ts
import { useCallback, useEffect, useState } from 'react';

interface RemoteCursor {
  clientId: string;
  userId: string;
  userName: string;
  color: string;
  position: number;
  lastUpdated: number;
}

export function usePresence(documentId: string, userId: string) {
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);
  const [remoteSelections, setRemoteSelections] = useState<RemoteSelection[]>([]);
  const [localCursor, setLocalCursor] = useState<number>(0);

  // Listen for cursor updates from sync engine
  useEffect(() => {
    const handleMessage = (event: CustomEvent) => {
      const { type, ...data } = event.detail;

      if (type === 'cursor') {
        setRemoteCursors(prev => {
          const filtered = prev.filter(c => c.clientId !== data.clientId);
          return [...filtered, {
            ...data,
            lastUpdated: Date.now()
          }];
        });
      }

      if (type === 'selection') {
        setRemoteSelections(prev => {
          const filtered = prev.filter(s => s.clientId !== data.clientId);
          if (data.startOffset !== data.endOffset) {
            return [...filtered, data];
          }
          return filtered;
        });
      }

      if (type === 'client_join') {
        // New user joined - they will send cursor soon
      }

      if (type === 'client_leave') {
        setRemoteCursors(prev => prev.filter(c => c.clientId !== data.clientId));
        setRemoteSelections(prev => prev.filter(s => s.clientId !== data.clientId));
      }
    };

    window.addEventListener('presence-update', handleMessage as EventListener);
    return () => {
      window.removeEventListener('presence-update', handleMessage as EventListener);
    };
  }, []);

  // Clean up stale cursors
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setRemoteCursors(prev => prev.filter(c => now - c.lastUpdated < 30000));
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const updateLocalCursor = useCallback((position: number) => {
    setLocalCursor(position);
  }, []);

  return {
    remoteCursors,
    remoteSelections,
    localCursor,
    updateLocalCursor
  };
}
```

## Deep Dive: Presence Bar and User Avatars (5 minutes)

### Presence Bar Component

```tsx
// PresenceBar.tsx
import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Collaborator {
  userId: string;
  userName: string;
  avatarUrl?: string;
  color: string;
  isActive: boolean;
  lastActive: number;
}

interface Props {
  collaborators: Collaborator[];
  maxVisible?: number;
}

export function PresenceBar({ collaborators, maxVisible = 5 }: Props) {
  const { visible, overflow } = useMemo(() => {
    const sorted = [...collaborators].sort((a, b) => {
      // Active users first, then by last active time
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.lastActive - a.lastActive;
    });

    return {
      visible: sorted.slice(0, maxVisible),
      overflow: sorted.slice(maxVisible)
    };
  }, [collaborators, maxVisible]);

  return (
    <div className="flex items-center -space-x-2">
      <AnimatePresence mode="popLayout">
        {visible.map((user, index) => (
          <motion.div
            key={user.userId}
            layout
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.2 }}
            style={{ zIndex: visible.length - index }}
          >
            <UserAvatar
              user={user}
              showStatus
            />
          </motion.div>
        ))}
      </AnimatePresence>

      {overflow.length > 0 && (
        <OverflowIndicator
          count={overflow.length}
          users={overflow}
        />
      )}
    </div>
  );
}

function UserAvatar({ user, showStatus }: { user: Collaborator; showStatus?: boolean }) {
  return (
    <div className="relative group">
      <div
        className="w-8 h-8 rounded-full border-2 border-white shadow-sm
                   overflow-hidden cursor-pointer"
        style={{ borderColor: user.color }}
      >
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt={user.userName}
            className="w-full h-full object-cover"
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center text-white text-sm font-medium"
            style={{ backgroundColor: user.color }}
          >
            {user.userName.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Activity indicator */}
      {showStatus && (
        <div
          className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white
                     ${user.isActive ? 'bg-green-500' : 'bg-gray-400'}`}
        />
      )}

      {/* Tooltip */}
      <div
        className="absolute top-full left-1/2 -translate-x-1/2 mt-2
                   px-2 py-1 bg-gray-900 text-white text-xs rounded
                   opacity-0 group-hover:opacity-100 transition-opacity
                   pointer-events-none whitespace-nowrap z-50"
      >
        {user.userName}
        {!user.isActive && (
          <span className="text-gray-400 ml-1">
            (away {formatTimeAgo(user.lastActive)})
          </span>
        )}
      </div>
    </div>
  );
}

function OverflowIndicator({ count, users }: { count: number; users: Collaborator[] }) {
  return (
    <div className="relative group">
      <div
        className="w-8 h-8 rounded-full bg-gray-100 border-2 border-white shadow-sm
                   flex items-center justify-center text-xs font-medium text-gray-600"
      >
        +{count}
      </div>

      {/* Dropdown on hover */}
      <div
        className="absolute top-full right-0 mt-2 py-2 bg-white rounded-lg shadow-lg
                   opacity-0 group-hover:opacity-100 transition-opacity
                   pointer-events-none group-hover:pointer-events-auto z-50"
      >
        {users.map(user => (
          <div key={user.userId} className="flex items-center gap-2 px-3 py-1.5">
            <UserAvatar user={user} />
            <span className="text-sm">{user.userName}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
```

## Deep Dive: Version History (5 minutes)

```tsx
// VersionHistory.tsx
import { useCallback, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

interface Version {
  version: number;
  createdAt: string;
  author: string;
  sizeBytes: number;
}

interface Props {
  documentId: string;
  currentVersion: number;
  onRestore: (version: number) => void;
  onPreview: (content: string, version: number) => void;
}

export function VersionHistory({ documentId, currentVersion, onRestore, onPreview }: Props) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/documents/${documentId}/versions`);
      const data = await response.json();
      setVersions(data.versions);
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  const handlePreview = useCallback(async (version: number) => {
    const response = await fetch(`/api/documents/${documentId}/versions/${version}`);
    const data = await response.json();
    setPreviewVersion(version);
    onPreview(data.content, version);
  }, [documentId, onPreview]);

  const handleRestore = useCallback(async (version: number) => {
    if (!confirm(`Restore document to version ${version}? This will create a new version.`)) {
      return;
    }

    await fetch(`/api/documents/${documentId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version })
    });

    onRestore(version);
  }, [documentId, onRestore]);

  return (
    <div className="version-history bg-white border-l h-full overflow-hidden flex flex-col">
      <div className="p-4 border-b">
        <h3 className="font-semibold">Version History</h3>
        <p className="text-sm text-gray-500">Click to preview, restore if needed</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
          </div>
        ) : (
          <div className="divide-y">
            {versions.map((version) => (
              <VersionItem
                key={version.version}
                version={version}
                isCurrent={version.version === currentVersion}
                isPreview={version.version === previewVersion}
                onPreview={() => handlePreview(version.version)}
                onRestore={() => handleRestore(version.version)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function VersionItem({
  version,
  isCurrent,
  isPreview,
  onPreview,
  onRestore
}: {
  version: Version;
  isCurrent: boolean;
  isPreview: boolean;
  onPreview: () => void;
  onRestore: () => void;
}) {
  return (
    <div
      className={`p-3 cursor-pointer hover:bg-gray-50 transition-colors
                 ${isPreview ? 'bg-blue-50' : ''}`}
      onClick={onPreview}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-sm">
            {isCurrent ? 'Current version' : `Version ${version.version}`}
          </div>
          <div className="text-xs text-gray-500">
            {formatDistanceToNow(new Date(version.createdAt), { addSuffix: true })}
          </div>
        </div>

        {version.author && (
          <div className="text-xs text-gray-500">{version.author}</div>
        )}
      </div>

      {isPreview && !isCurrent && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
          className="mt-2 px-3 py-1 bg-blue-500 text-white text-sm rounded
                     hover:bg-blue-600 transition-colors"
        >
          Restore this version
        </button>
      )}
    </div>
  );
}
```

## Trade-offs and Alternatives (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Editor | ContentEditable | Prosemirror/Slate | Simpler for learning, direct DOM access |
| State | Zustand | Redux | Lighter weight, simpler OT integration |
| Cursors | Overlay div | SVG | Easier positioning and styling |
| Animations | Framer Motion | CSS | More control over layout animations |
| Diff | Custom OT | diff-match-patch | Learning purpose, OT integration |
| Selection | Manual tracking | Native API | Cross-browser consistency |

### ContentEditable vs Rich Text Framework

**Chose ContentEditable because:**
- Direct control over DOM for OT integration
- No framework abstraction to work around
- Better for learning OT concepts

**Trade-off:** More manual work for formatting, but cleaner OT integration

### CSS Layout

```css
/* Main editor layout */
.editor-app {
  display: grid;
  grid-template-rows: auto auto 1fr;
  height: 100vh;
}

.editor-canvas {
  display: grid;
  grid-template-columns: 1fr 300px;
  overflow: hidden;
}

@media (max-width: 768px) {
  .editor-canvas {
    grid-template-columns: 1fr;
  }

  .side-panel {
    position: fixed;
    inset: 0;
    transform: translateX(100%);
    transition: transform 0.3s ease;
  }

  .side-panel.open {
    transform: translateX(0);
  }
}

/* Cursor animations */
.remote-cursor {
  animation: cursor-blink 1s ease-in-out infinite;
}

@keyframes cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

## Accessibility Considerations

```tsx
// Keyboard shortcuts
const keyboardShortcuts = {
  'Mod-z': 'Undo',
  'Mod-Shift-z': 'Redo',
  'Mod-b': 'Bold',
  'Mod-i': 'Italic',
  'Mod-k': 'Insert link'
};

// Screen reader announcements
function announceChange(type: 'save' | 'remote' | 'restore') {
  const messages = {
    save: 'Document saved',
    remote: 'Changes from collaborator applied',
    restore: 'Document restored to previous version'
  };

  const announcement = document.createElement('div');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.className = 'sr-only';
  announcement.textContent = messages[type];

  document.body.appendChild(announcement);
  setTimeout(() => announcement.remove(), 1000);
}
```

## Future Enhancements

1. **Rich Text Formatting** - Bold, italic, headings with operation attributes
2. **Comments** - Inline threaded comments with range anchoring
3. **Offline Mode** - Service worker with IndexedDB for local persistence
4. **Mobile Optimization** - Touch-friendly selection and toolbar
5. **Dark Mode** - Theme support with CSS variables
6. **Keyboard Shortcuts Panel** - Discoverable shortcuts overlay
