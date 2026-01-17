import { useState, useEffect } from 'react';
import type { User, IssueType } from '../types';
import { Button, Input, Textarea, Select, IssueTypeIcon, Modal } from './ui';
import * as api from '../services/api';
import { useProjectStore, useIssueStore } from '../stores';

interface CreateIssueModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateIssueModal({ isOpen, onClose }: CreateIssueModalProps) {
  const { currentProject, sprints } = useProjectStore();
  const { fetchProjectIssues } = useIssueStore();

  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [issueType, setIssueType] = useState<IssueType>('task');
  const [priority, setPriority] = useState('medium');
  const [assigneeId, setAssigneeId] = useState('');
  const [sprintId, setSprintId] = useState('');
  const [storyPoints, setStoryPoints] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadUsers();
      // Reset form
      setSummary('');
      setDescription('');
      setIssueType('task');
      setPriority('medium');
      setAssigneeId('');
      setSprintId('');
      setStoryPoints('');
      setError('');
    }
  }, [isOpen]);

  const loadUsers = async () => {
    try {
      const usersData = await api.getUsers();
      setUsers(usersData);
    } catch (err) {
      console.error('Failed to load users:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!summary.trim()) {
      setError('Summary is required');
      return;
    }

    if (!currentProject) {
      setError('No project selected');
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      await api.createIssue({
        projectId: currentProject.id,
        summary: summary.trim(),
        description: description.trim() || undefined,
        issueType,
        priority,
        assigneeId: assigneeId || undefined,
        sprintId: sprintId ? parseInt(sprintId, 10) : undefined,
        storyPoints: storyPoints ? parseInt(storyPoints, 10) : undefined,
      });

      // Refresh issues
      await fetchProjectIssues(currentProject.id);
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to create issue');
    }

    setIsSubmitting(false);
  };

  const activeSprints = sprints.filter((s) => s.status === 'active' || s.status === 'future');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Issue" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>
        )}

        {/* Project */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Project</label>
          <div className="flex items-center gap-2 p-2 bg-gray-100 rounded">
            <div className="w-6 h-6 bg-blue-500 text-white rounded flex items-center justify-center text-xs font-medium">
              {currentProject?.key.slice(0, 2)}
            </div>
            <span>{currentProject?.name}</span>
          </div>
        </div>

        {/* Issue Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Issue Type</label>
          <div className="flex gap-2">
            {(['task', 'story', 'bug', 'epic'] as IssueType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setIssueType(type)}
                className={`flex items-center gap-2 px-3 py-2 rounded border ${
                  issueType === type
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <IssueTypeIcon type={type} />
                <span className="capitalize">{type}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Summary */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Summary <span className="text-red-500">*</span>
          </label>
          <Input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="What needs to be done?"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add a description..."
            rows={4}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Priority */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              options={[
                { value: 'highest', label: 'Highest' },
                { value: 'high', label: 'High' },
                { value: 'medium', label: 'Medium' },
                { value: 'low', label: 'Low' },
                { value: 'lowest', label: 'Lowest' },
              ]}
            />
          </div>

          {/* Assignee */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Assignee</label>
            <Select
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              options={[
                { value: '', label: 'Unassigned' },
                ...users.map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
          </div>

          {/* Sprint */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Sprint</label>
            <Select
              value={sprintId}
              onChange={(e) => setSprintId(e.target.value)}
              options={[
                { value: '', label: 'Backlog' },
                ...activeSprints.map((s) => ({ value: s.id.toString(), label: s.name })),
              ]}
            />
          </div>

          {/* Story Points */}
          {issueType !== 'epic' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Story Points</label>
              <Select
                value={storyPoints}
                onChange={(e) => setStoryPoints(e.target.value)}
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
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Create Issue'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
