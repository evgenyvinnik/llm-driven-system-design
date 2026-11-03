import { useState } from 'react';
import { formatCell } from '../utils/format';

interface DataRowProps {
  row: Record<string, unknown>;
  fields: string[];
  pkColumn: string;
  canEdit: boolean;
  onUpdate: (id: string, data: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
}

/** Renders a single table row with inline editing and delete capabilities. */
export function DataRow({ row, fields, pkColumn, canEdit, onUpdate, onDelete }: DataRowProps) {
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState<Record<string, string>>({});

  const startEdit = () => {
    const data: Record<string, string> = {};
    for (const field of fields) {
      data[field] = row[field] != null ? formatCell(row[field]) : '';
    }
    setEditData(data);
    setEditing(true);
  };

  const handleSave = () => {
    const changed: Record<string, unknown> = {};
    for (const field of fields) {
      if (field === pkColumn) continue;
      if (editData[field] !== (row[field] != null ? formatCell(row[field]) : '')) {
        changed[field] = editData[field];
      }
    }
    if (Object.keys(changed).length > 0) {
      onUpdate(String(row[pkColumn]), changed);
    }
    setEditing(false);
  };

  const id = String(row[pkColumn]);

  return (
    <tr className="border-b border-supabase-dark-border hover:bg-supabase-surface/20 group">
      {fields.map((field) => (
        <td key={field} className="px-4 py-2 text-supabase-text">
          {editing ? (
            <input
              type="text"
              value={editData[field] || ''}
              onChange={(e) => setEditData({ ...editData, [field]: e.target.value })}
              disabled={field === pkColumn}
              className="w-full bg-supabase-dark-surface border border-supabase-border rounded px-2 py-0.5 text-sm text-supabase-text focus:outline-none focus:border-supabase-primary disabled:opacity-50"
            />
          ) : (
            <span className="font-mono text-xs">
              {row[field] != null ? formatCell(row[field]) : <span className="text-supabase-secondary italic">null</span>}
            </span>
          )}
        </td>
      ))}
      {canEdit && (
        <td className="px-4 py-2">
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {editing ? (
              <>
                <button onClick={handleSave} className="text-supabase-primary text-xs hover:underline">Save</button>
                <button onClick={() => setEditing(false)} className="text-supabase-secondary text-xs hover:underline">Cancel</button>
              </>
            ) : (
              <>
                <button onClick={startEdit} className="text-supabase-secondary hover:text-supabase-text text-xs">Edit</button>
                <button onClick={() => onDelete(id)} className="text-supabase-secondary hover:text-supabase-danger text-xs">Del</button>
              </>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}
