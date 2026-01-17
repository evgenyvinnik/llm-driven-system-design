import { useState, useRef } from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { usersApi } from '../services/api';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Avatar } from '../components/Avatar';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate();
  const { user, isAuthenticated, setUser, logout } = useAuthStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [isPrivate, setIsPrivate] = useState(user?.isPrivate || false);
  const [profilePicture, setProfilePicture] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setProfilePicture(file);
      const reader = new FileReader();
      reader.onload = (e) => {
        setPreviewUrl(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      const formData = new FormData();
      formData.append('displayName', displayName);
      formData.append('bio', bio);
      formData.append('isPrivate', String(isPrivate));
      if (profilePicture) {
        formData.append('profilePicture', profilePicture);
      }

      const response = await usersApi.updateProfile(formData);
      setUser(response.user);
      setSuccess('Profile updated successfully');
      setProfilePicture(null);
      setPreviewUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold mb-8">Edit Profile</h1>

      <form onSubmit={handleSubmit} className="bg-white border border-border-gray rounded-lg p-6">
        {/* Profile picture */}
        <div className="flex items-center gap-8 mb-8">
          <Avatar
            src={previewUrl || user?.profilePictureUrl}
            alt={user?.username || ''}
            size="xl"
          />
          <div>
            <p className="font-semibold mb-1">{user?.username}</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-primary font-semibold text-sm"
            >
              Change profile photo
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>
        </div>

        {/* Display name */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Name</label>
          <Input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Name"
          />
          <p className="text-xs text-text-gray mt-1">
            Help people discover your account by using the name you're known by.
          </p>
        </div>

        {/* Bio */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Bio</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Bio"
            maxLength={150}
            rows={3}
            className="w-full px-3 py-2 border border-border-gray rounded bg-gray-bg text-sm focus:outline-none focus:border-gray-400 resize-none"
          />
          <p className="text-xs text-text-gray text-right">{bio.length}/150</p>
        </div>

        {/* Private account */}
        <div className="mb-6">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm">Private account</span>
          </label>
          <p className="text-xs text-text-gray mt-1 ml-7">
            When your account is private, only people you approve can see your photos and videos.
          </p>
        </div>

        {/* Messages */}
        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        {success && <p className="text-green-500 text-sm mb-4">{success}</p>}

        {/* Submit */}
        <Button type="submit" loading={loading}>
          Submit
        </Button>
      </form>

      {/* Logout section */}
      <div className="mt-8 bg-white border border-border-gray rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Account</h2>
        <Button variant="danger" onClick={handleLogout}>
          Log Out
        </Button>
      </div>
    </div>
  );
}
