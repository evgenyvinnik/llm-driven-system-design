import { useState } from 'react';
import { tweetsApi } from '../services/api';
import { useTimelineStore } from '../stores/timelineStore';
import { useAuthStore } from '../stores/authStore';

interface ComposeTweetProps {
  replyTo?: string;
  onSuccess?: () => void;
  placeholder?: string;
}

export function ComposeTweet({ replyTo, onSuccess, placeholder = "What's happening?" }: ComposeTweetProps) {
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuthStore();
  const { addTweet } = useTimelineStore();

  const maxLength = 280;
  const remaining = maxLength - content.length;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!content.trim() || content.length > maxLength) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const { tweet } = await tweetsApi.create(content.trim(), { replyTo });
      addTweet(tweet);
      setContent('');
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!user) {
    return (
      <div className="p-4 border-b border-twitter-extraLightGray bg-white">
        <p className="text-twitter-gray text-center">
          <a href="/login" className="text-twitter-blue hover:underline">Log in</a> to tweet
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="p-4 border-b border-twitter-extraLightGray bg-white">
      <div className="flex gap-3">
        <div className="w-12 h-12 rounded-full bg-twitter-blue flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
          {user.displayName.charAt(0).toUpperCase()}
        </div>

        <div className="flex-1">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={placeholder}
            className="w-full resize-none border-0 focus:ring-0 text-xl placeholder-twitter-gray outline-none min-h-[80px]"
            rows={3}
          />

          {error && (
            <p className="text-red-500 text-sm mb-2">{error}</p>
          )}

          <div className="flex items-center justify-between border-t border-twitter-extraLightGray pt-3 mt-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="p-2 rounded-full hover:bg-blue-50 text-twitter-blue transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </button>
            </div>

            <div className="flex items-center gap-4">
              <div className={`text-sm ${remaining < 0 ? 'text-red-500' : remaining < 20 ? 'text-yellow-500' : 'text-twitter-gray'}`}>
                {remaining}
              </div>

              <button
                type="submit"
                disabled={!content.trim() || content.length > maxLength || isSubmitting}
                className="px-4 py-2 bg-twitter-blue text-white rounded-full font-bold hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? 'Posting...' : replyTo ? 'Reply' : 'Tweet'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
