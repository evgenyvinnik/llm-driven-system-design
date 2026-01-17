/**
 * @fileoverview Table view for database visualization.
 * Renders database rows in a spreadsheet-like table format.
 */

import { useState } from 'react';
import type { DatabaseRow, PropertySchema } from '@/types';
import { Plus, Trash2, MoreHorizontal } from 'lucide-react';
import PropertyCell from './PropertyCell';

/**
 * Props for the TableView component.
 */
interface TableViewProps {
  /** Database rows to display */
  rows: DatabaseRow[];
  /** Column definitions from the database schema */
  schema: PropertySchema[];
  /** Callback to add a new row */
  onAddRow: () => void;
  /** Callback to update a row's properties */
  onUpdateRow: (rowId: string, properties: Record<string, unknown>) => void;
  /** Callback to delete a row */
  onDeleteRow: (rowId: string) => void;
}

/**
 * TableView displays database rows in a traditional table format.
 * Each column corresponds to a property in the schema.
 *
 * @param props - Component props
 * @returns The rendered table view
 */
export default function TableView({
  rows,
  schema,
  onAddRow,
  onUpdateRow,
  onDeleteRow,
}: TableViewProps) {
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto">
      <table className="database-table w-full">
        <thead>
          <tr>
            {schema.map((prop) => (
              <th key={prop.id} className="min-w-40">
                {prop.name}
              </th>
            ))}
            <th className="w-10"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={`group ${selectedRowId === row.id ? 'bg-notion-hover' : ''}`}
              onClick={() => setSelectedRowId(row.id)}
            >
              {schema.map((prop) => (
                <td key={prop.id}>
                  <PropertyCell
                    property={prop}
                    value={row.properties[prop.id]}
                    onChange={(value) => {
                      onUpdateRow(row.id, { [prop.id]: value });
                    }}
                  />
                </td>
              ))}
              <td>
                <button
                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-notion-border rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteRow(row.id);
                  }}
                >
                  <Trash2 className="w-4 h-4 text-notion-text-secondary" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Add row button */}
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-notion-text-secondary hover:bg-notion-hover text-sm"
        onClick={onAddRow}
      >
        <Plus className="w-4 h-4" />
        New
      </button>
    </div>
  );
}
