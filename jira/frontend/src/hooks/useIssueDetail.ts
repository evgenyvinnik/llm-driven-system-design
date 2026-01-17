import { useState, useEffect, useCallback } from 'react';
import type { IssueWithDetails, Comment, IssueHistory, Transition, User } from '../types';
import * as api from '../services/api';
import { useIssueStore } from '../stores';

/**
 * State returned by the useIssueDetail hook.
 */
interface IssueDetailState {
  /** The current issue data */
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
}

/**
 * Actions returned by the useIssueDetail hook.
 */
interface IssueDetailActions {
  /** Starts editing the issue summary and description */
  startEditing: () => void;
  /** Cancels editing and reverts changes */
  cancelEditing: () => void;
  /** Sets the edited summary value */
  setEditedSummary: (value: string) => void;
  /** Sets the edited description value */
  setEditedDescription: (value: string) => void;
  /** Saves the edited summary and description */
  saveChanges: () => Promise<void>;
  /** Executes a status transition */
  executeTransition: (transitionId: number) => Promise<void>;
  /** Changes the issue assignee */
  changeAssignee: (assigneeId: string) => Promise<void>;
  /** Changes the issue priority */
  changePriority: (priority: string) => Promise<void>;
  /** Changes the issue story points */
  changeStoryPoints: (points: string) => Promise<void>;
  /** Adds a new comment to the issue */
  addComment: (body: string) => Promise<void>;
}

/**
 * Custom hook for managing issue detail state and operations.
 *
 * Handles all data fetching, state management, and API calls for
 * the issue detail view. Centralizes logic that was previously
 * spread across the IssueDetail component.
 *
 * @param initialIssue - The initial issue data
 * @returns An object containing state and actions
 *
 * @example
 * ```tsx
 * const { state, actions } = useIssueDetail(issue);
 *
 * // Access state
 * console.log(state.comments);
 *
 * // Trigger actions
 * await actions.saveChanges();
 * ```
 */
export function useIssueDetail(initialIssue: IssueWithDetails): {
  state: IssueDetailState;
  actions: IssueDetailActions;
} {
  const { updateIssueInList } = useIssueStore();

  // Core state
  const [issue, setIssue] = useState(initialIssue);
  const [comments, setComments] = useState<Comment[]>([]);
  const [history, setHistory] = useState<IssueHistory[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  // UI state
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // Edit state
  const [editedSummary, setEditedSummary] = useState(initialIssue.summary);
  const [editedDescription, setEditedDescription] = useState(initialIssue.description || '');

  /**
   * Loads all related data for the issue.
   */
  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [commentsData, historyData, transitionsData, usersData] = await Promise.all([
        api.getIssueComments(issue.id),
        api.getIssueHistory(issue.id),
        api.getIssueTransitions(issue.id),
        api.getUsers(),
      ]);
      setComments(commentsData);
      setHistory(historyData);
      setTransitions(transitionsData);
      setUsers(usersData);
    } catch (error) {
      console.error('Failed to load issue data:', error);
    }
    setIsLoading(false);
  }, [issue.id]);

  // Load data when issue ID changes
  useEffect(() => {
    loadData();
  }, [loadData]);

  /**
   * Starts editing mode.
   */
  const startEditing = useCallback(() => {
    setIsEditing(true);
  }, []);

  /**
   * Cancels editing and reverts to original values.
   */
  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setEditedSummary(issue.summary);
    setEditedDescription(issue.description || '');
  }, [issue.summary, issue.description]);

  /**
   * Saves the edited summary and description.
   */
  const saveChanges = useCallback(async () => {
    setIsSaving(true);
    try {
      const updated = await api.updateIssue(issue.id, {
        summary: editedSummary,
        description: editedDescription,
      });
      setIssue(updated);
      updateIssueInList(updated);
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to update issue:', error);
    }
    setIsSaving(false);
  }, [issue.id, editedSummary, editedDescription, updateIssueInList]);

  /**
   * Executes a status transition.
   */
  const executeTransition = useCallback(
    async (transitionId: number) => {
      try {
        const updated = await api.executeTransition(issue.id, transitionId);
        setIssue(updated);
        updateIssueInList(updated);
        // Reload transitions for new status
        const newTransitions = await api.getIssueTransitions(issue.id);
        setTransitions(newTransitions);
      } catch (error) {
        console.error('Failed to execute transition:', error);
      }
    },
    [issue.id, updateIssueInList]
  );

  /**
   * Changes the issue assignee.
   */
  const changeAssignee = useCallback(
    async (assigneeId: string) => {
      try {
        const updated = await api.updateIssue(issue.id, {
          assigneeId: assigneeId || null,
        });
        setIssue(updated);
        updateIssueInList(updated);
      } catch (error) {
        console.error('Failed to update assignee:', error);
      }
    },
    [issue.id, updateIssueInList]
  );

  /**
   * Changes the issue priority.
   */
  const changePriority = useCallback(
    async (priority: string) => {
      try {
        const updated = await api.updateIssue(issue.id, { priority });
        setIssue(updated);
        updateIssueInList(updated);
      } catch (error) {
        console.error('Failed to update priority:', error);
      }
    },
    [issue.id, updateIssueInList]
  );

  /**
   * Changes the issue story points.
   */
  const changeStoryPoints = useCallback(
    async (points: string) => {
      try {
        const updated = await api.updateIssue(issue.id, {
          storyPoints: points ? parseInt(points, 10) : null,
        });
        setIssue(updated);
        updateIssueInList(updated);
      } catch (error) {
        console.error('Failed to update story points:', error);
      }
    },
    [issue.id, updateIssueInList]
  );

  /**
   * Adds a new comment to the issue.
   */
  const addComment = useCallback(
    async (body: string) => {
      if (!body.trim()) return;
      try {
        const comment = await api.addComment(issue.id, body);
        setComments((prev) => [
          ...prev,
          { ...comment, author: users.find((u) => u.id === comment.author_id)! },
        ]);
      } catch (error) {
        console.error('Failed to add comment:', error);
      }
    },
    [issue.id, users]
  );

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
    },
  };
}
