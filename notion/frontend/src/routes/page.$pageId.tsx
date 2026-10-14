import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore, useWorkspaceStore, usePageStore } from '@/stores';
import { useEditorStore } from '@/stores/editor';
import { pagesApi } from '@/services/api';
import { wsService } from '@/services/websocket';
import Sidebar from '@/components/sidebar/Sidebar';
import BlockEditor from '@/components/editor/BlockEditor';
import DatabaseView from '@/components/database/DatabaseView';
import type { Page, DatabaseView as DBView, Operation, Presence, WSMessage } from '@/types';

function PageView() {
  const { pageId } = Route.useParams();
  const navigate = useNavigate();
  const { currentWorkspace, fetchWorkspaces } = useWorkspaceStore();
  const { fetchPages, setCurrentPage } = usePageStore();
  const {
    blocks,
    presence,
    permission,
    saveState,
    loadSnapshot,
    receiveOperation,
    receiveSync,
    requestCatchUp,
    resync,
    setPresence,
    addPresence,
    removePresence,
    updatePresencePosition,
  } = useEditorStore();

  const [page, setPage] = useState<Page | null>(null);
  const [childPages, setChildPages] = useState<Page[]>([]);
  const [views, setViews] = useState<DBView[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);

  // Load the snapshot, then subscribe from the seq it reflects: the server
  // replays anything committed in between, so no edit falls through the gap.
  useEffect(() => {
    let cancelled = false;

    async function fetchPage() {
      setIsLoading(true);
      try {
        const data = await pagesApi.get(pageId);
        if (cancelled) return;
        setPage(data.page);
        setChildPages(data.children);
        setViews(data.views);
        setCurrentPage(data.page);
        loadSnapshot(pageId, data.blocks, data.seq, data.permission);
        wsService.subscribePage(pageId, () => useEditorStore.getState().lastSeq);

        if (data.views.length > 0) {
          setActiveViewId(data.views[0].id);
        }
      } catch (error) {
        console.error('Failed to fetch page:', error);
        navigate({ to: '/' });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchPage();
    return () => {
      cancelled = true;
      wsService.unsubscribePage();
    };
  }, [pageId, navigate, loadSnapshot, setCurrentPage]);

  // Real-time messages for the open page
  useEffect(() => {
    return wsService.onMessage((message: WSMessage) => {
      switch (message.type) {
        case 'subscribed': {
          const payload = message.payload as { pageId: string; presence: Presence[] };
          if (payload.pageId === pageId) setPresence(payload.presence);
          break;
        }
        case 'operation':
          receiveOperation(message.payload as Operation);
          break;
        case 'sync': {
          const payload = message.payload as { pageId: string; operations: Operation[]; headSeq: number };
          if (payload.pageId === pageId) receiveSync(payload.operations, payload.headSeq);
          break;
        }
        case 'resync_required':
          void resync();
          break;
        case 'sync_hint':
          requestCatchUp();
          break;
        case 'presence': {
          const payload = message.payload as {
            action: 'join' | 'leave' | 'update';
            userId: string;
            userName: string;
            cursor_position?: { block_id: string; offset: number };
          };
          if (payload.action === 'join') {
            addPresence({
              user_id: payload.userId,
              user_name: payload.userName,
              page_id: pageId,
              last_seen: Date.now(),
            });
          } else if (payload.action === 'leave') {
            removePresence(payload.userId);
          } else if (payload.action === 'update') {
            updatePresencePosition(payload.userId, payload.cursor_position);
          }
          break;
        }
      }
    });
  }, [pageId, receiveOperation, receiveSync, requestCatchUp, resync, setPresence, addPresence, removePresence, updatePresencePosition]);

  // Fetch workspaces if not loaded
  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  // Fetch pages for sidebar
  useEffect(() => {
    if (currentWorkspace) {
      fetchPages(currentWorkspace.id);
    }
  }, [currentWorkspace, fetchPages]);

  if (isLoading) {
    return (
      <div className="h-screen flex">
        <Sidebar />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-notion-text-secondary">Loading...</div>
        </main>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="h-screen flex">
        <Sidebar />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-notion-text-secondary">Page not found</div>
        </main>
      </div>
    );
  }

  return (
    <div className="h-screen flex">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto p-8">
          {/* Page header */}
          <div className="mb-8">
            {page.cover_image && (
              <div
                className="h-48 bg-cover bg-center rounded-lg mb-4"
                style={{ backgroundImage: `url(${page.cover_image})` }}
              />
            )}

            <div className="flex items-center gap-3 mb-4">
              {page.icon && <span className="text-5xl">{page.icon}</span>}
              <h1 className="text-4xl font-bold">{page.title || 'Untitled'}</h1>
            </div>

            {/* Access level and save status */}
            <div className="flex items-center gap-3 mb-2 text-sm text-notion-text-secondary" aria-live="polite">
              {permission === 'view' && (
                <span className="px-2 py-0.5 rounded bg-notion-background-secondary">View only</span>
              )}
              {saveState === 'saving' && <span>Saving...</span>}
              {saveState === 'offline' && <span>Offline - changes will be saved when the connection returns</span>}
              {saveState === 'error' && <span>Some changes could not be saved</span>}
            </div>

            {/* Presence indicators */}
            {presence.length > 0 && (
              <div className="flex items-center gap-2 mb-4">
                <span className="text-sm text-notion-text-secondary">Viewing:</span>
                {presence.map((p) => (
                  <div
                    key={p.user_id}
                    className="flex items-center gap-1 px-2 py-1 bg-notion-background-secondary rounded text-sm"
                    title={p.user_name}
                  >
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    {p.user_name}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Content */}
          {page.is_database ? (
            <DatabaseView
              database={page}
              views={views}
              activeViewId={activeViewId}
              onViewChange={setActiveViewId}
            />
          ) : (
            <BlockEditor
              pageId={page.id}
              blocks={blocks}
              childPages={childPages}
              readOnly={permission === 'view'}
            />
          )}
        </div>
      </main>
    </div>
  );
}

export const Route = createFileRoute('/page/$pageId')({
  beforeLoad: async () => {
    // `isAuthenticated` is initialised to false even when a token was restored
    // from localStorage, and `checkAuth` only runs from the root component's
    // effect — which is *after* this guard. Reading the flag directly therefore
    // redirected every authenticated user to /login on any load or reload, so
    // the app was unusable past the login screen. Await the session check first.
    if (useAuthStore.getState().isLoading) {
      await useAuthStore.getState().checkAuth();
    }
    if (!useAuthStore.getState().isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: PageView,
});
