import React, { useEffect } from 'react';
import { PhotoGallery } from '../components/PhotoGallery';
import { usePhotoStore } from '../stores/photoStore';

/**
 * iCloud Photos page component.
 *
 * Renders the photo gallery and initializes WebSocket subscriptions
 * for real-time photo sync updates on mount.
 *
 * @returns Photos page with gallery
 */
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
