import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useProjectStore, useProjectRole } from '../stores/projectStore';
import { TableList } from '../components/TableList';
import { SchemaViewer } from '../components/SchemaViewer';
import { CreateTableModal } from '../components/CreateTableModal';

function TablesPage() {
  const { projectId } = Route.useParams();
  const { tables, tablesLoading, tablesError, loadTables, createTable, dropTable } = useProjectStore();
  const { canEdit } = useProjectRole();
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  useEffect(() => {
    loadTables(projectId);
  }, [projectId, loadTables]);

  const selectedTableInfo = tables.find((t) => t.tableName === selectedTable);

  return (
    <div className="flex h-full">
      {/* Table list sidebar */}
      <div className="w-64 border-r border-supabase-border bg-supabase-dark-surface overflow-y-auto">
        <div className="p-4 border-b border-supabase-border flex items-center justify-between">
          <h3 className="text-sm font-medium text-supabase-text">Tables</h3>
          {canEdit && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="text-supabase-primary hover:text-supabase-hover text-sm"
            >
              + New
            </button>
          )}
        </div>
        {(tablesError || dropError) && (
          <div className="m-3 bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded text-xs">
            {tablesError || dropError}
          </div>
        )}
        <TableList
          tables={tables}
          loading={tablesLoading}
          selectedTable={selectedTable}
          onSelect={setSelectedTable}
          onDrop={
            canEdit
              ? async (name) => {
                  if (!confirm(`Drop table "${name}"? This cannot be undone.`)) return;
                  setDropError(null);
                  try {
                    await dropTable(projectId, name);
                    if (selectedTable === name) setSelectedTable(null);
                  } catch (err) {
                    setDropError(err instanceof Error ? err.message : 'Failed to drop table');
                  }
                }
              : undefined
          }
        />
      </div>

      {/* Table details */}
      <div className="flex-1 p-6 overflow-auto">
        {selectedTableInfo ? (
          <SchemaViewer table={selectedTableInfo} projectId={projectId} />
        ) : (
          <div className="flex items-center justify-center h-full text-supabase-secondary">
            <div className="text-center">
              <p className="text-lg mb-2">Select a table</p>
              <p className="text-sm">Choose a table from the sidebar to view its schema</p>
            </div>
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateTableModal
          onClose={() => setShowCreateModal(false)}
          onCreate={async (tableName, columns) => {
            await createTable(projectId, tableName, columns);
            setShowCreateModal(false);
          }}
        />
      )}
    </div>
  );
}

export const Route = createFileRoute('/project/$projectId/tables')({
  component: TablesPage,
});
