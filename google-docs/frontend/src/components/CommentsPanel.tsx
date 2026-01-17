import { useEffect, useState } from 'react';
import { useDocumentStore } from '../stores/documentStore';
import { useAuthStore } from '../stores/authStore';

interface Props {
  documentId: string;
  onClose: () => void;
}

export default function CommentsPanel({ documentId, onClose }: Props) {
  const { user } = useAuthStore();
  const { comments, fetchComments, addComment, resolveComment, deleteComment, replyToComment } = useDocumentStore();
  const [newComment, setNewComment] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState('');

  useEffect(() => {
    fetchComments(documentId);
  }, [documentId, fetchComments]);

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    await addComment(documentId, newComment.trim());
    setNewComment('');
  };

  const handleReply = async (parentId: string) => {
    if (!replyContent.trim()) return;

    await replyToComment(documentId, parentId, replyContent.trim());
    setReplyContent('');
    setReplyingTo(null);
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="w-80 bg-white border-l border-docs-border flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-docs-border">
        <h2 className="font-medium">Comments</h2>
        <button
          onClick={onClose}
          className="p-1 hover:bg-gray-100 rounded-full"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Add comment form */}
      <form onSubmit={handleAddComment} className="p-4 border-b border-docs-border">
        <textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
          className="w-full px-3 py-2 border border-docs-border rounded-lg focus:outline-none focus:border-docs-blue focus:ring-1 focus:ring-docs-blue resize-none text-sm"
        />
        <div className="flex justify-end mt-2">
          <button
            type="submit"
            disabled={!newComment.trim()}
            className="px-4 py-1.5 bg-docs-blue hover:bg-docs-blue-dark text-white rounded text-sm disabled:opacity-50"
          >
            Comment
          </button>
        </div>
      </form>

      {/* Comments list */}
      <div className="flex-1 overflow-auto">
        {comments.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            No comments yet
          </div>
        ) : (
          <div className="divide-y divide-docs-border">
            {comments.map((comment) => (
              <div
                key={comment.id}
                className={`p-4 ${comment.resolved ? 'bg-gray-50' : ''}`}
              >
                {/* Comment header */}
                <div className="flex items-start gap-2">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs flex-shrink-0"
                    style={{ backgroundColor: comment.author?.avatar_color || '#3B82F6' }}
                  >
                    {comment.author?.name?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {comment.author?.name || 'Unknown'}
                      </span>
                      <span className="text-xs text-gray-500">
                        {formatTime(comment.created_at)}
                      </span>
                    </div>
                    <p className={`text-sm mt-1 ${comment.resolved ? 'text-gray-400 line-through' : 'text-gray-700'}`}>
                      {comment.content}
                    </p>

                    {/* Actions */}
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={() => resolveComment(documentId, comment.id, !comment.resolved)}
                        className="text-xs text-gray-500 hover:text-gray-700"
                      >
                        {comment.resolved ? 'Reopen' : 'Resolve'}
                      </button>
                      <button
                        onClick={() => setReplyingTo(replyingTo === comment.id ? null : comment.id)}
                        className="text-xs text-gray-500 hover:text-gray-700"
                      >
                        Reply
                      </button>
                      {comment.author_id === user?.id && (
                        <button
                          onClick={() => deleteComment(documentId, comment.id)}
                          className="text-xs text-red-500 hover:text-red-700"
                        >
                          Delete
                        </button>
                      )}
                    </div>

                    {/* Replies */}
                    {comment.replies && comment.replies.length > 0 && (
                      <div className="mt-3 space-y-3 pl-4 border-l-2 border-gray-200">
                        {comment.replies.map((reply) => (
                          <div key={reply.id}>
                            <div className="flex items-center gap-2">
                              <div
                                className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs"
                                style={{ backgroundColor: reply.author?.avatar_color || '#3B82F6' }}
                              >
                                {reply.author?.name?.charAt(0).toUpperCase() || '?'}
                              </div>
                              <span className="text-xs font-medium">{reply.author?.name}</span>
                              <span className="text-xs text-gray-500">{formatTime(reply.created_at)}</span>
                            </div>
                            <p className="text-sm text-gray-700 mt-1 ml-8">{reply.content}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Reply form */}
                    {replyingTo === comment.id && (
                      <div className="mt-3">
                        <textarea
                          value={replyContent}
                          onChange={(e) => setReplyContent(e.target.value)}
                          placeholder="Reply..."
                          rows={2}
                          className="w-full px-3 py-2 border border-docs-border rounded text-sm focus:outline-none focus:border-docs-blue resize-none"
                          autoFocus
                        />
                        <div className="flex justify-end gap-2 mt-1">
                          <button
                            onClick={() => {
                              setReplyingTo(null);
                              setReplyContent('');
                            }}
                            className="px-3 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleReply(comment.id)}
                            disabled={!replyContent.trim()}
                            className="px-3 py-1 text-xs bg-docs-blue text-white rounded disabled:opacity-50"
                          >
                            Reply
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
