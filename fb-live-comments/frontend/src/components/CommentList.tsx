import { useRef, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { CommentItem } from './CommentItem';

export function CommentList() {
  const comments = useAppStore((state) => state.comments);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new comments arrive
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [comments.length]);

  return (
    <div
      ref={listRef}
      className="flex flex-col gap-2 overflow-y-auto scrollbar-thin h-full p-2"
    >
      {comments.length === 0 ? (
        <div className="text-gray-500 text-center py-8">
          <p className="text-lg mb-2">No comments yet</p>
          <p className="text-sm">Be the first to comment!</p>
        </div>
      ) : (
        comments.map((comment) => (
          <CommentItem key={comment.id} comment={comment} />
        ))
      )}
    </div>
  );
}
