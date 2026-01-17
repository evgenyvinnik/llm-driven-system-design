import { useNavigate } from 'react-router-dom';
import type { DocumentListItem } from '../types';
import { useDocumentStore } from '../stores/documentStore';

interface Props {
  documents: DocumentListItem[];
}

export default function DocumentList({ documents }: Props) {
  const navigate = useNavigate();
  const { deleteDocument } = useDocumentStore();

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      return 'Today';
    } else if (days === 1) {
      return 'Yesterday';
    } else if (days < 7) {
      return `${days} days ago`;
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
      });
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.confirm('Are you sure you want to delete this document?')) {
      await deleteDocument(id);
    }
  };

  return (
    <div className="space-y-1">
      {documents.map((doc) => (
        <div
          key={doc.id}
          onClick={() => navigate(`/document/${doc.id}`)}
          className="flex items-center gap-4 p-3 rounded-lg hover:bg-white hover:shadow-sm cursor-pointer group transition-all"
        >
          <svg className="w-6 h-6 text-docs-blue flex-shrink-0" viewBox="0 0 48 48" fill="none">
            <path d="M7 6C7 4.89543 7.89543 4 9 4H29L41 16V42C41 43.1046 40.1046 44 39 44H9C7.89543 44 7 43.1046 7 42V6Z" fill="currentColor"/>
            <path d="M29 4L41 16H31C29.8954 16 29 15.1046 29 14V4Z" fill="currentColor" opacity="0.5"/>
          </svg>

          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-gray-900 truncate">{doc.title}</h3>
            <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
              <span className="truncate">{doc.owner_name}</span>
              {doc.permission_level !== 'edit' && (
                <>
                  <span>-</span>
                  <span className="capitalize">{doc.permission_level} only</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500 hidden sm:inline">
              {formatDate(doc.updated_at)}
            </span>

            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs"
              style={{ backgroundColor: doc.owner_avatar_color }}
              title={doc.owner_name}
            >
              {doc.owner_name.charAt(0).toUpperCase()}
            </div>

            <button
              onClick={(e) => handleDelete(e, doc.id)}
              className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-200 transition-opacity"
              title="Delete document"
            >
              <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
