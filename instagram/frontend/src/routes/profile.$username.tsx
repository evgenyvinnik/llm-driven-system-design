import { useState, useEffect } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { usersApi, storiesApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import type { User, PostThumbnail, Story } from '../types';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { PostGrid } from '../components/PostGrid';
import { Modal } from '../components/Modal';
import { formatNumber } from '../utils/format';

export const Route = createFileRoute('/profile/$username')({
  component: ProfilePage,
});

function ProfilePage() {
  const { username } = Route.useParams();
  const { user: currentUser } = useAuthStore();
  const [profile, setProfile] = useState<User | null>(null);
  const [posts, setPosts] = useState<PostThumbnail[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [followLoading, setFollowLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'posts' | 'saved'>('posts');
  const [showFollowersModal, setShowFollowersModal] = useState(false);
  const [showFollowingModal, setShowFollowingModal] = useState(false);
  const [followers, setFollowers] = useState<User[]>([]);
  const [following, setFollowing] = useState<User[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const isOwnProfile = currentUser?.username === username;

  useEffect(() => {
    loadProfile();
  }, [username]);

  useEffect(() => {
    if (profile) {
      if (activeTab === 'posts') {
        loadPosts();
      } else if (activeTab === 'saved' && isOwnProfile) {
        loadSavedPosts();
      }
    }
  }, [profile, activeTab]);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const response = await usersApi.getProfile(username);
      setProfile(response.user);

      // Load stories if has any
      if (currentUser) {
        try {
          const storiesResponse = await storiesApi.getUserStories(response.user.id);
          setStories(storiesResponse.stories);
        } catch {
          // No stories or not accessible
        }
      }
    } catch (error) {
      console.error('Error loading profile:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadPosts = async (cursor?: string) => {
    try {
      const response = await usersApi.getPosts(username, cursor);
      if (cursor) {
        setPosts((prev) => [...prev, ...response.posts]);
      } else {
        setPosts(response.posts);
      }
      setNextCursor(response.nextCursor);
    } catch (error) {
      console.error('Error loading posts:', error);
    }
  };

  const loadSavedPosts = async (cursor?: string) => {
    try {
      const response = await usersApi.getSavedPosts(cursor);
      if (cursor) {
        setPosts((prev) => [...prev, ...response.posts]);
      } else {
        setPosts(response.posts);
      }
      setNextCursor(response.nextCursor);
    } catch (error) {
      console.error('Error loading saved posts:', error);
    }
  };

  const handleFollow = async () => {
    if (!profile) return;
    setFollowLoading(true);
    try {
      if (profile.isFollowing) {
        await usersApi.unfollow(profile.id);
        setProfile((prev) => prev ? { ...prev, isFollowing: false, followerCount: prev.followerCount - 1 } : null);
      } else {
        await usersApi.follow(profile.id);
        setProfile((prev) => prev ? { ...prev, isFollowing: true, followerCount: prev.followerCount + 1 } : null);
      }
    } catch (error) {
      console.error('Error following/unfollowing:', error);
    } finally {
      setFollowLoading(false);
    }
  };

  const loadFollowers = async () => {
    try {
      const response = await usersApi.getFollowers(username);
      setFollowers(response.followers);
      setShowFollowersModal(true);
    } catch (error) {
      console.error('Error loading followers:', error);
    }
  };

  const loadFollowing = async () => {
    try {
      const response = await usersApi.getFollowing(username);
      setFollowing(response.following);
      setShowFollowingModal(true);
    } catch (error) {
      console.error('Error loading following:', error);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-primary" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold mb-2">User not found</h2>
        <p className="text-text-gray">The user you're looking for doesn't exist.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Profile header */}
      <div className="flex items-start gap-8 mb-8 px-4">
        <Avatar
          src={profile.profilePictureUrl}
          alt={profile.username}
          size="xl"
          hasStory={stories.length > 0}
          hasSeenStory={stories.every((s) => s.hasViewed)}
        />
        <div className="flex-1">
          <div className="flex items-center gap-4 mb-4">
            <h1 className="text-xl">{profile.username}</h1>
            {isOwnProfile ? (
              <Link to="/settings">
                <Button variant="secondary" size="sm">Edit profile</Button>
              </Link>
            ) : (
              <Button
                variant={profile.isFollowing ? 'secondary' : 'primary'}
                size="sm"
                onClick={handleFollow}
                loading={followLoading}
              >
                {profile.isFollowing ? 'Following' : 'Follow'}
              </Button>
            )}
          </div>

          {/* Stats */}
          <div className="flex gap-8 mb-4">
            <span>
              <strong>{formatNumber(profile.postCount)}</strong> posts
            </span>
            <button onClick={loadFollowers} className="hover:underline">
              <strong>{formatNumber(profile.followerCount)}</strong> followers
            </button>
            <button onClick={loadFollowing} className="hover:underline">
              <strong>{formatNumber(profile.followingCount)}</strong> following
            </button>
          </div>

          {/* Bio */}
          <div>
            <p className="font-semibold">{profile.displayName}</p>
            {profile.bio && <p className="whitespace-pre-wrap">{profile.bio}</p>}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-t border-border-gray">
        <div className="flex justify-center gap-12">
          <button
            onClick={() => { setActiveTab('posts'); setPosts([]); }}
            className={`py-4 text-sm font-semibold tracking-wider uppercase flex items-center gap-1 border-t ${
              activeTab === 'posts' ? 'border-black' : 'border-transparent text-text-gray'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
            </svg>
            Posts
          </button>
          {isOwnProfile && (
            <button
              onClick={() => { setActiveTab('saved'); setPosts([]); }}
              className={`py-4 text-sm font-semibold tracking-wider uppercase flex items-center gap-1 border-t ${
                activeTab === 'saved' ? 'border-black' : 'border-transparent text-text-gray'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              Saved
            </button>
          )}
        </div>
      </div>

      {/* Posts grid */}
      <div className="py-4">
        <PostGrid posts={posts} loading={loading} />
        {nextCursor && (
          <button
            onClick={() => activeTab === 'posts' ? loadPosts(nextCursor) : loadSavedPosts(nextCursor)}
            className="w-full py-3 text-primary font-semibold"
          >
            Load more
          </button>
        )}
      </div>

      {/* Followers Modal */}
      <Modal
        isOpen={showFollowersModal}
        onClose={() => setShowFollowersModal(false)}
        title="Followers"
      >
        <div className="max-h-96 overflow-y-auto">
          {followers.map((follower) => (
            <Link
              key={follower.id}
              to="/profile/$username"
              params={{ username: follower.username }}
              className="flex items-center gap-3 p-4 hover:bg-gray-50"
              onClick={() => setShowFollowersModal(false)}
            >
              <Avatar src={follower.profilePictureUrl} alt={follower.username} size="md" />
              <div className="flex-1">
                <p className="font-semibold text-sm">{follower.username}</p>
                <p className="text-sm text-text-gray">{follower.displayName}</p>
              </div>
            </Link>
          ))}
        </div>
      </Modal>

      {/* Following Modal */}
      <Modal
        isOpen={showFollowingModal}
        onClose={() => setShowFollowingModal(false)}
        title="Following"
      >
        <div className="max-h-96 overflow-y-auto">
          {following.map((followed) => (
            <Link
              key={followed.id}
              to="/profile/$username"
              params={{ username: followed.username }}
              className="flex items-center gap-3 p-4 hover:bg-gray-50"
              onClick={() => setShowFollowingModal(false)}
            >
              <Avatar src={followed.profilePictureUrl} alt={followed.username} size="md" />
              <div className="flex-1">
                <p className="font-semibold text-sm">{followed.username}</p>
                <p className="text-sm text-text-gray">{followed.displayName}</p>
              </div>
            </Link>
          ))}
        </div>
      </Modal>
    </div>
  );
}
