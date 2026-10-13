import { useState, useEffect, useCallback, useRef } from 'react';
import type { IssueWithDetails, Comment, IssueHistory, Transition, User } from '../types';
import * as api from '../services/api';
import { ApiError, isUncertainFailure } from '../services/api';
import { useIssueStore } from '../stores';
import { newIdempotencyKey } from '../utils/idempotency';

/**
 * State returned by the useIssueDetail hook.
 */
interface IssueDetailState {
  /** The current issue data (including its version) */
  issue: IssueWithDetails;
  /** Comments on the issue */
  comments: Comment[];
  /** History entries for the issue */
  history: IssueHistory[];
  /** Available transitions from current status */
  transitions: Transition[];
  /** All users (for assignee selection) */
  users: User[];
  /** Whether initial data is loading */
  isLoading: boolean;
  /** Whether a save operation is in progress */
  isSaving: boolean;
  /** Whether the editor is in edit mode */
  isEditing: boolean;
  /** Current edited summary value */
  editedSummary: string;
  /** Current edited description value */
  editedDescription: string;
  /** Last failure or conflict explanation, shown in an alert region */
  error: string | null;
}

/**
 * Actions returned by the useIssueDetail hook.
 */
interface IssueDetailActions {
  startEditing: () => void;
  cancelEditing: () => void;
  setEditedSummary: (value: string) => void;
  setEditedDescription: (value: string) => void;
  saveChanges: () => Promise<void>;
  executeTransition: (transitionId: number) => Promise<void>;
  changeAssignee: (assigneeId: string) => Promise<void>;
  changePriority: (priority: string) => Promise<void>;
  changeStoryPoints: (points: string) => Promise<void>;
  addComment: (body: string) => Promise<boolean>;
  dismissError: () => void;
}

type IssueUpdate = Parameters<typeof api.updateIssue>[1];

const CONFLICT_MESSAGE =
  'Someone else changed this issue while you had it open, so your change was not saved. ' +
  'The latest version is shown; apply your change again if it still makes sense.';

/**
 * Custom hook for managing issue detail state and operations.
 *
 * Every edit sends the version the user is looking at (If-Match). If someone else saved
 * first, the server answers 412 with the current issue: the hook shows that version and
 * keeps the user's unsaved text, instead of silently overwriting the other person's work.
 *
 * @param initialIssue - The initial issue data
 * @returns An object containing state and actions
 */
export function useIssueDetail(initialIssue: IssueWithDetails): {
  state: IssueDetailState;
  actions: IssueDetailActions;
} {
  const { updateIssueInList } = useIssueStore();

  const [issue, setIssue] = useState(initialIssue);
  const [comments, setComments] = useState<Comment[]>([]);
  const [history, setHistory] = useState<IssueHistory[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editedSummary, setEditedSummary] = useState(initialIssue.summary);
  const [editedDescription, setEditedDescription] = useState(initialIssue.description || '');

  /** Idempotency key of the comment draft being submitted, reused only for its retries. */
  const commentKey = useRef<{ body: string; key: string } | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [fresh, commentsData, historyData, transitionsData, usersData] = await Promise.all([
        api.getIssue(issue.id),
        api.getIssueComments(issue.id),
        api.getIssueHistory(issue.id),
        api.getIssueTransitions(issue.id),
        api.getUsers(),
      ]);
      setIssue(fresh);
      setComments(commentsData);
      setHistory(historyData);
      setTransitions(transitionsData);
      setUsers(usersData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the issue');
    }
    setIsLoading(false);
  }, [issue.id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /** Shows the server's copy of the issue everywhere it is displayed. */
  const applyIssue = useCallback(
    (next: IssueWithDetails) => {
      setIssue(next);
      updateIssueInList(next);
    },
    [updateIssueInList]
  );

  /** History and transitions depend on the issue's current state; refresh them after a change. */
  const refreshDerived = useCallback(async () => {
    const [historyData, transitionsData] = await Promise.all([
      api.getIssueHistory(issue.id),
      api.getIssueTransitions(issue.id),
    ]);
    setHistory(historyData);
    setTransitions(transitionsData);
  }, [issue.id]);

  /**
   * Saves fields with the version the user saw. Returns true on success. On 412 it shows
   * the current issue and returns false so the caller can keep the user's draft.
   */
  const saveFields = useCallback(
    async (updates: IssueUpdate): Promise<boolean> => {
      setError(null);
      try {
        const updated = await api.updateIssue(issue.id, updates, issue.version);
        applyIssue(updated);
        refreshDerived().catch(() => {});
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 412 && err.body.issue) {
          applyIssue(err.body.issue as IssueWithDetails);
          refreshDerived().catch(() => {});
          setError(CONFLICT_MESSAGE);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to save');
        }
        return false;
      }
    },
    [issue.id, issue.version, applyIssue, refreshDerived]
  );

  const startEditing = useCallback(() => {
    setEditedSummary(issue.summary);
    setEditedDescription(issue.description || '');
    setIsEditing(true);
  }, [issue.summary, issue.description]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setEditedSummary(issue.summary);
    setEditedDescription(issue.description || '');
  }, [issue.summary, issue.description]);

  const saveChanges = useCallback(async () => {
    setIsSaving(true);
    const saved = await saveFields({ summary: editedSummary, description: editedDescription || null });
    // On a conflict the draft stays in the editor so nothing the user typed is lost.
    if (saved) setIsEditing(false);
    setIsSaving(false);
  }, [saveFields, editedSummary, editedDescription]);

  const executeTransition = useCallback(
    async (transitionId: number) => {
      setError(null);
      try {
        const updated = await api.executeTransition(issue.id, transitionId);
        applyIssue(updated);
        await refreshDerived();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // The issue moved under us: show where it is now and what can be done from there.
          applyIssue(await api.getIssue(issue.id));
          await refreshDerived();
        }
        setError(err instanceof Error ? err.message : 'Failed to change the status');
      }
    },
    [issue.id, applyIssue, refreshDerived]
  );

  const changeAssignee = useCallback(
    async (assigneeId: string) => {
      await saveFields({ assigneeId: assigneeId || null });
    },
    [saveFields]
  );

  const changePriority = useCallback(
    async (priority: string) => {
      await saveFields({ priority });
    },
    [saveFields]
  );

  const changeStoryPoints = useCallback(
    async (points: string) => {
      await saveFields({ storyPoints: points ? parseInt(points, 10) : null });
    },
    [saveFields]
  );

  const addComment = useCallback(
    async (body: string): Promise<boolean> => {
      if (!body.trim()) return false;
      setError(null);
      // Same draft as a failed attempt whose outcome is unknown: reuse its key, so a
      // retry cannot post the comment twice.
      if (commentKey.current?.body !== body) commentKey.current = { body, key: newIdempotencyKey() };
      try {
        const comment = await api.addComment(issue.id, body, commentKey.current.key);
        commentKey.current = null;
        setComments((prev) => [...prev, { ...comment, author: users.find((u) => u.id === comment.author_id)! }]);
        return true;
      } catch (err) {
        if (!isUncertainFailure(err)) commentKey.current = null;
        setError(err instanceof Error ? err.message : 'Failed to add the comment');
        return false;
      }
    },
    [issue.id, users]
  );

  const dismissError = useCallback(() => setError(null), []);

  return {
    state: {
      issue,
      comments,
      history,
      transitions,
      users,
      isLoading,
      isSaving,
      isEditing,
      editedSummary,
      editedDescription,
      error,
    },
    actions: {
      startEditing,
      cancelEditing,
      setEditedSummary,
      setEditedDescription,
      saveChanges,
      executeTransition,
      changeAssignee,
      changePriority,
      changeStoryPoints,
      addComment,
      dismissError,
    },
  };
}
