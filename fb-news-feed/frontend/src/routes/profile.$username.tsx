import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { PostCard } from '@/components/PostCard';
import { useAuthStore } from '@/stores/authStore';
import { usersApi, postsApi } from '@/services/api';
import type { UserWithFollowStatus, Post } from '@/types';
import { formatNumber } from '@/utils';

export const Route = createFileRoute('/profile/$username')({
  component: ProfilePage,
});

function ProfilePage() {
  const { username } = Route.useParams();
  const { user: currentUser, isAuthenticated } = useAuthStore();

  const [profile, setProfile] = useState<UserWithFollowStatus | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingPosts, setIsLoadingPosts] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMorePosts, setHasMorePosts] = useState(true);
  const [activeTab, setActiveTab] = useState<'posts' | 'followers' | 'following'>('posts');

  useEffect(() => {
    loadProfile();
  }, [username]);

  const loadProfile = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [profileData, postsData] = await Promise.all([
        usersApi.getUser(username),
        usersApi.getUserPosts(username),
      ]);
      setProfile(profileData);
      setIsFollowing(profileData.is_following);
      setPosts(postsData.posts);
      setCursor(postsData.cursor);
      setHasMorePosts(postsData.has_more);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
    } finally {
      setIsLoading(false);
    }
  };

  const loadMorePosts = async () => {
    if (isLoadingPosts || !hasMorePosts || !cursor) return;
    setIsLoadingPosts(true);
    try {
      const data = await usersApi.getUserPosts(username, cursor);
      setPosts((prev) => [...prev, ...data.posts]);
      setCursor(data.cursor);
      setHasMorePosts(data.has_more);
    } catch (err) {
      console.error('Failed to load more posts:', err);
    } finally {
      setIsLoadingPosts(false);
    }
  };

  const handleFollow = async () => {
    if (!isAuthenticated || !profile) return;
    try {
      if (isFollowing) {
        await usersApi.unfollow(username);
        setIsFollowing(false);
        setProfile((prev) =>
          prev ? { ...prev, follower_count: prev.follower_count - 1 } : prev
        );
      } else {
        await usersApi.follow(username);
        setIsFollowing(true);
        setProfile((prev) =>
          prev ? { ...prev, follower_count: prev.follower_count + 1 } : prev
        );
      }
    } catch (err) {
      console.error('Follow action failed:', err);
    }
  };

  const handleDeletePost = async (postId: string) => {
    if (!confirm('Are you sure you want to delete this post?')) return;
    try {
      await postsApi.deletePost(postId);
      setPosts((prev) => prev.filter((p) => p.id !== postId));
    } catch (err) {
      console.error('Failed to delete post:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-facebook-blue" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="max-w-2xl mx-auto py-20 text-center">
        <h2 className="text-2xl font-bold text-facebook-text mb-2">User not found</h2>
        <p className="text-facebook-darkGray mb-4">{error || 'This user does not exist.'}</p>
        <Link to="/" className="text-facebook-blue hover:underline">
          Go back home
        </Link>
      </div>
    );
  }

  const isSelf = currentUser?.id === profile.id;

  return (
    <div className="bg-white">
      {/* Cover Photo */}
      <div className="h-48 md:h-72 bg-gradient-to-r from-blue-400 to-blue-600" />

      {/* Profile Header */}
      <div className="max-w-4xl mx-auto px-4">
        <div className="relative flex flex-col md:flex-row md:items-end -mt-16 md:-mt-8 pb-4 border-b border-gray-200">
          {/* Avatar */}
          <div className="relative">
            <div className="w-32 h-32 md:w-40 md:h-40 rounded-full border-4 border-white bg-white">
              <Avatar
                src={profile.avatar_url}
                name={profile.display_name}
                size="xl"
                className="w-full h-full"
              />
            </div>
          </div>

          {/* Info */}
          <div className="mt-4 md:mt-0 md:ml-6 flex-1">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between">
              <div>
                <h1 className="text-3xl font-bold text-facebook-text flex items-center gap-2">
                  {profile.display_name}
                  {profile.is_celebrity && (
                    <span className="text-facebook-blue">
                      <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </span>
                  )}
                </h1>
                <p className="text-facebook-darkGray">@{profile.username}</p>
              </div>

              {/* Actions */}
              <div className="mt-4 md:mt-0 flex gap-2">
                {isSelf ? (
                  <Button variant="secondary">Edit Profile</Button>
                ) : isAuthenticated ? (
                  <Button
                    variant={isFollowing ? 'secondary' : 'primary'}
                    onClick={handleFollow}
                  >
                    {isFollowing ? 'Following' : 'Follow'}
                  </Button>
                ) : null}
              </div>
            </div>

            {/* Bio */}
            {profile.bio && (
              <p className="mt-2 text-facebook-text">{profile.bio}</p>
            )}

            {/* Stats */}
            <div className="mt-4 flex gap-6">
              <button
                onClick={() => setActiveTab('followers')}
                className="text-center hover:underline"
              >
                <span className="font-bold text-facebook-text">
                  {formatNumber(profile.follower_count)}
                </span>{' '}
                <span className="text-facebook-darkGray">Followers</span>
              </button>
              <button
                onClick={() => setActiveTab('following')}
                className="text-center hover:underline"
              >
                <span className="font-bold text-facebook-text">
                  {formatNumber(profile.following_count)}
                </span>{' '}
                <span className="text-facebook-darkGray">Following</span>
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200">
          <button
            onClick={() => setActiveTab('posts')}
            className={`px-4 py-4 font-semibold transition-colors relative ${
              activeTab === 'posts'
                ? 'text-facebook-blue'
                : 'text-facebook-darkGray hover:bg-gray-100'
            }`}
          >
            Posts
            {activeTab === 'posts' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-facebook-blue" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('followers')}
            className={`px-4 py-4 font-semibold transition-colors relative ${
              activeTab === 'followers'
                ? 'text-facebook-blue'
                : 'text-facebook-darkGray hover:bg-gray-100'
            }`}
          >
            Followers
            {activeTab === 'followers' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-facebook-blue" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('following')}
            className={`px-4 py-4 font-semibold transition-colors relative ${
              activeTab === 'following'
                ? 'text-facebook-blue'
                : 'text-facebook-darkGray hover:bg-gray-100'
            }`}
          >
            Following
            {activeTab === 'following' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-facebook-blue" />
            )}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-2xl mx-auto py-6 px-4 bg-facebook-gray min-h-screen">
        {activeTab === 'posts' && (
          <div className="space-y-4">
            {posts.length === 0 ? (
              <div className="bg-white rounded-lg shadow-sm p-8 text-center">
                <p className="text-facebook-darkGray">No posts yet.</p>
              </div>
            ) : (
              <>
                {posts.map((post) => (
                  <PostCard
                    key={post.id}
                    post={post}
                    onDelete={isSelf ? () => handleDeletePost(post.id) : undefined}
                  />
                ))}

                {hasMorePosts && (
                  <div className="text-center py-4">
                    <Button
                      variant="secondary"
                      onClick={loadMorePosts}
                      isLoading={isLoadingPosts}
                    >
                      Load more
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'followers' && (
          <FollowList username={username} type="followers" />
        )}

        {activeTab === 'following' && (
          <FollowList username={username} type="following" />
        )}
      </div>
    </div>
  );
}

function FollowList({ username, type }: { username: string; type: 'followers' | 'following' }) {
  const [users, setUsers] = useState<Array<{
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
    is_celebrity: boolean;
  }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    loadUsers();
  }, [username, type]);

  const loadUsers = async () => {
    setIsLoading(true);
    try {
      const data =
        type === 'followers'
          ? await usersApi.getFollowers(username, 0)
          : await usersApi.getFollowing(username, 0);
      setUsers(data.users);
      setHasMore(data.has_more);
      setOffset(20);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadMore = async () => {
    const data =
      type === 'followers'
        ? await usersApi.getFollowers(username, offset)
        : await usersApi.getFollowing(username, offset);
    setUsers((prev) => [...prev, ...data.users]);
    setHasMore(data.has_more);
    setOffset((prev) => prev + 20);
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-facebook-blue" />
      </div>
    );
  }

  if (users.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-8 text-center">
        <p className="text-facebook-darkGray">
          {type === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm">
      {users.map((user) => (
        <Link
          key={user.id}
          to="/profile/$username"
          params={{ username: user.username }}
          className="flex items-center gap-3 p-4 hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-0"
        >
          <Avatar src={user.avatar_url} name={user.display_name} size="md" />
          <div>
            <div className="font-semibold text-facebook-text flex items-center gap-1">
              {user.display_name}
              {user.is_celebrity && (
                <svg className="w-4 h-4 text-facebook-blue" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </div>
            <div className="text-sm text-facebook-darkGray">@{user.username}</div>
          </div>
        </Link>
      ))}

      {hasMore && (
        <div className="p-4 text-center">
          <Button variant="secondary" onClick={loadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
