import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDocumentStore } from '../stores/documentStore';
import { useAuthStore } from '../stores/authStore';
import wsService from '../services/websocket';
import DocumentHeader from '../components/DocumentHeader';
import Editor from '../components/Editor';
import CommentsPanel from '../components/CommentsPanel';
import VersionHistoryPanel from '../components/VersionHistoryPanel';
import type { WSMessage, PresenceState } from '../types';

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const {
    currentDocument,
    presence,
    fetchDocument,
    fetchComments,
    setPresence,
    updatePresence,
    removePresence,
    isLoading,
    error,
  } = useDocumentStore();

  const [showComments, setShowComments] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);

  // Handle WebSocket messages
  const handleWSMessage = useCallback((message: WSMessage) => {
    switch (message.type) {
      case 'SYNC':
        if (message.data) {
          const data = message.data as { presence?: PresenceState[] };
          if (data.presence) {
            setPresence(data.presence.filter((p) => p.user_id !== user?.id));
          }
        }
        break;

      case 'PRESENCE':
        if (message.data) {
          const data = message.data as PresenceState & { left?: boolean };
          if (data.left) {
            removePresence(data.user_id);
          } else if (data.user_id !== user?.id) {
            updatePresence(data);
          }
        }
        break;

      case 'CURSOR':
        if (message.data) {
          const data = message.data as PresenceState;
          if (data.user_id !== user?.id) {
            updatePresence(data);
          }
        }
        break;

      case 'ERROR':
        console.error('WebSocket error:', message.error);
        if (message.code === 'ACCESS_DENIED' || message.code === 'NOT_FOUND') {
          navigate('/');
        }
        break;
    }
  }, [user?.id, setPresence, updatePresence, removePresence, navigate]);

  // Connect to WebSocket and subscribe to document
  useEffect(() => {
    if (!id || !user) return;

    const connect = async () => {
      try {
        await wsService.connect();
        wsService.subscribe(id);
        setWsConnected(true);
      } catch (error) {
        console.error('WebSocket connection error:', error);
      }
    };

    const unsubscribe = wsService.addMessageHandler(handleWSMessage);
    connect();

    return () => {
      unsubscribe();
      wsService.unsubscribe();
      setWsConnected(false);
      setPresence([]);
    };
  }, [id, user, handleWSMessage, setPresence]);

  // Fetch document data
  useEffect(() => {
    if (id) {
      fetchDocument(id);
      fetchComments(id);
    }
  }, [id, fetchDocument, fetchComments]);

  if (isLoading && !currentDocument) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-docs-bg">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-docs-blue"></div>
      </div>
    );
  }

  if (error || !currentDocument) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-docs-bg">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error || 'Document not found'}</p>
          <button
            onClick={() => navigate('/')}
            className="text-docs-blue hover:text-docs-blue-dark"
          >
            Go back to home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-docs-bg flex flex-col">
      <DocumentHeader
        document={currentDocument}
        presence={presence}
        wsConnected={wsConnected}
        onToggleComments={() => setShowComments(!showComments)}
        onToggleVersionHistory={() => setShowVersionHistory(!showVersionHistory)}
        showComments={showComments}
        showVersionHistory={showVersionHistory}
      />

      <div className="flex-1 flex">
        {/* Main editor area */}
        <div className="flex-1 flex justify-center overflow-auto py-8">
          <div className="w-full max-w-[816px] min-h-[1056px] bg-white shadow-md mx-4">
            <Editor
              document={currentDocument}
              presence={presence}
              readOnly={currentDocument.permission_level === 'view'}
            />
          </div>
        </div>

        {/* Side panels */}
        {showComments && (
          <CommentsPanel
            documentId={currentDocument.id}
            onClose={() => setShowComments(false)}
          />
        )}

        {showVersionHistory && (
          <VersionHistoryPanel
            documentId={currentDocument.id}
            onClose={() => setShowVersionHistory(false)}
          />
        )}
      </div>
    </div>
  );
}
