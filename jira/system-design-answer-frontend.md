# Design Jira - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thanks for the opportunity. Today I'll design Jira, an issue tracking and project management system. From a frontend perspective, Jira presents fascinating UI challenges:

1. **Complex board interactions** with drag-and-drop across columns
2. **Inline editing** for issue fields with validation
3. **Dynamic forms** that adapt to issue type and project settings
4. **Real-time updates** when teammates modify issues
5. **JQL search interface** with autocomplete and syntax highlighting

I'll focus on the board component architecture, the issue detail panel, and how we handle optimistic updates for a responsive UX."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For the user interface:

1. **Board View**: Kanban columns with drag-and-drop reordering
2. **Issue Detail**: Slide-out panel with inline editing
3. **Quick Search**: JQL autocomplete with recent queries
4. **Project Sidebar**: Navigation and quick filters
5. **Issue Creation**: Modal with dynamic field rendering"

### Non-Functional Requirements

"For user experience:

- **Responsiveness**: Immediate feedback on all interactions
- **Accessibility**: WCAG 2.1 AA compliance, keyboard navigation
- **Performance**: Smooth drag-and-drop with 100+ issues visible
- **Offline Support**: Optimistic updates with conflict resolution"

---

## Component Architecture (10 minutes)

### Directory Structure

```
frontend/src/
├── components/
│   ├── ui.tsx                    # Reusable UI primitives
│   ├── Layout.tsx                # App shell with navigation
│   ├── Board.tsx                 # Kanban/Scrum board container
│   ├── BoardColumn.tsx           # Individual column with issues
│   ├── IssueCard.tsx             # Card in board column
│   ├── CreateIssueModal.tsx      # Issue creation modal
│   ├── IssueDetail.tsx           # Issue detail panel (container)
│   └── issue-detail/             # Sub-components
│       ├── index.ts              # Barrel exports
│       ├── IssueDetailHeader.tsx
│       ├── IssueDetailSidebar.tsx
│       ├── IssueDetailTabs.tsx
│       ├── IssueSummaryEditor.tsx
│       ├── CommentsTab.tsx
│       └── HistoryTab.tsx
├── hooks/
│   ├── useIssueDetail.ts         # Issue detail state management
│   ├── useDragAndDrop.ts         # Board drag-and-drop logic
│   └── useJQLAutocomplete.ts     # Search autocomplete
├── stores/
│   ├── boardStore.ts             # Board state (Zustand)
│   ├── issueStore.ts             # Issue cache
│   └── projectStore.ts           # Project settings
├── services/
│   └── api.ts                    # API client functions
└── types/
    └── index.ts                  # TypeScript interfaces
```

### Type Definitions

```typescript
// types/index.ts
export interface Project {
  id: string;
  key: string;
  name: string;
  lead: User;
  workflow: Workflow;
}

export interface Issue {
  id: number;
  key: string;  // 'PROJ-123'
  summary: string;
  description: string;
  issueType: IssueType;
  status: Status;
  priority: Priority;
  assignee: User | null;
  reporter: User;
  storyPoints: number | null;
  customFields: Record<string, any>;
  version: number;  // For optimistic locking
  createdAt: string;
  updatedAt: string;
}

export interface Status {
  id: number;
  name: string;
  category: 'todo' | 'in_progress' | 'done';
}

export interface Transition {
  id: number;
  name: string;
  to: Status;
}

export interface BoardColumn {
  status: Status;
  issues: Issue[];
}

export type IssueType = {
  id: number;
  name: string;
  icon: 'story' | 'bug' | 'task' | 'epic' | 'subtask';
};

export type Priority = {
  id: number;
  name: string;
  icon: 'highest' | 'high' | 'medium' | 'low' | 'lowest';
};
```

---

## Deep Dive: Board Component (12 minutes)

### Board Container

```tsx
// components/Board.tsx
import { useBoardStore } from '../stores/boardStore';
import { BoardColumn } from './BoardColumn';
import { useDragAndDrop } from '../hooks/useDragAndDrop';

export function Board() {
  const { columns, moveIssue, isLoading } = useBoardStore();
  const { dragState, handlers } = useDragAndDrop({ onMove: moveIssue });

  if (isLoading) {
    return <BoardSkeleton />;
  }

  return (
    <div className="flex gap-4 overflow-x-auto p-4 h-full">
      {columns.map((column) => (
        <BoardColumn
          key={column.status.id}
          column={column}
          dragState={dragState}
          {...handlers}
        />
      ))}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-4 p-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="w-72 flex-shrink-0">
          <div className="h-8 bg-gray-200 rounded mb-4 animate-pulse" />
          <div className="space-y-3">
            {[1, 2, 3].map((j) => (
              <div key={j} className="h-24 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

### Board Column with Drop Zone

```tsx
// components/BoardColumn.tsx
import { Issue, BoardColumn as ColumnType, Status } from '../types';
import { IssueCard } from './IssueCard';
import clsx from 'clsx';

interface BoardColumnProps {
  column: ColumnType;
  dragState: DragState;
  onDragStart: (issue: Issue) => void;
  onDragOver: (e: React.DragEvent, status: Status) => void;
  onDrop: (status: Status) => void;
}

export function BoardColumn({
  column,
  dragState,
  onDragStart,
  onDragOver,
  onDrop,
}: BoardColumnProps) {
  const isDropTarget = dragState.overStatus?.id === column.status.id;
  const isDragging = dragState.draggingIssue !== null;

  return (
    <div className="w-72 flex-shrink-0 flex flex-col">
      {/* Column Header */}
      <div className="flex items-center gap-2 mb-3 px-2">
        <StatusDot category={column.status.category} />
        <h3 className="font-medium text-gray-700">{column.status.name}</h3>
        <span className="text-sm text-gray-400 ml-auto">
          {column.issues.length}
        </span>
      </div>

      {/* Drop Zone */}
      <div
        className={clsx(
          'flex-1 rounded-lg p-2 min-h-[200px] transition-colors',
          isDropTarget && isDragging && 'bg-blue-50 border-2 border-blue-300 border-dashed',
          !isDropTarget && 'bg-gray-50'
        )}
        onDragOver={(e) => onDragOver(e, column.status)}
        onDrop={() => onDrop(column.status)}
        role="region"
        aria-label={`${column.status.name} column with ${column.issues.length} issues`}
      >
        <div className="space-y-2">
          {column.issues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              onDragStart={() => onDragStart(issue)}
              isDragging={dragState.draggingIssue?.id === issue.id}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ category }: { category: Status['category'] }) {
  const colors = {
    todo: 'bg-gray-400',
    in_progress: 'bg-blue-500',
    done: 'bg-green-500',
  };

  return <div className={clsx('w-3 h-3 rounded-full', colors[category])} />;
}
```

### Issue Card Component

```tsx
// components/IssueCard.tsx
import { Issue } from '../types';
import { IssueTypeIcon, PriorityIcon, Avatar } from './ui';
import clsx from 'clsx';

interface IssueCardProps {
  issue: Issue;
  onDragStart: () => void;
  isDragging: boolean;
}

export function IssueCard({ issue, onDragStart, isDragging }: IssueCardProps) {
  const openDetail = () => {
    // Navigate to issue detail panel
    window.history.pushState({}, '', `/browse/${issue.key}`);
  };

  return (
    <div
      className={clsx(
        'bg-white rounded-lg shadow-sm border border-gray-200 p-3 cursor-pointer',
        'hover:shadow-md hover:border-blue-300 transition-all',
        'focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none',
        isDragging && 'opacity-50 rotate-2 scale-105'
      )}
      draggable
      onDragStart={onDragStart}
      onClick={openDetail}
      onKeyDown={(e) => e.key === 'Enter' && openDetail()}
      tabIndex={0}
      role="button"
      aria-label={`Issue ${issue.key}: ${issue.summary}`}
    >
      {/* Summary */}
      <p className="text-sm text-gray-800 mb-2 line-clamp-2">
        {issue.summary}
      </p>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <IssueTypeIcon type={issue.issueType.icon} className="w-4 h-4" />
          <span className="text-xs text-gray-500">{issue.key}</span>
        </div>

        <div className="flex items-center gap-2">
          <PriorityIcon priority={issue.priority.icon} className="w-4 h-4" />
          {issue.storyPoints && (
            <span className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">
              {issue.storyPoints}
            </span>
          )}
          {issue.assignee && (
            <Avatar
              src={issue.assignee.avatarUrl}
              alt={issue.assignee.displayName}
              size="sm"
            />
          )}
        </div>
      </div>
    </div>
  );
}
```

### Drag and Drop Hook

```tsx
// hooks/useDragAndDrop.ts
import { useState, useCallback } from 'react';
import { Issue, Status } from '../types';

interface DragState {
  draggingIssue: Issue | null;
  overStatus: Status | null;
}

interface UseDragAndDropOptions {
  onMove: (issueId: number, toStatusId: number) => Promise<void>;
}

export function useDragAndDrop({ onMove }: UseDragAndDropOptions) {
  const [dragState, setDragState] = useState<DragState>({
    draggingIssue: null,
    overStatus: null,
  });

  const handleDragStart = useCallback((issue: Issue) => {
    setDragState({ draggingIssue: issue, overStatus: null });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, status: Status) => {
    e.preventDefault();  // Allow drop
    setDragState((prev) => ({ ...prev, overStatus: status }));
  }, []);

  const handleDrop = useCallback(async (status: Status) => {
    const { draggingIssue } = dragState;
    if (!draggingIssue || draggingIssue.status.id === status.id) {
      setDragState({ draggingIssue: null, overStatus: null });
      return;
    }

    // Reset drag state immediately for responsive UI
    setDragState({ draggingIssue: null, overStatus: null });

    // Execute move (optimistic update happens in store)
    await onMove(draggingIssue.id, status.id);
  }, [dragState, onMove]);

  const handleDragEnd = useCallback(() => {
    setDragState({ draggingIssue: null, overStatus: null });
  }, []);

  return {
    dragState,
    handlers: {
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
      onDragEnd: handleDragEnd,
    },
  };
}
```

---

## Deep Dive: Issue Detail Panel (10 minutes)

### Issue Detail Container

```tsx
// components/IssueDetail.tsx
import { useIssueDetail } from '../hooks/useIssueDetail';
import {
  IssueDetailHeader,
  IssueDetailSidebar,
  IssueDetailTabs,
  IssueSummaryEditor,
} from './issue-detail';

interface IssueDetailProps {
  issueKey: string;
  onClose: () => void;
}

export function IssueDetail({ issueKey, onClose }: IssueDetailProps) {
  const { state, actions } = useIssueDetail(issueKey);

  if (state.isLoading) {
    return <IssueDetailSkeleton />;
  }

  if (state.error) {
    return <IssueDetailError error={state.error} onRetry={actions.refetch} />;
  }

  const { issue, transitions, comments, history } = state;

  return (
    <div className="fixed inset-y-0 right-0 w-[800px] bg-white shadow-xl z-50 flex flex-col">
      <IssueDetailHeader
        issue={issue}
        onClose={onClose}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <IssueSummaryEditor
            issue={issue}
            onSave={actions.updateIssue}
            isSaving={state.isSaving}
          />

          <IssueDetailTabs
            issue={issue}
            comments={comments}
            history={history}
            onAddComment={actions.addComment}
          />
        </div>

        {/* Sidebar */}
        <IssueDetailSidebar
          issue={issue}
          transitions={transitions}
          onTransition={actions.executeTransition}
          onUpdate={actions.updateIssue}
        />
      </div>
    </div>
  );
}
```

### Issue Summary Editor with Inline Editing

```tsx
// components/issue-detail/IssueSummaryEditor.tsx
import { useState, useRef, useEffect } from 'react';
import { Issue } from '../../types';
import { Spinner } from '../ui';

interface IssueSummaryEditorProps {
  issue: Issue;
  onSave: (updates: Partial<Issue>) => Promise<void>;
  isSaving: boolean;
}

export function IssueSummaryEditor({
  issue,
  onSave,
  isSaving,
}: IssueSummaryEditorProps) {
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [summary, setSummary] = useState(issue.summary);
  const [description, setDescription] = useState(issue.description);
  const summaryRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditingSummary) summaryRef.current?.focus();
    if (isEditingDescription) descriptionRef.current?.focus();
  }, [isEditingSummary, isEditingDescription]);

  const handleSaveSummary = async () => {
    if (summary.trim() === issue.summary) {
      setIsEditingSummary(false);
      return;
    }

    try {
      await onSave({ summary: summary.trim() });
      setIsEditingSummary(false);
    } catch (error) {
      setSummary(issue.summary);  // Revert on error
    }
  };

  const handleSaveDescription = async () => {
    if (description === issue.description) {
      setIsEditingDescription(false);
      return;
    }

    try {
      await onSave({ description });
      setIsEditingDescription(false);
    } catch (error) {
      setDescription(issue.description);  // Revert on error
    }
  };

  return (
    <div className="space-y-4">
      {/* Summary */}
      {isEditingSummary ? (
        <div className="flex items-center gap-2">
          <input
            ref={summaryRef}
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onBlur={handleSaveSummary}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveSummary();
              if (e.key === 'Escape') {
                setSummary(issue.summary);
                setIsEditingSummary(false);
              }
            }}
            className="text-xl font-semibold w-full px-2 py-1 border rounded focus:ring-2 focus:ring-blue-500"
            disabled={isSaving}
          />
          {isSaving && <Spinner size="sm" />}
        </div>
      ) : (
        <h1
          className="text-xl font-semibold cursor-pointer hover:bg-gray-100 px-2 py-1 rounded -mx-2"
          onClick={() => setIsEditingSummary(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setIsEditingSummary(true)}
        >
          {issue.summary}
        </h1>
      )}

      {/* Description */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-gray-700">Description</h2>
        {isEditingDescription ? (
          <div>
            <textarea
              ref={descriptionRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              className="w-full px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500 resize-y"
              disabled={isSaving}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={handleSaveDescription}
                disabled={isSaving}
                className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {isSaving ? <Spinner size="sm" /> : 'Save'}
              </button>
              <button
                onClick={() => {
                  setDescription(issue.description);
                  setIsEditingDescription(false);
                }}
                className="px-3 py-1 border rounded hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            className="prose prose-sm max-w-none cursor-pointer hover:bg-gray-100 px-3 py-2 rounded min-h-[60px]"
            onClick={() => setIsEditingDescription(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setIsEditingDescription(true)}
          >
            {issue.description || (
              <span className="text-gray-400">Add a description...</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

### Issue Detail Sidebar

```tsx
// components/issue-detail/IssueDetailSidebar.tsx
import { Issue, Transition, User, Priority, Status } from '../../types';
import { Avatar, Select, PriorityIcon } from '../ui';

interface IssueDetailSidebarProps {
  issue: Issue;
  transitions: Transition[];
  onTransition: (transitionId: number) => Promise<void>;
  onUpdate: (updates: Partial<Issue>) => Promise<void>;
}

export function IssueDetailSidebar({
  issue,
  transitions,
  onTransition,
  onUpdate,
}: IssueDetailSidebarProps) {
  return (
    <div className="w-64 border-l bg-gray-50 p-4 space-y-6 overflow-y-auto">
      {/* Status with Transitions */}
      <div>
        <label className="text-xs font-medium text-gray-500 uppercase">
          Status
        </label>
        <StatusDropdown
          currentStatus={issue.status}
          transitions={transitions}
          onTransition={onTransition}
        />
      </div>

      {/* Assignee */}
      <div>
        <label className="text-xs font-medium text-gray-500 uppercase">
          Assignee
        </label>
        <AssigneeSelector
          assignee={issue.assignee}
          projectId={issue.projectId}
          onChange={(user) => onUpdate({ assignee: user })}
        />
      </div>

      {/* Priority */}
      <div>
        <label className="text-xs font-medium text-gray-500 uppercase">
          Priority
        </label>
        <PrioritySelector
          priority={issue.priority}
          onChange={(priority) => onUpdate({ priority })}
        />
      </div>

      {/* Story Points */}
      <div>
        <label className="text-xs font-medium text-gray-500 uppercase">
          Story Points
        </label>
        <StoryPointsInput
          value={issue.storyPoints}
          onChange={(points) => onUpdate({ storyPoints: points })}
        />
      </div>

      {/* Reporter (read-only) */}
      <div>
        <label className="text-xs font-medium text-gray-500 uppercase">
          Reporter
        </label>
        <div className="flex items-center gap-2 mt-1">
          <Avatar src={issue.reporter.avatarUrl} alt={issue.reporter.displayName} size="sm" />
          <span className="text-sm">{issue.reporter.displayName}</span>
        </div>
      </div>

      {/* Dates */}
      <div className="text-xs text-gray-500 space-y-1 pt-4 border-t">
        <p>Created: {new Date(issue.createdAt).toLocaleDateString()}</p>
        <p>Updated: {new Date(issue.updatedAt).toLocaleDateString()}</p>
      </div>
    </div>
  );
}

function StatusDropdown({
  currentStatus,
  transitions,
  onTransition,
}: {
  currentStatus: Status;
  transitions: Transition[];
  onTransition: (id: number) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const categoryColors = {
    todo: 'bg-gray-200 text-gray-700',
    in_progress: 'bg-blue-100 text-blue-700',
    done: 'bg-green-100 text-green-700',
  };

  return (
    <div className="relative mt-1">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'w-full px-3 py-2 rounded text-sm font-medium text-left flex items-center justify-between',
          categoryColors[currentStatus.category]
        )}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        {currentStatus.name}
        <ChevronDown className="w-4 h-4" />
      </button>

      {isOpen && (
        <ul
          className="absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg py-1"
          role="listbox"
        >
          {transitions.map((transition) => (
            <li
              key={transition.id}
              onClick={async () => {
                setIsOpen(false);
                await onTransition(transition.id);
              }}
              className="px-3 py-2 hover:bg-gray-100 cursor-pointer text-sm"
              role="option"
            >
              <span className="text-gray-600">{transition.name}</span>
              <span className="text-gray-400 ml-2">
                to {transition.to.name}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

---

## State Management (5 minutes)

### Board Store with Optimistic Updates

```typescript
// stores/boardStore.ts
import { create } from 'zustand';
import { api } from '../services/api';
import { Issue, BoardColumn } from '../types';

interface BoardState {
  columns: BoardColumn[];
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchBoard: (projectKey: string) => Promise<void>;
  moveIssue: (issueId: number, toStatusId: number) => Promise<void>;
  updateIssue: (issueId: number, updates: Partial<Issue>) => void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  columns: [],
  isLoading: false,
  error: null,

  fetchBoard: async (projectKey) => {
    set({ isLoading: true, error: null });
    try {
      const columns = await api.getBoard(projectKey);
      set({ columns, isLoading: false });
    } catch (error) {
      set({ error: 'Failed to load board', isLoading: false });
    }
  },

  moveIssue: async (issueId, toStatusId) => {
    const { columns } = get();

    // Find issue and its current column
    let issue: Issue | undefined;
    let fromColumnIndex = -1;

    for (let i = 0; i < columns.length; i++) {
      const found = columns[i].issues.find((iss) => iss.id === issueId);
      if (found) {
        issue = found;
        fromColumnIndex = i;
        break;
      }
    }

    if (!issue || issue.status.id === toStatusId) return;

    const toColumnIndex = columns.findIndex((col) => col.status.id === toStatusId);
    if (toColumnIndex === -1) return;

    // Optimistic update
    const updatedColumns = columns.map((col, index) => {
      if (index === fromColumnIndex) {
        return {
          ...col,
          issues: col.issues.filter((iss) => iss.id !== issueId),
        };
      }
      if (index === toColumnIndex) {
        const updatedIssue = { ...issue!, status: col.status };
        return {
          ...col,
          issues: [...col.issues, updatedIssue],
        };
      }
      return col;
    });

    set({ columns: updatedColumns });

    // Execute API call
    try {
      await api.transitionIssue(issueId, toStatusId);
    } catch (error) {
      // Rollback on failure
      set({ columns });
      throw error;
    }
  },

  updateIssue: (issueId, updates) => {
    const { columns } = get();

    const updatedColumns = columns.map((col) => ({
      ...col,
      issues: col.issues.map((issue) =>
        issue.id === issueId ? { ...issue, ...updates } : issue
      ),
    }));

    set({ columns: updatedColumns });
  },
}));
```

### Issue Detail Hook

```typescript
// hooks/useIssueDetail.ts
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { Issue, Transition, Comment, HistoryEntry } from '../types';
import { useBoardStore } from '../stores/boardStore';

interface IssueDetailState {
  issue: Issue | null;
  transitions: Transition[];
  comments: Comment[];
  history: HistoryEntry[];
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
}

export function useIssueDetail(issueKey: string) {
  const [state, setState] = useState<IssueDetailState>({
    issue: null,
    transitions: [],
    comments: [],
    history: [],
    isLoading: true,
    isSaving: false,
    error: null,
  });

  const boardStore = useBoardStore();

  // Fetch issue data
  const fetchIssue = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const [issue, transitions, comments, history] = await Promise.all([
        api.getIssue(issueKey),
        api.getAvailableTransitions(issueKey),
        api.getComments(issueKey),
        api.getHistory(issueKey),
      ]);
      setState({
        issue,
        transitions,
        comments,
        history,
        isLoading: false,
        isSaving: false,
        error: null,
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: 'Failed to load issue',
      }));
    }
  }, [issueKey]);

  useEffect(() => {
    fetchIssue();
  }, [fetchIssue]);

  // Actions
  const updateIssue = useCallback(async (updates: Partial<Issue>) => {
    if (!state.issue) return;

    const previousIssue = state.issue;

    // Optimistic update
    setState((prev) => ({
      ...prev,
      isSaving: true,
      issue: prev.issue ? { ...prev.issue, ...updates } : null,
    }));

    try {
      const updated = await api.updateIssue(issueKey, updates, state.issue.version);
      setState((prev) => ({
        ...prev,
        isSaving: false,
        issue: updated,
      }));
      boardStore.updateIssue(state.issue.id, updates);
    } catch (error: any) {
      // Rollback on failure
      setState((prev) => ({
        ...prev,
        isSaving: false,
        issue: previousIssue,
        error: error.message === 'Conflict'
          ? 'Issue was modified by another user. Please refresh.'
          : 'Failed to save changes',
      }));
      throw error;
    }
  }, [issueKey, state.issue, boardStore]);

  const executeTransition = useCallback(async (transitionId: number) => {
    if (!state.issue) return;

    try {
      await api.transitionIssue(state.issue.id, transitionId);
      await fetchIssue();  // Refresh to get new status and transitions
    } catch (error: any) {
      setState((prev) => ({
        ...prev,
        error: error.message || 'Transition failed',
      }));
      throw error;
    }
  }, [state.issue, fetchIssue]);

  const addComment = useCallback(async (body: string) => {
    if (!state.issue) return;

    try {
      const comment = await api.addComment(issueKey, body);
      setState((prev) => ({
        ...prev,
        comments: [...prev.comments, comment],
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: 'Failed to add comment',
      }));
      throw error;
    }
  }, [issueKey, state.issue]);

  return {
    state,
    actions: {
      updateIssue,
      executeTransition,
      addComment,
      refetch: fetchIssue,
    },
  };
}
```

---

## UI Primitives (3 minutes)

```tsx
// components/ui.tsx
import clsx from 'clsx';

// Issue Type Icons (SVG components)
export function IssueTypeIcon({ type, className }: { type: string; className?: string }) {
  const icons = {
    story: (
      <svg viewBox="0 0 16 16" fill="currentColor" className={clsx('text-green-600', className)}>
        <path d="M2 4h12v8H2z" />
      </svg>
    ),
    bug: (
      <svg viewBox="0 0 16 16" fill="currentColor" className={clsx('text-red-600', className)}>
        <circle cx="8" cy="8" r="6" />
      </svg>
    ),
    task: (
      <svg viewBox="0 0 16 16" fill="currentColor" className={clsx('text-blue-600', className)}>
        <rect x="2" y="2" width="12" height="12" rx="2" />
      </svg>
    ),
    epic: (
      <svg viewBox="0 0 16 16" fill="currentColor" className={clsx('text-purple-600', className)}>
        <path d="M8 1l7 14H1z" />
      </svg>
    ),
  };

  return icons[type] || icons.task;
}

// Priority Icons
export function PriorityIcon({ priority, className }: { priority: string; className?: string }) {
  const colors = {
    highest: 'text-red-600',
    high: 'text-orange-500',
    medium: 'text-yellow-500',
    low: 'text-blue-500',
    lowest: 'text-blue-300',
  };

  const arrows = {
    highest: '^^',
    high: '^',
    medium: '=',
    low: 'v',
    lowest: 'vv',
  };

  return (
    <span className={clsx(colors[priority], 'font-mono text-xs', className)}>
      {arrows[priority]}
    </span>
  );
}

// Avatar
export function Avatar({
  src,
  alt,
  size = 'md',
}: {
  src?: string;
  alt: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizes = {
    sm: 'w-6 h-6 text-xs',
    md: 'w-8 h-8 text-sm',
    lg: 'w-10 h-10 text-base',
  };

  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        className={clsx('rounded-full object-cover', sizes[size])}
      />
    );
  }

  const initials = alt
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase();

  return (
    <div
      className={clsx(
        'rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-medium',
        sizes[size]
      )}
      aria-label={alt}
    >
      {initials}
    </div>
  );
}

// Spinner
export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-8 h-8' };

  return (
    <svg
      className={clsx('animate-spin text-blue-600', sizes[size])}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
        className="opacity-25"
      />
      <path
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
```

---

## Accessibility Considerations

1. **Keyboard Navigation**: All interactive elements focusable, Enter/Escape handlers
2. **ARIA Labels**: Descriptive labels for boards, columns, and issue cards
3. **Focus Management**: Auto-focus on inline edit inputs, trap focus in modals
4. **Screen Reader**: Status announcements for drag operations and saves
5. **Color Contrast**: Status dots and priority icons have sufficient contrast

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Drag library | Native HTML5 | react-beautiful-dnd | Simpler, no extra dependencies |
| State | Zustand | Redux Toolkit | Lighter weight, less boilerplate |
| Inline editing | Custom | react-contenteditable | Full control over UX |
| Issue panel | Slide-out | Route/modal | Maintains board context |
| Optimistic updates | Manual rollback | TanStack Query | Finer control over UX |

---

## Summary

"I've designed Jira's frontend with:

1. **Board Component**: Drag-and-drop columns with visual feedback and accessibility
2. **Issue Cards**: Compact display with type, priority, assignee indicators
3. **Issue Detail Panel**: Slide-out with inline editing for summary/description
4. **Sidebar Fields**: Status transitions, assignee picker, priority selector
5. **Optimistic Updates**: Immediate UI feedback with automatic rollback on failure
6. **State Management**: Zustand stores for board and issue state with sync between components

The design prioritizes responsiveness through optimistic updates while maintaining data integrity with version-based conflict detection."
