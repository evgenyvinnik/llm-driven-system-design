import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useProjectStore, useIssueStore, useUIStore } from '../../../stores';
import { Backlog } from '../../../components/Board';
import { IssueDetail } from '../../../components/IssueDetail';
import { Button, Spinner, Modal, Input, Textarea } from '../../../components/ui';
import type { IssueWithDetails } from '../../../types';
import * as api from '../../../services/api';

export const Route = createFileRoute('/projects/$projectKey/backlog')({
  component: BacklogPage,
});

function BacklogPage() {
  const { currentProject, sprints, fetchProjectDetails } = useProjectStore();
  const { backlog, issues, fetchBacklog, fetchSprintIssues, isLoading } = useIssueStore();
  const { setCreateIssueModalOpen } = useUIStore();

  const [selectedIssue, setSelectedIssue] = useState<IssueWithDetails | null>(null);
  const [showSprintModal, setShowSprintModal] = useState(false);

  const activeSprint = sprints.find((s) => s.status === 'active');
  const futureSprints = sprints.filter((s) => s.status === 'future');

  useEffect(() => {
    if (currentProject) {
      fetchBacklog(currentProject.id);
      if (activeSprint) {
        fetchSprintIssues(activeSprint.id);
      }
    }
  }, [currentProject, activeSprint, fetchBacklog, fetchSprintIssues]);

  const handleStartSprint = async (sprintId: number) => {
    try {
      await api.startSprint(sprintId);
      if (currentProject) {
        await fetchProjectDetails(currentProject.id);
      }
    } catch (error) {
      console.error('Failed to start sprint:', error);
    }
  };

  const handleCompleteSprint = async (sprintId: number) => {
    try {
      await api.completeSprint(sprintId);
      if (currentProject) {
        await fetchProjectDetails(currentProject.id);
        fetchBacklog(currentProject.id);
      }
    } catch (error) {
      console.error('Failed to complete sprint:', error);
    }
  };

  if (!currentProject) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{currentProject.name} Backlog</h1>
          <p className="text-gray-500">Plan and prioritize your work</p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setShowSprintModal(true)}>
            Create Sprint
          </Button>
          {futureSprints.length > 0 && !activeSprint && (
            <Button onClick={() => handleStartSprint(futureSprints[0].id)}>
              Start Sprint
            </Button>
          )}
          {activeSprint && (
            <Button variant="secondary" onClick={() => handleCompleteSprint(activeSprint.id)}>
              Complete Sprint
            </Button>
          )}
          <Button onClick={() => setCreateIssueModalOpen(true)}>Create Issue</Button>
        </div>
      </div>

      <Backlog
        backlogIssues={backlog}
        sprintIssues={issues}
        sprintName={activeSprint?.name}
        sprintId={activeSprint?.id}
        onIssueClick={setSelectedIssue}
        isLoading={isLoading}
      />

      {selectedIssue && (
        <IssueDetail
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
        />
      )}

      <CreateSprintModal
        isOpen={showSprintModal}
        onClose={() => setShowSprintModal(false)}
        projectId={currentProject.id}
        onCreated={() => {
          setShowSprintModal(false);
          fetchProjectDetails(currentProject.id);
        }}
      />
    </div>
  );
}

function CreateSprintModal({
  isOpen,
  onClose,
  projectId,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      setError('Sprint name is required');
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      await api.createSprint(projectId, name.trim(), goal.trim() || undefined);
      setName('');
      setGoal('');
      onCreated();
    } catch (err) {
      setError((err as Error).message || 'Failed to create sprint');
    }

    setIsSubmitting(false);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Sprint" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Sprint Name <span className="text-red-500">*</span>
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sprint 1"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Goal</label>
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="What do you want to achieve in this sprint?"
            rows={3}
          />
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Create Sprint'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
