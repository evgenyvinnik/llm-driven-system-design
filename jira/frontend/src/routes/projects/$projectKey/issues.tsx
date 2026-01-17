import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useProjectStore, useIssueStore, useUIStore } from '../../../stores';
import { IssueDetail } from '../../../components/IssueDetail';
import { Button, Spinner, IssueTypeIcon, PriorityIcon, Avatar, Input, Select } from '../../../components/ui';
import type { IssueWithDetails, IssueType } from '../../../types';
import * as api from '../../../services/api';

export const Route = createFileRoute('/projects/$projectKey/issues')({
  component: IssuesPage,
});

function IssuesPage() {
  const { currentProject, workflow } = useProjectStore();
  const { issues, fetchProjectIssues, isLoading } = useIssueStore();
  const { setCreateIssueModalOpen } = useUIStore();

  const [selectedIssue, setSelectedIssue] = useState<IssueWithDetails | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');

  useEffect(() => {
    if (currentProject) {
      fetchProjectIssues(currentProject.id, {
        statusId: statusFilter ? parseInt(statusFilter, 10) : undefined,
        issueType: typeFilter as IssueType | undefined,
      });
    }
  }, [currentProject, statusFilter, typeFilter, fetchProjectIssues]);

  const filteredIssues = searchQuery
    ? issues.filter(
        (i) =>
          i.key.toLowerCase().includes(searchQuery.toLowerCase()) ||
          i.summary.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : issues;

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
          <h1 className="text-2xl font-bold text-gray-900">{currentProject.name} Issues</h1>
          <p className="text-gray-500">{filteredIssues.length} issues</p>
        </div>
        <Button onClick={() => setCreateIssueModalOpen(true)}>Create Issue</Button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border p-4 mb-4">
        <div className="flex gap-4">
          <div className="flex-1">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search issues..."
            />
          </div>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: '', label: 'All Statuses' },
              ...workflow.statuses.map((s) => ({ value: s.id.toString(), label: s.name })),
            ]}
            className="w-40"
          />
          <Select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            options={[
              { value: '', label: 'All Types' },
              { value: 'bug', label: 'Bug' },
              { value: 'story', label: 'Story' },
              { value: 'task', label: 'Task' },
              { value: 'epic', label: 'Epic' },
            ]}
            className="w-32"
          />
        </div>
      </div>

      {/* Issues table */}
      <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Spinner />
          </div>
        ) : filteredIssues.length === 0 ? (
          <div className="text-center text-gray-500 py-12">No issues found</div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Type</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Key</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Summary</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Status</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Priority</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Assignee</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredIssues.map((issue) => (
                <tr
                  key={issue.id}
                  onClick={() => setSelectedIssue(issue)}
                  className="hover:bg-gray-50 cursor-pointer"
                >
                  <td className="px-4 py-3">
                    <IssueTypeIcon type={issue.issue_type} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm font-medium text-blue-600">{issue.key}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-gray-900">{issue.summary}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                        issue.status.category === 'todo'
                          ? 'bg-gray-200 text-gray-700'
                          : issue.status.category === 'in_progress'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-green-100 text-green-700'
                      }`}
                    >
                      {issue.status.name}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <PriorityIcon priority={issue.priority} />
                  </td>
                  <td className="px-4 py-3">
                    {issue.assignee ? (
                      <div className="flex items-center gap-2">
                        <Avatar user={issue.assignee} size="sm" />
                        <span className="text-sm text-gray-600">{issue.assignee.name}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-gray-400">Unassigned</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedIssue && (
        <IssueDetail issue={selectedIssue} onClose={() => setSelectedIssue(null)} />
      )}
    </div>
  );
}
