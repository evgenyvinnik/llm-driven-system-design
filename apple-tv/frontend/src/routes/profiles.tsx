import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { Plus, User, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Profile } from '../types';

function ProfilesPage() {
  const navigate = useNavigate();
  const { user, profiles, selectProfile, createProfile, deleteProfile } = useAuthStore();
  const [isCreating, setIsCreating] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [isKids, setIsKids] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  if (!user) {
    navigate({ to: '/login' });
    return null;
  }

  const handleSelectProfile = async (profile: Profile) => {
    if (isEditing) return;
    try {
      await selectProfile(profile);
      navigate({ to: '/' });
    } catch (error) {
      console.error('Failed to select profile:', error);
    }
  };

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return;
    try {
      await createProfile(newProfileName.trim(), isKids);
      setNewProfileName('');
      setIsKids(false);
      setIsCreating(false);
    } catch (error) {
      console.error('Failed to create profile:', error);
    }
  };

  const handleDeleteProfile = async (profileId: string) => {
    if (confirm('Are you sure you want to delete this profile?')) {
      try {
        await deleteProfile(profileId);
      } catch (error) {
        console.error('Failed to delete profile:', error);
      }
    }
  };

  const colors = [
    'from-blue-500 to-purple-600',
    'from-green-500 to-teal-600',
    'from-orange-500 to-red-600',
    'from-pink-500 to-rose-600',
    'from-yellow-500 to-orange-600',
    'from-cyan-500 to-blue-600',
  ];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <Link to="/" className="inline-flex items-center space-x-2 mb-12">
        <svg className="w-12 h-12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 22C7.79 22.05 6.8 20.68 5.96 19.47C4.25 17 2.94 12.45 4.7 9.39C5.57 7.87 7.13 6.91 8.82 6.88C10.1 6.86 11.32 7.75 12.11 7.75C12.89 7.75 14.37 6.68 15.92 6.84C16.57 6.87 18.39 7.1 19.56 8.82C19.47 8.88 17.39 10.1 17.41 12.63C17.44 15.65 20.06 16.66 20.09 16.67C20.06 16.74 19.67 18.11 18.71 19.5ZM13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z" />
        </svg>
        <span className="text-2xl font-semibold">tv+</span>
      </Link>

      <h1 className="text-3xl font-semibold mb-8">Who's watching?</h1>

      <div className="flex flex-wrap justify-center gap-6 mb-8">
        {profiles.map((profile, index) => (
          <div key={profile.id} className="relative group">
            <button
              onClick={() => handleSelectProfile(profile)}
              className="flex flex-col items-center"
            >
              <div
                className={`w-32 h-32 rounded-lg bg-gradient-to-br ${colors[index % colors.length]} flex items-center justify-center text-4xl font-semibold transition-transform group-hover:scale-105 group-hover:ring-4 ring-white`}
              >
                {profile.avatar_url ? (
                  <img
                    src={profile.avatar_url}
                    alt={profile.name}
                    className="w-full h-full object-cover rounded-lg"
                  />
                ) : (
                  profile.name.charAt(0).toUpperCase()
                )}
              </div>
              <span className="mt-3 text-lg text-white/80 group-hover:text-white">
                {profile.name}
              </span>
              {profile.is_kids && (
                <span className="text-xs text-apple-blue">Kids</span>
              )}
            </button>

            {isEditing && profiles.length > 1 && (
              <button
                onClick={() => handleDeleteProfile(profile.id)}
                className="absolute -top-2 -right-2 p-2 bg-apple-red rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}

        {/* Add profile button */}
        {profiles.length < 6 && (
          <button
            onClick={() => setIsCreating(true)}
            className="flex flex-col items-center group"
          >
            <div className="w-32 h-32 rounded-lg bg-white/10 flex items-center justify-center transition-colors group-hover:bg-white/20">
              <Plus className="w-12 h-12 text-white/60 group-hover:text-white" />
            </div>
            <span className="mt-3 text-lg text-white/60 group-hover:text-white">
              Add Profile
            </span>
          </button>
        )}
      </div>

      {/* Edit button */}
      <button
        onClick={() => setIsEditing(!isEditing)}
        className="px-6 py-2 border border-white/40 rounded-lg text-sm text-white/80 hover:text-white hover:border-white transition-colors"
      >
        {isEditing ? 'Done' : 'Manage Profiles'}
      </button>

      {/* Create profile modal */}
      {isCreating && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-apple-gray-800 rounded-2xl p-8 w-full max-w-md mx-4">
            <h2 className="text-2xl font-semibold mb-6">Add Profile</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-white/80 mb-2">
                  Profile Name
                </label>
                <input
                  type="text"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  className="w-full px-4 py-3 bg-apple-gray-700 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-apple-blue"
                  placeholder="Name"
                  autoFocus
                />
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isKids}
                  onChange={(e) => setIsKids(e.target.checked)}
                  className="w-5 h-5 rounded border-white/20 bg-apple-gray-700 text-apple-blue focus:ring-apple-blue"
                />
                <span className="text-white/80">Kids profile</span>
              </label>
            </div>

            <div className="flex gap-4 mt-8">
              <button
                onClick={() => {
                  setIsCreating(false);
                  setNewProfileName('');
                  setIsKids(false);
                }}
                className="flex-1 py-3 border border-white/40 rounded-lg text-white/80 hover:text-white hover:border-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProfile}
                disabled={!newProfileName.trim()}
                className="flex-1 py-3 bg-apple-blue text-white font-semibold rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/profiles')({
  component: ProfilesPage,
});
