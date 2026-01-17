import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { Document, PresenceState } from '../types';
import { useDocumentStore } from '../stores/documentStore';
import ShareModal from './ShareModal';

interface Props {
  document: Document;
  presence: PresenceState[];
  wsConnected: boolean;
  onToggleComments: () => void;
  onToggleVersionHistory: () => void;
  showComments: boolean;
  showVersionHistory: boolean;
}

export default function DocumentHeader({
  document,
  presence,
  wsConnected,
  onToggleComments,
  onToggleVersionHistory,
  showComments,
  showVersionHistory,
}: Props) {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [title, setTitle] = useState(document.title);
  const [showShareModal, setShowShareModal] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const { updateDocument } = useDocumentStore();

  useEffect(() => {
    setTitle(document.title);
  }, [document.title]);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  const handleTitleSubmit = async () => {
    setIsEditingTitle(false);
    if (title.trim() && title !== document.title) {
      await updateDocument(document.id, { title: title.trim() });
    } else {
      setTitle(document.title);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTitleSubmit();
    } else if (e.key === 'Escape') {
      setTitle(document.title);
      setIsEditingTitle(false);
    }
  };

  return (
    <>
      <header className="bg-white border-b border-docs-border px-2 py-1 sticky top-0 z-50">
        {/* Top row - logo, title, share */}
        <div className="flex items-center gap-2">
          <Link to="/" className="p-2 hover:bg-gray-100 rounded-full">
            <svg className="w-6 h-6" viewBox="0 0 48 48" fill="none">
              <path d="M7 6C7 4.89543 7.89543 4 9 4H29L41 16V42C41 43.1046 40.1046 44 39 44H9C7.89543 44 7 43.1046 7 42V6Z" fill="#4285F4"/>
              <path d="M29 4L41 16H31C29.8954 16 29 15.1046 29 14V4Z" fill="#A1C2FA"/>
              <path d="M14 24H34M14 30H34M14 36H26" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </Link>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {isEditingTitle ? (
                <input
                  ref={titleInputRef}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={handleTitleSubmit}
                  onKeyDown={handleKeyDown}
                  className="text-lg font-normal px-2 py-0.5 border border-docs-blue rounded focus:outline-none focus:ring-1 focus:ring-docs-blue w-full max-w-md"
                />
              ) : (
                <button
                  onClick={() => document.permission_level === 'edit' && setIsEditingTitle(true)}
                  className="text-lg font-normal px-2 py-0.5 hover:bg-gray-100 rounded truncate max-w-md text-left"
                  title={document.title}
                >
                  {document.title}
                </button>
              )}

              {/* Connection status indicator */}
              <div
                className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-yellow-500'}`}
                title={wsConnected ? 'Connected' : 'Connecting...'}
              />
            </div>

            <div className="flex items-center gap-1 text-xs text-gray-500 ml-2">
              <span>File</span>
              <span>Edit</span>
              <span>View</span>
              <span>Insert</span>
              <span>Format</span>
              <span>Tools</span>
            </div>
          </div>

          {/* Presence avatars */}
          <div className="flex items-center -space-x-2">
            {presence.slice(0, 5).map((user) => (
              <div
                key={user.user_id}
                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-medium border-2 border-white"
                style={{ backgroundColor: user.color }}
                title={user.name}
              >
                {user.name.charAt(0).toUpperCase()}
              </div>
            ))}
            {presence.length > 5 && (
              <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-400 text-white text-xs font-medium border-2 border-white">
                +{presence.length - 5}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleComments}
              className={`p-2 rounded-full hover:bg-gray-100 ${showComments ? 'bg-blue-50 text-docs-blue' : 'text-gray-600'}`}
              title="Comments"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </button>

            <button
              onClick={onToggleVersionHistory}
              className={`p-2 rounded-full hover:bg-gray-100 ${showVersionHistory ? 'bg-blue-50 text-docs-blue' : 'text-gray-600'}`}
              title="Version history"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>

            <button
              onClick={() => setShowShareModal(true)}
              className="flex items-center gap-2 bg-docs-blue hover:bg-docs-blue-dark text-white px-4 py-2 rounded-full text-sm font-medium"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              Share
            </button>
          </div>
        </div>
      </header>

      {showShareModal && (
        <ShareModal
          documentId={document.id}
          onClose={() => setShowShareModal(false)}
        />
      )}
    </>
  );
}
