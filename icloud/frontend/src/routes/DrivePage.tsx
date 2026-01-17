import React, { useEffect } from 'react';
import { FileBrowser } from '../components/FileBrowser';
import { useFileStore } from '../stores/fileStore';

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
