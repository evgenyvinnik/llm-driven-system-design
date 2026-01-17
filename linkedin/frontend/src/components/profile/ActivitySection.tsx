/**
 * Activity section component displaying user's recent posts.
 * Shows a list of posts the user has published in their feed.
 *
 * @module components/profile/ActivitySection
 */
import type { Post } from '../../types';
import { PostCard } from '../PostCard';

/**
 * Props for the ActivitySection component.
 */
interface ActivitySectionProps {
  /** List of user's posts to display */
  posts: Post[];
}

/**
 * Displays the "Activity" section of a user's profile.
 * Shows the user's published posts using the PostCard component.
 *
 * @param props - Component props
 * @returns The activity section JSX element
 */
export function ActivitySection({ posts }: ActivitySectionProps) {
  return (
    <div className="card p-6">
      <h2 className="text-xl font-semibold mb-4">Activity</h2>

      {posts.length === 0 ? (
        <p className="text-gray-500">No posts yet</p>
      ) : (
        <div className="space-y-4">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}
