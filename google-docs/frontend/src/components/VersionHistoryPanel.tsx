import { useEffect, useState } from 'react';
import { useDocumentStore } from '../stores/documentStore';

interface Props {
  documentId: string;
  onClose: () => void;
}

export default function VersionHistoryPanel({ documentId, onClose }: Props) {
  const { versions, fetchVersions, createVersion, restoreVersion } = useDocumentStore();
  const [isCreating, setIsCreating] = useState(false);
  const [versionName, setVersionName] = useState('');

  useEffect(() => {
    fetchVersions(documentId);
  }, [documentId, fetchVersions]);

  const handleCreateVersion = async () => {
    await createVersion(documentId, versionName || undefined);
    setVersionName('');
    setIsCreating(false);
  };

  const handleRestore = async (versionNumber: number) => {
    if (window.confirm('Are you sure you want to restore this version? Current changes will be saved as a new version.')) {
      await restoreVersion(documentId, versionNumber);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <div className="w-80 bg-white border-l border-docs-border flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-docs-border">
        <h2 className="font-medium">Version history</h2>
        <button
          onClick={onClose}
          className="p-1 hover:bg-gray-100 rounded-full"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Create version */}
      <div className="p-4 border-b border-docs-border">
        {isCreating ? (
          <div>
            <input
              type="text"
              value={versionName}
              onChange={(e) => setVersionName(e.target.value)}
              placeholder="Version name (optional)"
              className="w-full px-3 py-2 border border-docs-border rounded-lg focus:outline-none focus:border-docs-blue text-sm"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-2">
              <button
                onClick={() => setIsCreating(false)}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateVersion}
                className="px-3 py-1.5 text-sm bg-docs-blue text-white rounded"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-2 text-sm text-docs-blue hover:text-docs-blue-dark"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Name current version
          </button>
        )}
      </div>

      {/* Versions list */}
      <div className="flex-1 overflow-auto">
        {versions.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            No version history yet
          </div>
        ) : (
          <div className="divide-y divide-docs-border">
            {versions.map((version, index) => (
              <div
                key={version.id}
                className="p-4 hover:bg-gray-50 cursor-pointer group"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-sm font-medium text-gray-900">
                      {version.is_named ? version.name : `Version ${version.version_number}`}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {formatDate(version.created_at)}
                    </div>
                    {version.created_by_name && (
                      <div className="flex items-center gap-1 mt-1">
                        <div
                          className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px]"
                          style={{ backgroundColor: version.avatar_color || '#3B82F6' }}
                        >
                          {version.created_by_name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-xs text-gray-600">{version.created_by_name}</span>
                      </div>
                    )}
                  </div>

                  {index > 0 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRestore(version.version_number);
                      }}
                      className="opacity-0 group-hover:opacity-100 px-2 py-1 text-xs text-docs-blue hover:bg-blue-50 rounded transition-opacity"
                    >
                      Restore
                    </button>
                  )}
                </div>

                {index === 0 && (
                  <span className="inline-block mt-2 px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded">
                    Current
                  </span>
                )}

                {version.is_named && (
                  <span className="inline-block mt-2 ml-1 px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">
                    Named
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info footer */}
      <div className="p-4 border-t border-docs-border bg-gray-50 text-xs text-gray-500">
        <p>Versions are automatically saved every 100 edits or when you name a version.</p>
      </div>
    </div>
  );
}
