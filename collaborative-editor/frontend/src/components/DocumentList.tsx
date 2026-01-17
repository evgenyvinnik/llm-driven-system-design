import { useState, useEffect } from 'react';
import type { Document, User } from '../types';
import { api } from '../services/api';

/**
 * Props for the DocumentList component.
 */
interface DocumentListProps {
  /** Callback when a document is selected */
  onSelectDocument: (document: Document) => void;
  /** Currently selected user's ID (for creating documents) */
  selectedUserId: string;
}

/**
 * DocumentList - Displays a list of all documents and allows creating new ones.
 *
 * Features:
 * - Lists all documents sorted by last update time
 * - Allows creating new documents
 * - Clicking a document selects it for editing
 *
 * @param props - Component props
 * @returns The DocumentList component
 */
export function DocumentList({ onSelectDocument, selectedUserId }: DocumentListProps) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadDocuments();
  }, []);

  async function loadDocuments() {
    try {
      const docs = await api.getDocuments();
      setDocuments(docs);
    } catch (error) {
      console.error('Failed to load documents:', error);
    } finally {
      setLoading(false);
    }
  }

  async function createDocument() {
    setCreating(true);
    try {
      const doc = await api.createDocument('Untitled Document', selectedUserId);
      setDocuments([doc, ...documents]);
      onSelectDocument(doc);
    } catch (error) {
      console.error('Failed to create document:', error);
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">Loading documents...</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Documents</h2>
        <button
          onClick={createDocument}
          disabled={creating}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? 'Creating...' : 'New Document'}
        </button>
      </div>

      {documents.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">No documents yet</p>
          <button
            onClick={createDocument}
            disabled={creating}
            className="text-blue-600 hover:underline"
          >
            Create your first document
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {documents.map((doc) => (
            <li key={doc.id}>
              <button
                onClick={() => onSelectDocument(doc)}
                className="w-full text-left p-4 bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow border border-gray-200"
              >
                <h3 className="font-medium text-gray-900">{doc.title}</h3>
                <p className="text-sm text-gray-500">
                  Last updated: {new Date(doc.updatedAt).toLocaleDateString()}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
