/**
 * Root application component for the Figma clone.
 * Manages top-level navigation between the file browser and editor views.
 */
import { useState } from 'react';
import { FileBrowser } from './components/FileBrowser';
import { Editor } from './components/Editor';

/**
 * App component providing the main application shell.
 * Conditionally renders either the file browser or editor based on selection state.
 * @returns The rendered application
 */
function App() {
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  if (selectedFileId) {
    return (
      <Editor
        fileId={selectedFileId}
        onBack={() => setSelectedFileId(null)}
      />
    );
  }

  return <FileBrowser onSelectFile={setSelectedFileId} />;
}

export default App;
