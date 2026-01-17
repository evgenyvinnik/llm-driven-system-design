import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useProjectStore, useIssueStore, useUIStore } from '../../../stores';
import { KanbanBoard } from '../../../components/Board';
import { IssueDetail } from '../../../components/IssueDetail';
import { Button, Spinner, Select } from '../../../components/ui';
import type { IssueWithDetails } from '../../../types';
import * as api from '../../../services/api';

export const Route = createFileRoute('/projects/$projectKey/board')({
  component: BoardPage,
});

function BoardPage() {
  const { currentProject, workflow, sprints } = useProjectStore();
  const { issues, fetchProjectIssues, fetchSprintIssues, isLoading } = useIssueStore();
  const { setCreateIssueModalOpen } = useUIStore();

  const [selectedSprint, setSelectedSprint] = useState<string>('all');
  const [selectedIssue, setSelectedIssue] = useState<IssueWithDetails | null>(null);

  const activeSprint = sprints.find((s) => s.status === 'active');

  useEffect(() => {
    if (currentProject) {
      if (selectedSprint === 'all') {
        fetchProjectIssues(currentProject.id);
      } else if (selectedSprint && selectedSprint !== 'all') {
        fetchSprintIssues(parseInt(selectedSprint, 10));
      }
    }
  }, [currentProject, selectedSprint, fetchProjectIssues, fetchSprintIssues]);

  // Auto-select active sprint if available
  useEffect(() => {
    if (activeSprint && selectedSprint === 'all') {
      setSelectedSprint(activeSprint.id.toString());
    }
  }, [activeSprint]);

  if (!currentProject || !workflow) {
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
          <h1 className="text-2xl font-bold text-gray-900">{currentProject.name} Board</h1>
          <p className="text-gray-500">
            {selectedSprint !== 'all'
              ? sprints.find((s) => s.id.toString() === selectedSprint)?.name
              : 'All issues'}
          </p>
        </div>

        <div className="flex items-center gap-4">
          <Select
            value={selectedSprint}
            onChange={(e) => setSelectedSprint(e.target.value)}
            options={[
              { value: 'all', label: 'All Issues' },
              ...sprints.map((s) => ({
                value: s.id.toString(),
                label: `${s.name} ${s.status === 'active' ? '(Active)' : ''}`,
              })),
            ]}
            className="w-48"
          />
          <Button onClick={() => setCreateIssueModalOpen(true)}>Create Issue</Button>
        </div>
      </div>

      <KanbanBoard
        issues={issues}
        workflow={workflow}
        onIssueClick={setSelectedIssue}
        isLoading={isLoading}
      />

      {selectedIssue && (
        <IssueDetail
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
        />
      )}
    </div>
  );
}
