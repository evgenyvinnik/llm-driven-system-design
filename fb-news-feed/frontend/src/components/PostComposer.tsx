/**
 * @fileoverview PostComposer component for creating new posts.
 * Provides a text area, image URL input, and privacy selector.
 * Integrates with feed store to add new posts optimistically.
 */

import { useState } from 'react';
import { Avatar } from './Avatar';
import { Button } from './Button';
import { useAuthStore } from '@/stores/authStore';
import { useFeedStore } from '@/stores/feedStore';
import { postsApi } from '@/services/api';

/**
 * Form component for creating new posts.
 * Only renders when user is authenticated.
 * Supports text content, optional image URLs, and privacy settings.
 *
 * @returns JSX element rendering the post composer or null if not authenticated
 */
export function PostComposer() {
  const [content, setContent] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [privacy, setPrivacy] = useState<'public' | 'friends'>('public');
  const [showImageInput, setShowImageInput] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { user } = useAuthStore();
  const { addPost } = useFeedStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() && !imageUrl.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const post = await postsApi.createPost({
        content: content.trim(),
        image_url: imageUrl.trim() || undefined,
        post_type: imageUrl.trim() ? 'image' : 'text',
        privacy,
      });

      addPost(post);
      setContent('');
      setImageUrl('');
      setShowImageInput(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create post');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!user) return null;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <form onSubmit={handleSubmit}>
        <div className="flex gap-3">
          <Avatar src={user.avatar_url} name={user.display_name} size="md" />
          <div className="flex-1">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={`What's on your mind, ${user.display_name.split(' ')[0]}?`}
              className="w-full resize-none border-0 bg-gray-100 rounded-full px-4 py-2.5 text-facebook-text placeholder-facebook-darkGray focus:outline-none focus:ring-2 focus:ring-facebook-blue focus:bg-white transition-all"
              rows={1}
              onFocus={(e) => {
                e.target.style.borderRadius = '1rem';
                e.target.rows = 3;
              }}
              onBlur={(e) => {
                if (!content.trim()) {
                  e.target.style.borderRadius = '9999px';
                  e.target.rows = 1;
                }
              }}
            />
          </div>
        </div>

        {showImageInput && (
          <div className="mt-3 ml-13 pl-13">
            <input
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="Enter image URL..."
              className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-facebook-blue focus:border-transparent"
            />
            {imageUrl && (
              <div className="mt-2 relative">
                <img
                  src={imageUrl}
                  alt="Preview"
                  className="w-full max-h-64 object-cover rounded-lg"
                  onError={() => setError('Invalid image URL')}
                />
                <button
                  type="button"
                  onClick={() => {
                    setImageUrl('');
                    setShowImageInput(false);
                  }}
                  className="absolute top-2 right-2 bg-gray-800 bg-opacity-70 text-white rounded-full p-1 hover:bg-opacity-100"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mt-2 text-red-500 text-sm">{error}</div>
        )}

        <div className="mt-3 pt-3 border-t border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowImageInput(!showImageInput)}
              className="flex items-center gap-2 px-3 py-1.5 text-facebook-darkGray hover:bg-gray-100 rounded-lg transition-colors"
            >
              <svg className="w-6 h-6 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="text-sm font-medium">Photo</span>
            </button>

            <select
              value={privacy}
              onChange={(e) => setPrivacy(e.target.value as 'public' | 'friends')}
              className="text-sm text-facebook-darkGray bg-gray-100 border-0 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-facebook-blue"
            >
              <option value="public">Public</option>
              <option value="friends">Friends</option>
            </select>
          </div>

          <Button
            type="submit"
            disabled={(!content.trim() && !imageUrl.trim()) || isSubmitting}
            isLoading={isSubmitting}
          >
            Post
          </Button>
        </div>
      </form>
    </div>
  );
}
