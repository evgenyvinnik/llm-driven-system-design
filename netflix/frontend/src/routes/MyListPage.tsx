import React from 'react';
import { Navbar, VideoCard } from '../components';
import { useBrowseStore } from '../stores/browseStore';

export function MyListPage() {
  const { myList, loadMyList, isLoading } = useBrowseStore();

  React.useEffect(() => {
    loadMyList();
  }, [loadMyList]);

  return (
    <div className="min-h-screen bg-netflix-black">
      <Navbar />

      <div className="pt-24 px-4 md:px-12">
        <h1 className="text-white text-3xl font-bold mb-8">My List</h1>

        {isLoading && myList.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <div className="w-12 h-12 border-4 border-netflix-red border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isLoading && myList.length === 0 && (
          <div className="text-center py-16">
            <p className="text-netflix-light-gray text-lg mb-4">
              Your list is empty
            </p>
            <p className="text-netflix-gray">
              Add movies and TV shows to your list to watch them later
            </p>
          </div>
        )}

        {myList.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {myList.map((video) => (
              <VideoCard key={video.id} video={video} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
