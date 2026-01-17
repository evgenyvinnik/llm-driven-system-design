import React, { useEffect } from 'react';
import { PhotoGallery } from '../components/PhotoGallery';
import { usePhotoStore } from '../stores/photoStore';

export const PhotosPage: React.FC = () => {
  const { subscribeToChanges } = usePhotoStore();

  useEffect(() => {
    subscribeToChanges();
  }, [subscribeToChanges]);

  return (
    <div className="h-[calc(100vh-3.5rem)] bg-white">
      <PhotoGallery />
    </div>
  );
};
