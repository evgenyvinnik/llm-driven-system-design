import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { Post, Comment, CommentSortType } from '../types';
import api from '../services/api';
import { VoteButtons } from '../components/VoteButtons';
import { CommentThread } from '../components/CommentThread';
import { formatTimeAgo } from '../utils/format';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/r/$subreddit/comments/$postId')({
  component: PostPage,
  validateSearch: (search: Record<string, unknown>): { sort?: CommentSortType } => ({
    sort: (search.sort as CommentSortType) || 'best',
  }),
});

function PostPage() {
  const { subreddit, postId } = Route.useParams();
  const { sort } = Route.useSearch();
  const user = useAuthStore((state) => state.user);

  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newComment, setNewComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    setError(null);

    api
      .getPostWithComments(parseInt(postId), sort || 'best')
      .then(({ post: p, comments: c }) => {
        setPost(p);
        setComments(c);
      })
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [postId, sort]);

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || isSubmitting || !post) return;

    setIsSubmitting(true);
    try {
      const comment = await api.createComment(post.id, newComment.trim());
      setComments([{ ...comment, replies: [] }, ...comments]);
      setNewComment('');
    } catch (err) {
      console.error('Failed to submit comment:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReplyAdded = (reply: Comment) => {
    // Add reply to the correct parent in the tree
    const addReplyToTree = (commentList: Comment[]): Comment[] => {
      return commentList.map((c) => {
        if (c.id === reply.parent_id) {
          return { ...c, replies: [...c.replies, { ...reply, replies: [] }] };
        }
        if (c.replies.length > 0) {
          return { ...c, replies: addReplyToTree(c.replies) };
        }
        return c;
      });
    };
    setComments(addReplyToTree(comments));
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded border border-gray-200 p-8 text-center text-gray-500">
        Loading post...
      </div>
    );
  }

  if (error || !post) {
    return (
      <div className="bg-white rounded border border-gray-200 p-8 text-center text-red-500">
        {error || 'Post not found'}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Post */}
      <div className="bg-white rounded border border-gray-200 p-4">
        <div className="flex">
          <VoteButtons
            type="post"
            id={post.id}
            score={post.score}
            userVote={post.userVote}
          />

          <div className="flex-1">
            <div className="text-xs text-gray-500 mb-2">
              <Link
                to="/r/$subreddit"
                params={{ subreddit }}
                className="font-bold text-gray-900 hover:underline"
              >
                r/{subreddit}
              </Link>
              {' '}
              <span>Posted by u/{post.author_username}</span>
              {' '}
              <span>{formatTimeAgo(post.created_at)}</span>
            </div>

            <h1 className="text-xl font-medium text-gray-900 mb-2">{post.title}</h1>

            {post.url && (
              <a
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-reddit-blue hover:underline mb-2 block"
              >
                {post.url}
              </a>
            )}

            {post.content && (
              <div className="text-sm text-gray-800 whitespace-pre-wrap">{post.content}</div>
            )}

            <div className="flex items-center gap-4 mt-4 text-xs text-gray-500">
              <span>{post.comment_count} comments</span>
            </div>
          </div>
        </div>
      </div>

      {/* Comment form */}
      {user && (
        <div className="bg-white rounded border border-gray-200 p-4 mt-4">
          <p className="text-xs text-gray-500 mb-2">
            Comment as <span className="text-reddit-blue">{user.username}</span>
          </p>
          <form onSubmit={handleSubmitComment}>
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="What are your thoughts?"
              className="w-full p-3 border border-gray-300 rounded resize-none focus:outline-none focus:border-reddit-blue"
              rows={4}
            />
            <div className="flex justify-end mt-2">
              <button
                type="submit"
                disabled={isSubmitting || !newComment.trim()}
                className="px-4 py-1.5 bg-reddit-blue text-white text-sm rounded-full disabled:opacity-50"
              >
                {isSubmitting ? 'Commenting...' : 'Comment'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Comment sort tabs */}
      <div className="bg-white rounded border border-gray-200 p-3 mt-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">Sort by:</span>
          {(['best', 'top', 'new', 'controversial'] as CommentSortType[]).map((s) => (
            <Link
              key={s}
              to="/r/$subreddit/comments/$postId"
              params={{ subreddit, postId }}
              search={{ sort: s }}
              className={`px-2 py-1 rounded capitalize ${
                (sort || 'best') === s ? 'bg-gray-200' : 'hover:bg-gray-100'
              }`}
            >
              {s}
            </Link>
          ))}
        </div>
      </div>

      {/* Comments */}
      <div className="bg-white rounded border border-gray-200 p-4 mt-4">
        {comments.length === 0 ? (
          <p className="text-center text-gray-500 py-8">
            No comments yet. {user ? 'Be the first to comment!' : 'Log in to comment.'}
          </p>
        ) : (
          <div className="space-y-4">
            {comments.map((comment) => (
              <CommentThread
                key={comment.id}
                comment={comment}
                postId={post.id}
                onReplyAdded={handleReplyAdded}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
