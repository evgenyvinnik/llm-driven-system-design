import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useWikiStore } from '../stores/wikiStore';
import SpaceSidebar from '../components/SpaceSidebar';

export const Route = createFileRoute('/space/$spaceKey/')({
  component: SpacePage,
});

function SpacePage() {
  const { spaceKey } = Route.useParams();
  const { currentSpace, loadSpace, loadPageTree, pageTree } = useWikiStore();

  useEffect(() => {
    loadSpace(spaceKey);
    loadPageTree(spaceKey);
  }, [spaceKey, loadSpace, loadPageTree]);

  if (!currentSpace) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-56px)]">
        <div className="text-confluence-text-subtle">Loading space...</div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-56px)]">
      <SpaceSidebar space={currentSpace} tree={pageTree} spaceKey={spaceKey} />

      <div className="flex-1 p-8 overflow-y-auto">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl font-bold text-confluence-text mb-4">
            {currentSpace.name}
          </h1>
          {currentSpace.description && (
            <p className="text-confluence-text-subtle mb-6">
              {currentSpace.description}
            </p>
          )}

          <div className="bg-confluence-info border border-blue-200 rounded-lg p-4 mb-6">
            <h3 className="font-semibold text-confluence-primary mb-2">About this space</h3>
            <div className="text-sm text-confluence-text space-y-1">
              <p>Key: <span className="font-mono font-medium">{currentSpace.key}</span></p>
              <p>Created by: {currentSpace.creator_username}</p>
              <p>Visibility: {currentSpace.is_public ? 'Public' : 'Private'}</p>
            </div>
          </div>

          {pageTree.length > 0 && (
            <div>
              <h2 className="text-xl font-semibold text-confluence-text mb-4">Pages</h2>
              <div className="text-sm text-confluence-text-subtle mb-2">
                {pageTree.length} top-level page{pageTree.length !== 1 ? 's' : ''}
              </div>
              <p className="text-confluence-text-subtle">
                Select a page from the sidebar to view its content.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
