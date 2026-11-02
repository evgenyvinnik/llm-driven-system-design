import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useCrmStore } from '../stores/crmStore';
import { AccountList } from '../components/AccountList';
import { EntityForm } from '../components/EntityForm';
import { accountsApi } from '../services/api';

function AccountsPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const { accounts, accountsTotal, accountsLoading, fetchAccounts } = useCrmStore();
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);

  const loadAccounts = useCallback((search?: string, p?: number) => {
    fetchAccounts({ search, page: p || page });
  }, [fetchAccounts, page]);

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
      return;
    }
    loadAccounts();
  }, [user, navigate, loadAccounts]);

  if (!user) return null;

  const handleSearch = (search: string) => {
    setPage(1);
    loadAccounts(search, 1);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    fetchAccounts({ page: newPage });
  };

  const handleCreate = async (data: Record<string, unknown>) => {
    await accountsApi.create(data as Partial<import('../types').Account>);
    setShowForm(false);
    loadAccounts();
  };

  return (
    <div className="p-6">
      <AccountList
        accounts={accounts}
        total={accountsTotal}
        loading={accountsLoading}
        onSearch={handleSearch}
        onPageChange={handlePageChange}
        page={page}
        onCreateClick={() => setShowForm(true)}
      />

      {showForm && (
        <EntityForm
          entityType="account"
          onSave={handleCreate}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

export const Route = createFileRoute('/accounts')({
  component: AccountsPage,
});
