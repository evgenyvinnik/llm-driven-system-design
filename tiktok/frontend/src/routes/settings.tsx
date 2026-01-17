import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { usersApi } from '@/services/api';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate();
  const { user, isAuthenticated, updateUser } = useAuthStore();

  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');

  if (!isAuthenticated) {
    navigate({ to: '/login' });
    return null;
  }

  const handleSave = async () => {
    setIsSaving(true);
    setMessage('');

    try {
      const updated = await usersApi.updateProfile({ displayName, bio });
      updateUser(updated as { displayName: string; bio: string });
      setMessage('Profile updated successfully!');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex-1 p-4 pb-20 overflow-y-auto">
      <div className="flex items-center mb-6">
        <button
          onClick={() => navigate({ to: '/profile/$username', params: { username: user?.username || '' } })}
          className="mr-4"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-xl font-bold">Edit Profile</h1>
      </div>

      <div className="space-y-6">
        {/* Avatar */}
        <div className="flex flex-col items-center">
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.displayName}
              className="w-24 h-24 rounded-full mb-2"
            />
          ) : (
            <div className="w-24 h-24 rounded-full bg-gray-600 flex items-center justify-center text-3xl mb-2">
              {user?.displayName?.[0]?.toUpperCase() || 'U'}
            </div>
          )}
          <button className="text-tiktok-red text-sm">Change photo</button>
        </div>

        {/* Username (read-only) */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Username</label>
          <input
            type="text"
            value={user?.username || ''}
            disabled
            className="input bg-gray-900 text-gray-500"
          />
        </div>

        {/* Display Name */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Display Name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="input"
            maxLength={100}
          />
        </div>

        {/* Bio */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">Bio</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className="input h-24 resize-none"
            maxLength={500}
            placeholder="Tell us about yourself..."
          />
          <p className="text-xs text-gray-500 mt-1">{bio.length}/500</p>
        </div>

        {/* Message */}
        {message && (
          <p className={`text-sm ${message.includes('success') ? 'text-green-500' : 'text-red-500'}`}>
            {message}
          </p>
        )}

        {/* Save Button */}
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="btn-primary w-full disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
