import React, { useState } from 'react';
import { FileBrowser } from './components/FileBrowser';
import { Editor } from './components/Editor';

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
