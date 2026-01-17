import { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';
import type { IssueWithDetails, Comment, IssueHistory, Transition, User } from '../types';
import { IssueTypeIcon, PriorityIcon, StatusBadge, Avatar, Button, Textarea, Spinner, Select } from './ui';
import * as api from '../services/api';
import { useIssueStore } from '../stores';

interface IssueDetailProps {
  issue: IssueWithDetails;
  onClose: () => void;
}

export function IssueDetail({ issue: initialIssue, onClose }: IssueDetailProps) {
  const { updateIssueInList } = useIssueStore();
  const [issue, setIssue] = useState(initialIssue);
  const [comments, setComments] = useState<Comment[]>([]);
  const [history, setHistory] = useState<IssueHistory[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [activeTab, setActiveTab] = useState<'comments' | 'history'>('comments');
  const [newComment, setNewComment] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedSummary, setEditedSummary] = useState(issue.summary);
  const [editedDescription, setEditedDescription] = useState(issue.description || '');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, [issue.id]);

  const loadData = async () => {
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
  };

  const handleSave = async () => {
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
  };

  const handleTransition = async (transitionId: number) => {
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
  };

  const handleAssigneeChange = async (assigneeId: string) => {
    try {
      const updated = await api.updateIssue(issue.id, {
        assigneeId: assigneeId || null,
      });
      setIssue(updated);
      updateIssueInList(updated);
    } catch (error) {
      console.error('Failed to update assignee:', error);
    }
  };

  const handlePriorityChange = async (priority: string) => {
    try {
      const updated = await api.updateIssue(issue.id, { priority });
      setIssue(updated);
      updateIssueInList(updated);
    } catch (error) {
      console.error('Failed to update priority:', error);
    }
  };

  const handleStoryPointsChange = async (points: string) => {
    try {
      const updated = await api.updateIssue(issue.id, {
        storyPoints: points ? parseInt(points, 10) : null,
      });
      setIssue(updated);
      updateIssueInList(updated);
    } catch (error) {
      console.error('Failed to update story points:', error);
    }
  };

  const handleAddComment = async () => {
    if (!newComment.trim()) return;
    try {
      const comment = await api.addComment(issue.id, newComment);
      setComments([...comments, { ...comment, author: users.find((u) => u.id === comment.author_id)! }]);
      setNewComment('');
    } catch (error) {
      console.error('Failed to add comment:', error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-black bg-opacity-50" onClick={onClose} />

      <div className="absolute inset-y-0 right-0 w-full max-w-4xl bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-3">
            <IssueTypeIcon type={issue.issue_type} className="w-5 h-5" />
            <span className="font-medium text-gray-500">{issue.key}</span>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="grid grid-cols-3 gap-6 p-6">
              {/* Main content */}
              <div className="col-span-2 space-y-6">
                {/* Summary */}
                {isEditing ? (
                  <input
                    type="text"
                    value={editedSummary}
                    onChange={(e) => setEditedSummary(e.target.value)}
                    className="w-full text-2xl font-semibold border-b border-blue-500 focus:outline-none pb-2"
                  />
                ) : (
                  <h1
                    className="text-2xl font-semibold text-gray-900 cursor-pointer hover:text-blue-600"
                    onClick={() => setIsEditing(true)}
                  >
                    {issue.summary}
                  </h1>
                )}

                {/* Description */}
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Description</h3>
                  {isEditing ? (
                    <Textarea
                      value={editedDescription}
                      onChange={(e) => setEditedDescription(e.target.value)}
                      rows={6}
                      placeholder="Add a description..."
                    />
                  ) : (
                    <div
                      className="text-gray-700 min-h-[100px] cursor-pointer hover:bg-gray-50 p-2 rounded"
                      onClick={() => setIsEditing(true)}
                    >
                      {issue.description || (
                        <span className="text-gray-400 italic">Click to add description...</span>
                      )}
                    </div>
                  )}
                </div>

                {isEditing && (
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={handleSave} disabled={isSaving}>
                      {isSaving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setIsEditing(false);
                        setEditedSummary(issue.summary);
                        setEditedDescription(issue.description || '');
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}

                {/* Tabs */}
                <div className="border-b">
                  <nav className="flex gap-4">
                    <button
                      onClick={() => setActiveTab('comments')}
                      className={clsx(
                        'py-2 px-1 border-b-2 font-medium text-sm',
                        activeTab === 'comments'
                          ? 'border-blue-500 text-blue-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700'
                      )}
                    >
                      Comments ({comments.length})
                    </button>
                    <button
                      onClick={() => setActiveTab('history')}
                      className={clsx(
                        'py-2 px-1 border-b-2 font-medium text-sm',
                        activeTab === 'history'
                          ? 'border-blue-500 text-blue-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700'
                      )}
                    >
                      History ({history.length})
                    </button>
                  </nav>
                </div>

                {/* Tab content */}
                {activeTab === 'comments' && (
                  <div className="space-y-4">
                    {/* Add comment */}
                    <div className="flex gap-3">
                      <Avatar user={issue.reporter} />
                      <div className="flex-1">
                        <Textarea
                          value={newComment}
                          onChange={(e) => setNewComment(e.target.value)}
                          placeholder="Add a comment..."
                          rows={3}
                        />
                        <div className="mt-2">
                          <Button size="sm" onClick={handleAddComment} disabled={!newComment.trim()}>
                            Add Comment
                          </Button>
                        </div>
                      </div>
                    </div>

                    {/* Comments list */}
                    {comments.map((comment) => (
                      <div key={comment.id} className="flex gap-3">
                        <Avatar user={comment.author} />
                        <div className="flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="font-medium text-gray-900">{comment.author.name}</span>
                            <span className="text-sm text-gray-500">
                              {formatDistanceToNow(new Date(comment.created_at), { addSuffix: true })}
                            </span>
                          </div>
                          <p className="text-gray-700 mt-1">{comment.body}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {activeTab === 'history' && (
                  <div className="space-y-3">
                    {history.map((entry) => (
                      <div key={entry.id} className="flex gap-3 text-sm">
                        <Avatar user={entry.user} size="sm" />
                        <div>
                          <span className="font-medium text-gray-900">{entry.user.name}</span>
                          <span className="text-gray-500"> changed </span>
                          <span className="font-medium text-gray-700">{entry.field}</span>
                          {entry.old_value && (
                            <>
                              <span className="text-gray-500"> from </span>
                              <span className="text-gray-700">{entry.old_value}</span>
                            </>
                          )}
                          {entry.new_value && (
                            <>
                              <span className="text-gray-500"> to </span>
                              <span className="text-gray-700">{entry.new_value}</span>
                            </>
                          )}
                          <div className="text-gray-400 text-xs">
                            {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Sidebar */}
              <div className="space-y-6">
                {/* Status & Transitions */}
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Status</h3>
                  <StatusBadge name={issue.status.name} category={issue.status.category} />

                  {transitions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {transitions.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => handleTransition(t.id)}
                          className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-600"
                        >
                          {t.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Assignee */}
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Assignee</h3>
                  <Select
                    value={issue.assignee_id || ''}
                    onChange={(e) => handleAssigneeChange(e.target.value)}
                    options={[
                      { value: '', label: 'Unassigned' },
                      ...users.map((u) => ({ value: u.id, label: u.name })),
                    ]}
                  />
                </div>

                {/* Reporter */}
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Reporter</h3>
                  <div className="flex items-center gap-2">
                    <Avatar user={issue.reporter} size="sm" />
                    <span className="text-gray-700">{issue.reporter.name}</span>
                  </div>
                </div>

                {/* Priority */}
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Priority</h3>
                  <Select
                    value={issue.priority}
                    onChange={(e) => handlePriorityChange(e.target.value)}
                    options={[
                      { value: 'highest', label: 'Highest' },
                      { value: 'high', label: 'High' },
                      { value: 'medium', label: 'Medium' },
                      { value: 'low', label: 'Low' },
                      { value: 'lowest', label: 'Lowest' },
                    ]}
                  />
                </div>

                {/* Story Points */}
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Story Points</h3>
                  <Select
                    value={issue.story_points?.toString() || ''}
                    onChange={(e) => handleStoryPointsChange(e.target.value)}
                    options={[
                      { value: '', label: 'None' },
                      { value: '1', label: '1' },
                      { value: '2', label: '2' },
                      { value: '3', label: '3' },
                      { value: '5', label: '5' },
                      { value: '8', label: '8' },
                      { value: '13', label: '13' },
                      { value: '21', label: '21' },
                    ]}
                  />
                </div>

                {/* Epic */}
                {issue.epic && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-2">Epic</h3>
                    <div className="text-sm px-2 py-1 bg-purple-100 text-purple-700 rounded inline-flex items-center gap-1">
                      <IssueTypeIcon type="epic" className="w-3 h-3" />
                      {issue.epic.key}: {issue.epic.summary}
                    </div>
                  </div>
                )}

                {/* Sprint */}
                {issue.sprint && (
                  <div>
                    <h3 className="text-sm font-medium text-gray-500 mb-2">Sprint</h3>
                    <span className="text-gray-700">{issue.sprint.name}</span>
                  </div>
                )}

                {/* Dates */}
                <div className="text-sm text-gray-500 space-y-1">
                  <div>Created: {formatDistanceToNow(new Date(issue.created_at), { addSuffix: true })}</div>
                  <div>Updated: {formatDistanceToNow(new Date(issue.updated_at), { addSuffix: true })}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
