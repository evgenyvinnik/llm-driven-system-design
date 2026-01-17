import { useState, useEffect } from 'react';
import { TextEditor } from './components/TextEditor';
import { UserList } from './components/UserList';
import { Header } from './components/Header';
import { DocumentList } from './components/DocumentList';
import { UserSelector } from './components/UserSelector';
import { useEditorStore } from './stores/editorStore';
import type { Document } from './types';

/**
 * App - Root component for the collaborative editor application.
 *
 * Manages the application's top-level state and routing:
 * - When no document is selected, shows the document list
 * - When a document is selected, shows the editor view
 *
 * Also handles:
 * - User selection (simulated authentication)
 * - WebSocket connection lifecycle
 *
 * @returns The App component
 */
function App() {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const { connect, disconnect, connected } = useEditorStore();

  // Connect to document when selected
  useEffect(() => {
    if (selectedDocument && selectedUserId) {
      connect(selectedDocument.id, selectedUserId);
    }

    return () => {
      disconnect();
    };
  }, [selectedDocument?.id, selectedUserId]);

  // Show document list if no document selected
  if (!selectedDocument) {
    return (
      <div className="min-h-screen bg-gray-100">
        <header className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between max-w-4xl mx-auto">
            <h1 className="text-2xl font-bold text-gray-900">Collaborative Editor</h1>
            <UserSelector
              selectedUserId={selectedUserId}
              onSelectUser={setSelectedUserId}
            />
          </div>
        </header>
        <main className="max-w-4xl mx-auto py-6">
          {selectedUserId ? (
            <DocumentList
              onSelectDocument={setSelectedDocument}
              selectedUserId={selectedUserId}
            />
          ) : (
            <div className="text-center py-12 text-gray-500">
              Please select a user to continue
            </div>
          )}
        </main>
      </div>
    );
  }

  // Show editor
  return (
    <div className="min-h-screen flex flex-col bg-gray-100">
      <Header
        title={selectedDocument.title}
        onTitleChange={() => {}}
      />
      <div className="flex-1 flex">
        <main className="flex-1 flex flex-col bg-white">
          <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
            <button
              onClick={() => {
                disconnect();
                setSelectedDocument(null);
              }}
              className="text-sm text-blue-600 hover:underline"
            >
              Back to Documents
            </button>
            <UserSelector
              selectedUserId={selectedUserId}
              onSelectUser={(userId) => {
                setSelectedUserId(userId);
              }}
            />
          </div>
          <TextEditor />
        </main>
        <UserList />
      </div>
    </div>
  );
}

export default App;
