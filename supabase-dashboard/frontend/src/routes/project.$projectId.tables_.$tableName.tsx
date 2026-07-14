import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { TableBrowser } from '../components/TableBrowser';

function TableDataPage() {
  const { projectId, tableName } = Route.useParams();
  const { tables, loadTables } = useProjectStore();

  useEffect(() => {
    if (tables.length === 0) {
      loadTables(projectId);
    }
  }, [projectId, tables.length, loadTables]);

  const tableInfo = tables.find((t) => t.tableName === tableName);

  return (
    <div className="h-full">
      <TableBrowser
        projectId={projectId}
        tableName={tableName}
        columns={tableInfo?.columns || []}
      />
    </div>
  );
}

export const Route = createFileRoute('/project/$projectId/tables_/$tableName')({
  component: TableDataPage,
});
