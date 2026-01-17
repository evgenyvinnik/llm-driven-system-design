/**
 * @fileoverview Posts table component for the admin dashboard.
 * Displays a list of posts with their metadata and engagement stats.
 */

import type { Post } from '../../types';

/**
 * Props for the PostsTable component.
 */
interface PostsTableProps {
  /** Array of posts to display */
  posts: Post[];
}

/**
 * Renders a table of posts for admin review.
 * Shows author, content preview, type, visibility, and engagement metrics.
 *
 * @param props - PostsTable props
 * @returns Table displaying post information
 */
export function PostsTable({ posts }: PostsTableProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Author
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Content
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Type
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Visibility
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Engagement
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {posts.map((post) => (
            <PostRow key={post.id} post={post} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Props for the PostRow sub-component.
 */
interface PostRowProps {
  /** Post to display in the row */
  post: Post;
}

/**
 * Renders a single post row in the posts table.
 *
 * @param props - PostRow props
 * @returns Table row with post details
 */
function PostRow({ post }: PostRowProps) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-4 text-sm text-gray-900">
        {post.author_name}
      </td>
      <td className="px-6 py-4 text-sm text-gray-600 max-w-xs truncate">
        {post.content}
      </td>
      <td className="px-6 py-4">
        <span className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-700 capitalize">
          {post.post_type}
        </span>
      </td>
      <td className="px-6 py-4">
        <span className="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-700 capitalize">
          {post.visibility}
        </span>
      </td>
      <td className="px-6 py-4 text-sm text-gray-600">
        {post.like_count} likes, {post.comment_count} comments
      </td>
    </tr>
  );
}
