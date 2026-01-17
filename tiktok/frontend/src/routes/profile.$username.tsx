import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { User, Video } from '@/types';
import { usersApi, videosApi } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';

export const Route = createFileRoute('/profile/$username')({
  component: ProfilePage,
});

function ProfilePage() {
  const { username } = Route.useParams();
  const navigate = useNavigate();
  const { user: currentUser, logout, updateUser } = useAuthStore();

  const [profile, setProfile] = useState<User | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'videos' | 'likes'>('videos');

  useEffect(() => {
    loadProfile();
  }, [username]);

  const loadProfile = async () => {
    setIsLoading(true);
    setError('');

    try {
      const [profileData, videosData] = await Promise.all([
        usersApi.getProfile(username) as Promise<User>,
        videosApi.getUserVideos(username) as Promise<{ videos: Video[] }>,
      ]);

      setProfile(profileData);
      setVideos(videosData.videos);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFollow = async () => {
    if (!profile) return;

    try {
      if (profile.isFollowing) {
        await usersApi.unfollow(username);
        setProfile({
          ...profile,
          isFollowing: false,
          followerCount: profile.followerCount - 1,
        });
      } else {
        await usersApi.follow(username);
        setProfile({
          ...profile,
          isFollowing: true,
          followerCount: profile.followerCount + 1,
        });
      }
    } catch (err) {
      console.error('Follow/unfollow failed:', err);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/' });
  };

  const formatCount = (count: number): string => {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M';
    }
    if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'K';
    }
    return count.toString();
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center pb-14">
        <div className="spinner"></div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="flex-1 flex items-center justify-center pb-14">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error || 'User not found'}</p>
          <button onClick={() => navigate({ to: '/' })} className="btn-secondary">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  const isOwnProfile = currentUser?.username === username;

  return (
    <div className="flex-1 flex flex-col pb-14 overflow-y-auto">
      {/* Header */}
      <div className="p-4">
        {/* Profile Info */}
        <div className="flex flex-col items-center">
          {profile.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt={profile.displayName}
              className="w-24 h-24 rounded-full mb-4"
            />
          ) : (
            <div className="w-24 h-24 rounded-full bg-gray-600 flex items-center justify-center text-3xl mb-4">
              {profile.displayName?.[0]?.toUpperCase() || 'U'}
            </div>
          )}

          <h1 className="text-lg font-bold">@{profile.username}</h1>
          {profile.displayName !== profile.username && (
            <p className="text-gray-400">{profile.displayName}</p>
          )}

          {/* Stats */}
          <div className="flex gap-6 mt-4">
            <div className="text-center">
              <p className="font-bold">{formatCount(profile.followingCount)}</p>
              <p className="text-xs text-gray-400">Following</p>
            </div>
            <div className="text-center">
              <p className="font-bold">{formatCount(profile.followerCount)}</p>
              <p className="text-xs text-gray-400">Followers</p>
            </div>
            <div className="text-center">
              <p className="font-bold">{formatCount(profile.likeCount)}</p>
              <p className="text-xs text-gray-400">Likes</p>
            </div>
          </div>

          {/* Bio */}
          {profile.bio && (
            <p className="text-sm text-gray-300 mt-4 text-center max-w-xs">
              {profile.bio}
            </p>
          )}

          {/* Action Button */}
          <div className="mt-4">
            {isOwnProfile ? (
              <div className="flex gap-2">
                <button
                  onClick={() => navigate({ to: '/settings' })}
                  className="btn-secondary"
                >
                  Edit profile
                </button>
                <button onClick={handleLogout} className="btn-outline">
                  Log out
                </button>
              </div>
            ) : (
              <button
                onClick={handleFollow}
                className={profile.isFollowing ? 'btn-secondary' : 'btn-primary'}
              >
                {profile.isFollowing ? 'Following' : 'Follow'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800">
        <button
          onClick={() => setActiveTab('videos')}
          className={`flex-1 py-3 text-center ${
            activeTab === 'videos'
              ? 'text-white border-b-2 border-white'
              : 'text-gray-500'
          }`}
        >
          <svg className="w-6 h-6 mx-auto" fill="currentColor" viewBox="0 0 24 24">
            <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z" />
          </svg>
        </button>
        <button
          onClick={() => setActiveTab('likes')}
          className={`flex-1 py-3 text-center ${
            activeTab === 'likes'
              ? 'text-white border-b-2 border-white'
              : 'text-gray-500'
          }`}
        >
          <svg className="w-6 h-6 mx-auto" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        </button>
      </div>

      {/* Video Grid */}
      <div className="flex-1">
        {activeTab === 'videos' && (
          <div className="grid grid-cols-3 gap-0.5">
            {videos.length === 0 ? (
              <div className="col-span-3 py-12 text-center text-gray-500">
                <p>No videos yet</p>
              </div>
            ) : (
              videos.map((video) => (
                <VideoThumbnail key={video.id} video={video} />
              ))
            )}
          </div>
        )}
        {activeTab === 'likes' && (
          <div className="py-12 text-center text-gray-500">
            <p>Liked videos</p>
            <p className="text-sm mt-2">Coming soon!</p>
          </div>
        )}
      </div>
    </div>
  );
}

function VideoThumbnail({ video }: { video: Video }) {
  const formatCount = (count: number): string => {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M';
    }
    if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'K';
    }
    return count.toString();
  };

  return (
    <div className="aspect-[9/16] bg-gray-800 relative group cursor-pointer">
      {video.thumbnailUrl ? (
        <img
          src={video.thumbnailUrl}
          alt={video.description}
          className="w-full h-full object-cover"
        />
      ) : (
        <video
          src={video.videoUrl}
          className="w-full h-full object-cover"
          muted
          preload="metadata"
        />
      )}
      <div className="absolute bottom-1 left-1 flex items-center gap-1 text-xs text-white">
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z" />
        </svg>
        {formatCount(video.viewCount)}
      </div>
    </div>
  );
}
