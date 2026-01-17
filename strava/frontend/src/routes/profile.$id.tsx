import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { users, activities as activitiesApi } from '../services/api';
import { User, Activity } from '../types';
import { ActivityCard } from '../components/ActivityCard';
import { useAuthStore } from '../stores/authStore';

function Profile() {
  const { id } = Route.useParams();
  const { user: currentUser, isAuthenticated } = useAuthStore();
  const [profile, setProfile] = useState<User | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);

  useEffect(() => {
    const loadProfile = async () => {
      try {
        setLoading(true);
        const [profileData, activitiesData] = await Promise.all([
          users.get(id),
          activitiesApi.list({ userId: id, limit: 10 }),
        ]);
        setProfile(profileData);
        setActivities(activitiesData.activities);
        setIsFollowing(profileData.isFollowing || false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      } finally {
        setLoading(false);
      }
    };

    loadProfile();
  }, [id]);

  const handleFollow = async () => {
    if (!isAuthenticated) return;

    try {
      if (isFollowing) {
        await users.unfollow(id);
        setIsFollowing(false);
      } else {
        await users.follow(id);
        setIsFollowing(true);
      }
    } catch (err) {
      console.error('Follow error:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-strava-gray-600">Loading profile...</div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
        {error || 'Profile not found'}
      </div>
    );
  }

  const isOwnProfile = currentUser?.id === id;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Profile Header */}
      <div className="bg-white rounded-lg shadow mb-6 p-6">
        <div className="flex items-start gap-6">
          <div className="w-24 h-24 bg-strava-orange rounded-full flex items-center justify-center text-white text-4xl font-bold flex-shrink-0">
            {profile.profilePhoto ? (
              <img
                src={profile.profilePhoto}
                alt={profile.username}
                className="w-24 h-24 rounded-full"
              />
            ) : (
              profile.username.charAt(0).toUpperCase()
            )}
          </div>

          <div className="flex-1">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-bold text-strava-gray-800">
                  {profile.username}
                </h1>
                {profile.location && (
                  <p className="text-strava-gray-500">{profile.location}</p>
                )}
              </div>

              {!isOwnProfile && isAuthenticated && (
                <button
                  onClick={handleFollow}
                  className={`px-4 py-2 rounded-lg font-medium ${
                    isFollowing
                      ? 'bg-strava-gray-200 text-strava-gray-700'
                      : 'bg-strava-orange text-white hover:bg-strava-orange-dark'
                  }`}
                >
                  {isFollowing ? 'Following' : 'Follow'}
                </button>
              )}
            </div>

            {profile.bio && (
              <p className="mt-2 text-strava-gray-600">{profile.bio}</p>
            )}

            {/* Stats */}
            <div className="flex gap-6 mt-4">
              <div>
                <div className="text-2xl font-bold">{profile.activityCount || 0}</div>
                <div className="text-sm text-strava-gray-500">Activities</div>
              </div>
              <Link to={`/profile/${id}/followers`} className="hover:opacity-80">
                <div className="text-2xl font-bold">{profile.followerCount || 0}</div>
                <div className="text-sm text-strava-gray-500">Followers</div>
              </Link>
              <Link to={`/profile/${id}/following`} className="hover:opacity-80">
                <div className="text-2xl font-bold">{profile.followingCount || 0}</div>
                <div className="text-sm text-strava-gray-500">Following</div>
              </Link>
            </div>
          </div>
        </div>

        {isOwnProfile && (
          <div className="mt-6 pt-4 border-t border-strava-gray-100">
            <Link
              to="/stats"
              className="inline-block px-4 py-2 bg-strava-gray-100 text-strava-gray-700 rounded-lg hover:bg-strava-gray-200"
            >
              View Your Stats & Achievements
            </Link>
          </div>
        )}
      </div>

      {/* Recent Activities */}
      <div>
        <h2 className="text-xl font-bold text-strava-gray-800 mb-4">
          Recent Activities
        </h2>

        {activities.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <div className="text-4xl mb-4">🏃</div>
            <p className="text-strava-gray-600">
              {isOwnProfile
                ? "You haven't recorded any activities yet."
                : "This athlete hasn't recorded any public activities yet."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {activities.map((activity) => (
              <ActivityCard key={activity.id} activity={activity} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/profile/$id')({
  component: Profile,
});
