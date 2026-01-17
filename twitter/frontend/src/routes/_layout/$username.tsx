import { createFileRoute, useParams, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Timeline } from '../../components/Timeline';
import { useTimelineStore } from '../../stores/timelineStore';
import { useAuthStore } from '../../stores/authStore';
import { usersApi } from '../../services/api';
import { User } from '../../types';
import { formatNumber } from '../../utils/format';

export const Route = createFileRoute('/_layout/$username')({
  component: ProfilePage,
});

function ProfilePage() {
  const { username } = useParams({ from: '/_layout/$username' });
  const { user: currentUser } = useAuthStore();
  const { tweets, isLoading, error, nextCursor, fetchUserTimeline, loadMore } = useTimelineStore();

  const [profile, setProfile] = useState<User | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);

  useEffect(() => {
    const fetchProfile = async () => {
      setProfileLoading(true);
      setProfileError(null);
      try {
        const { user } = await usersApi.getUser(username);
        setProfile(user);
        setIsFollowing(user.isFollowing || false);
      } catch (err) {
        setProfileError((err as Error).message);
      } finally {
        setProfileLoading(false);
      }
    };

    fetchProfile();
    fetchUserTimeline(username);
  }, [username, fetchUserTimeline]);

  const handleFollow = async () => {
    if (!profile || !currentUser) return;

    setFollowLoading(true);
    try {
      if (isFollowing) {
        await usersApi.unfollow(profile.id);
        setIsFollowing(false);
        setProfile((p) => p ? { ...p, followerCount: p.followerCount - 1 } : p);
      } else {
        await usersApi.follow(profile.id);
        setIsFollowing(true);
        setProfile((p) => p ? { ...p, followerCount: p.followerCount + 1 } : p);
      }
    } catch (err) {
      console.error('Follow error:', err);
    } finally {
      setFollowLoading(false);
    }
  };

  if (profileLoading) {
    return (
      <div className="p-8 text-center">
        <div className="inline-block w-8 h-8 border-4 border-twitter-blue border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (profileError || !profile) {
    return (
      <div className="p-8 text-center">
        <p className="text-red-500">{profileError || 'User not found'}</p>
      </div>
    );
  }

  const isOwnProfile = currentUser?.username === profile.username;

  return (
    <div>
      <header className="sticky top-0 bg-white/80 backdrop-blur border-b border-twitter-extraLightGray z-10">
        <div className="flex items-center gap-4 p-4">
          <Link to="/" className="p-2 hover:bg-gray-100 rounded-full">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </Link>
          <div>
            <h1 className="text-xl font-bold">{profile.displayName}</h1>
            <p className="text-sm text-twitter-gray">{formatNumber(profile.tweetCount)} tweets</p>
          </div>
        </div>
      </header>

      {/* Profile banner */}
      <div className="h-48 bg-twitter-blue"></div>

      {/* Profile info */}
      <div className="relative px-4 pb-4 border-b border-twitter-extraLightGray">
        {/* Avatar */}
        <div className="absolute -top-16 w-32 h-32 rounded-full border-4 border-white bg-twitter-blue flex items-center justify-center text-white text-4xl font-bold">
          {profile.displayName.charAt(0).toUpperCase()}
        </div>

        {/* Follow button */}
        <div className="flex justify-end pt-4">
          {!isOwnProfile && currentUser && (
            <button
              onClick={handleFollow}
              disabled={followLoading}
              className={`px-4 py-2 rounded-full font-bold transition-colors ${
                isFollowing
                  ? 'border border-twitter-gray text-twitter-dark hover:border-red-500 hover:text-red-500 hover:bg-red-50'
                  : 'bg-twitter-dark text-white hover:bg-gray-800'
              }`}
            >
              {followLoading ? '...' : isFollowing ? 'Following' : 'Follow'}
            </button>
          )}
        </div>

        {/* User info */}
        <div className="mt-8">
          <h2 className="text-xl font-bold">{profile.displayName}</h2>
          <p className="text-twitter-gray">@{profile.username}</p>

          {profile.bio && (
            <p className="mt-3">{profile.bio}</p>
          )}

          <div className="flex items-center gap-4 mt-3 text-sm">
            <Link to={`/${username}/following`} className="hover:underline">
              <span className="font-bold">{formatNumber(profile.followingCount)}</span>{' '}
              <span className="text-twitter-gray">Following</span>
            </Link>
            <Link to={`/${username}/followers`} className="hover:underline">
              <span className="font-bold">{formatNumber(profile.followerCount)}</span>{' '}
              <span className="text-twitter-gray">Followers</span>
            </Link>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-twitter-extraLightGray">
        <button className="flex-1 py-4 text-center font-bold border-b-4 border-twitter-blue">
          Tweets
        </button>
        <button className="flex-1 py-4 text-center text-twitter-gray hover:bg-gray-50">
          Replies
        </button>
        <button className="flex-1 py-4 text-center text-twitter-gray hover:bg-gray-50">
          Likes
        </button>
      </div>

      <Timeline
        tweets={tweets}
        isLoading={isLoading}
        error={error}
        onLoadMore={loadMore}
        hasMore={!!nextCursor}
        emptyMessage={`@${profile.username} hasn't tweeted yet`}
      />
    </div>
  );
}
