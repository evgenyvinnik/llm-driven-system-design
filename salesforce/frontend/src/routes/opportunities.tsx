import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useCallback, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useCrmStore } from '../stores/crmStore';
import { KanbanBoard } from '../components/KanbanBoard';
import { EntityForm } from '../components/EntityForm';
import { accountsApi, opportunitiesApi } from '../services/api';

/** Dollars typed into the form -> integer cents for the API (money is cents end to end). */
function dollarsToCents(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const dollars = Number(value);
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error('Amount must be a positive number');
  return Math.round(dollars * 100);
}

function OpportunitiesPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const {
    opportunities, opportunitiesLoading, opportunitiesError,
    fetchOpportunities, updateOpportunityStage, clearOpportunitiesError,
  } = useCrmStore();
  const [showForm, setShowForm] = useState(false);
  const [accountOptions, setAccountOptions] = useState<{ id: string; name: string }[]>([]);

  const loadOpportunities = useCallback(() => {
    fetchOpportunities({ limit: 200 });
  }, [fetchOpportunities]);

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
      return;
    }
    loadOpportunities();
  }, [user, navigate, loadOpportunities]);

  if (!user) return null;

  // The store moves the card optimistically and reverts it (with the server's
  // reason) on failure, so there is no need to reload the whole board.
  const handleStageChange = (id: string, stage: string) => updateOpportunityStage(id, stage);

  const handleShowForm = async () => {
    const data = await accountsApi.list({ limit: 200 });
    setAccountOptions(data.accounts.map((a) => ({ id: a.id, name: a.name })));
    setShowForm(true);
  };

  const handleCreate = async (data: Record<string, unknown>) => {
    const { amount, ...rest } = data;
    await opportunitiesApi.create({ ...rest, amountCents: dollarsToCents(amount) });
    setShowForm(false);
    loadOpportunities();
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold text-salesforce-text">Opportunities Pipeline</h2>
          <div className="text-sm text-salesforce-secondary">
            Drag and drop to change stages
          </div>
        </div>
        <button
          onClick={handleShowForm}
          className="px-4 py-2 bg-salesforce-primary text-white rounded-lg hover:bg-salesforce-hover text-sm font-medium"
        >
          New Opportunity
        </button>
      </div>

      {opportunitiesError && (
        <div role="alert" className="mb-4 flex items-center justify-between bg-red-50 text-red-700 px-4 py-2 rounded-lg text-sm">
          <span>{opportunitiesError}</span>
          <button onClick={clearOpportunitiesError} className="text-red-500 hover:text-red-700 text-xs">
            Dismiss
          </button>
        </div>
      )}

      {opportunitiesLoading ? (
        <div className="text-center py-8 text-salesforce-secondary">Loading pipeline...</div>
      ) : (
        <KanbanBoard
          opportunities={opportunities}
          onStageChange={handleStageChange}
        />
      )}

      {showForm && (
        <EntityForm
          entityType="opportunity"
          onSave={handleCreate}
          onCancel={() => setShowForm(false)}
          accounts={accountOptions}
        />
      )}
    </div>
  );
}

export const Route = createFileRoute('/opportunities')({
  component: OpportunitiesPage,
});
