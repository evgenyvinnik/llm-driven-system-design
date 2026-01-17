import React, { useEffect } from 'react';
import { FileBrowser } from '../components/FileBrowser';
import { useFileStore } from '../stores/fileStore';

/**
 * iCloud Drive page component.
 *
 * Renders the file browser and initializes file listing and WebSocket
 * subscriptions on mount. Handles navigation between directories.
 *
 * @returns Drive page with file browser
 */
export const DrivePage: React.FC = () => {
  const { loadFiles, setCurrentPath, subscribeToChanges, loadConflicts } = useFileStore();

  useEffect(() => {
    loadFiles('/');
    loadConflicts();
    subscribeToChanges();
  }, [loadFiles, loadConflicts, subscribeToChanges]);

  const handleNavigate = (path: string) => {
    setCurrentPath(path);
  };

  return (
    <div className="h-[calc(100vh-3.5rem)] bg-white">
      <FileBrowser onNavigate={handleNavigate} />
    </div>
  );
};
