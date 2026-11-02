import { useEffect, useState, useCallback, useRef } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Canvas } from '../components/Canvas';
import { Toolbar } from '../components/Toolbar';
import { PropertiesPanel } from '../components/PropertiesPanel';
import { CollaboratorCursors } from '../components/CollaboratorCursors';
import { ShareDialog } from '../components/ShareDialog';
import { useCanvasStore } from '../stores/canvasStore';
import { useAuthStore } from '../stores/authStore';
import { drawingApi } from '../services/api';
import { wsClient } from '../services/websocket';
import type { ExcalidrawElement, Collaborator, Cursor } from '../types';

export const Route = createFileRoute('/draw/$drawingId')({
  component: DrawingPage,
});

function DrawingPage() {
  const { drawingId } = Route.useParams();
  const { user, isAuthenticated } = useAuthStore();
  const userId = user?.id ?? null;
  const viewState = useCanvasStore((s) => s.viewState);
  const cursors = useCanvasStore((s) => s.cursors);
  const canEdit = useCanvasStore((s) => s.canEdit);
  const {
    setElements,
    applyRemoteElement,
    applyRemoteMove,
    deleteElement,
    updateCursor,
    removeCursor,
    setCursors,
    setCanEdit,
    resetForDrawing,
  } = useCanvasStore.getState();

  const [title, setTitle] = useState('Untitled');
  const [isPublic, setIsPublic] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Once the room has sent its state, that is newer than any REST response
  // (Postgres lags the room by up to one debounce), so REST must not overwrite it.
  const roomSynced = useRef(false);

  useEffect(() => {
    resetForDrawing();
    roomSynced.current = false;
    setError(null);
  }, [drawingId, resetForDrawing]);

  // Load drawing metadata (and elements, if the room hasn't answered yet)
  useEffect(() => {
    let cancelled = false;
    const loadDrawing = async () => {
      try {
        setIsLoading(true);
        const response = await drawingApi.get(drawingId);
        if (cancelled) return;
        if (!roomSynced.current) setElements(response.drawing.elements || []);
        setTitle(response.drawing.title);
        setIsPublic(response.drawing.isPublic);
        setIsOwner(response.drawing.ownerId === userId);
        setCollaborators(response.collaborators || []);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadDrawing();
    return () => {
      cancelled = true;
    };
  }, [drawingId, userId, setElements]);

  // Collaboration channel. Anonymous viewers of a public drawing join too; the
  // server decides what this connection may do and says so in room-state.
  useEffect(() => {
    wsClient.connect();
    wsClient.joinRoom(drawingId);

    const subscriptions = [
      wsClient.on('room-state', (msg) => {
        if (msg.drawingId !== drawingId) return;
        roomSynced.current = true;
        setElements((msg.elements as ExcalidrawElement[]) || []);
        setCanEdit(Boolean(msg.canEdit));
        setCursors([]);
      }),
      // The server never echoes a message to its sender, so everything that
      // arrives here is someone else's edit, including this account's other tabs.
      wsClient.on('shape-add', (msg) => msg.elementData && applyRemoteElement(msg.elementData)),
      wsClient.on('shape-update', (msg) => msg.elementData && applyRemoteElement(msg.elementData)),
      wsClient.on('shape-move', (msg) => msg.elementData && applyRemoteMove(msg.elementData)),
      wsClient.on('shape-delete', (msg) => msg.elementId && deleteElement(msg.elementId)),
      wsClient.on('elements-sync', (msg) => msg.elements && setElements(msg.elements as ExcalidrawElement[])),
      wsClient.on('cursor-move', (msg) => {
        if (msg.clientId && msg.x !== undefined && msg.y !== undefined) {
          updateCursor({
            clientId: msg.clientId,
            userId: msg.userId || '',
            username: msg.username || 'Guest',
            x: msg.x,
            y: msg.y,
            color: msg.color || '#6965db',
          } as Cursor);
        }
      }),
      wsClient.on('user-left', (msg) => msg.clientId && removeCursor(msg.clientId)),
      wsClient.on('permission-changed', (msg) => {
        if (msg.drawingId === drawingId) setCanEdit(Boolean(msg.canEdit));
      }),
      wsClient.on('access-revoked', (msg) => {
        if (msg.drawingId !== drawingId) return;
        setError(msg.reason === 'deleted' ? 'This drawing was deleted.' : 'Your access to this drawing was removed.');
      }),
      wsClient.on('error', (msg) => {
        if (msg.code === 'forbidden' && msg.drawingId === drawingId) setError(msg.message || 'Access denied');
        if (msg.code === 'read-only') setCanEdit(false);
      }),
    ];

    return () => {
      subscriptions.forEach((unsubscribe) => unsubscribe());
      wsClient.leaveRoom();
    };
  }, [drawingId, setElements, applyRemoteElement, applyRemoteMove, deleteElement, updateCursor, removeCursor, setCursors, setCanEdit]);

  // The socket's identity is the session at upgrade time, so a login or logout
  // needs a fresh socket (which rejoins the room on open).
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (previousUserId.current !== undefined && previousUserId.current !== userId) {
      wsClient.reconnect();
    }
    previousUserId.current = userId;
  }, [userId]);

  // Save drawing. Tombstones are sent too: the server merges per element, and
  // dropping deleted elements here used to strip them from storage.
  const handleSave = useCallback(async () => {
    if (!isAuthenticated || !canEdit) return;

    try {
      setIsSaving(true);
      setSaveError(null);
      await drawingApi.update(drawingId, {
        title,
        elements: useCanvasStore.getState().elements,
        isPublic,
      });
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  }, [drawingId, title, isPublic, isAuthenticated, canEdit]);

  // Keyboard shortcut for save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-canvas-bg">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-canvas-bg gap-4">
        <div className="text-red-500 text-lg">{error}</div>
        <Link to="/" className="text-primary hover:underline">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-panel-border z-50">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-text-secondary hover:text-text-primary transition-colors">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 18l-8-8 8-8 1.4 1.4L5.8 9H18v2H5.8l5.6 5.6L10 18z" />
            </svg>
          </Link>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            readOnly={!canEdit}
            className="text-sm font-medium text-text-primary bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-primary rounded px-2 py-1"
            placeholder="Untitled"
          />
          {!canEdit && (
            <span
              className="text-xs font-medium text-text-secondary bg-panel-bg border border-panel-border rounded px-2 py-0.5"
              data-testid="view-only-badge"
            >
              View only
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Connected users indicator */}
          {cursors.length > 0 && (
            <div className="flex -space-x-2">
              {cursors.slice(0, 5).map((cursor) => (
                <div
                  key={cursor.clientId}
                  className="w-7 h-7 rounded-full border-2 border-white flex items-center justify-center text-white text-xs font-medium"
                  style={{ backgroundColor: cursor.color }}
                  title={cursor.username}
                >
                  {cursor.username.charAt(0).toUpperCase()}
                </div>
              ))}
              {cursors.length > 5 && (
                <div className="w-7 h-7 rounded-full border-2 border-white bg-gray-400 flex items-center justify-center text-white text-xs">
                  +{cursors.length - 5}
                </div>
              )}
            </div>
          )}

          {saveError && (
            <span className="text-xs text-red-600" role="alert">
              Save failed: {saveError}
            </span>
          )}
          {isAuthenticated && (
            <button
              onClick={() => setShowShareDialog(true)}
              className="text-sm text-primary hover:underline"
            >
              Share
            </button>
          )}
          {isAuthenticated && canEdit && (
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="text-sm bg-primary text-white px-3 py-1.5 rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {/* Canvas area */}
      <div className="flex-1 relative">
        {canEdit && <Toolbar />}
        {canEdit && <PropertiesPanel />}
        <Canvas />
        <CollaboratorCursors
          cursors={cursors}
          scrollX={viewState.scrollX}
          scrollY={viewState.scrollY}
          zoom={viewState.zoom}
        />
      </div>

      {/* Share dialog */}
      {showShareDialog && (
        <ShareDialog
          drawingId={drawingId}
          collaborators={collaborators}
          isOwner={isOwner}
          onClose={() => setShowShareDialog(false)}
          onCollaboratorsChange={setCollaborators}
        />
      )}
    </div>
  );
}
