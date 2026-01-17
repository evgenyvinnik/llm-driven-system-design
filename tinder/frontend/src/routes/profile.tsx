import { createFileRoute, Navigate, Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useState } from 'react';
import BottomNav from '../components/BottomNav';
import ReignsAvatar from '../components/ReignsAvatar';

function ProfilePage() {
  const { isAuthenticated, user, logout, updateProfile } = useAuthStore();
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    name: user?.name || '',
    bio: user?.bio || '',
    job_title: user?.job_title || '',
    company: user?.company || '',
    school: user?.school || '',
  });
  const [isSaving, setIsSaving] = useState(false);

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" />;
  }

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateProfile(formData);
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to update profile:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <header className="bg-white shadow-sm px-4 py-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">Profile</h1>
        {user.is_admin && (
          <Link to="/admin" className="text-gradient-start text-sm font-medium">
            Admin Panel
          </Link>
        )}
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-4">
        {/* Profile Photo */}
        <div className="card p-6 mb-4">
          <div className="flex items-center">
            <div className="w-20 h-20 rounded-full overflow-hidden bg-gray-800">
              <ReignsAvatar
                seed={`${user.id}-${user.name}`}
                size={80}
              />
            </div>
            <div className="ml-4">
              <h2 className="text-xl font-semibold">{user.name}, {user.age}</h2>
              <p className="text-gray-500">{user.email}</p>
            </div>
          </div>
        </div>

        {/* Edit Profile */}
        <div className="card p-6 mb-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Edit Profile</h3>
            {isEditing ? (
              <div className="flex gap-2">
                <button
                  onClick={() => setIsEditing(false)}
                  className="btn btn-secondary text-sm"
                  disabled={isSaving}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="btn btn-primary text-sm"
                  disabled={isSaving}
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setIsEditing(true)}
                className="text-gradient-start text-sm font-medium"
              >
                Edit
              </button>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Name</label>
              {isEditing ? (
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  className="input"
                />
              ) : (
                <p className="text-gray-900">{user.name}</p>
              )}
            </div>

            <div>
              <label className="block text-sm text-gray-600 mb-1">Bio</label>
              {isEditing ? (
                <textarea
                  name="bio"
                  value={formData.bio}
                  onChange={handleChange}
                  className="input resize-none"
                  rows={3}
                />
              ) : (
                <p className="text-gray-900">{user.bio || 'No bio yet'}</p>
              )}
            </div>

            <div>
              <label className="block text-sm text-gray-600 mb-1">Job Title</label>
              {isEditing ? (
                <input
                  type="text"
                  name="job_title"
                  value={formData.job_title}
                  onChange={handleChange}
                  className="input"
                />
              ) : (
                <p className="text-gray-900">{user.job_title || 'Not set'}</p>
              )}
            </div>

            <div>
              <label className="block text-sm text-gray-600 mb-1">Company</label>
              {isEditing ? (
                <input
                  type="text"
                  name="company"
                  value={formData.company}
                  onChange={handleChange}
                  className="input"
                />
              ) : (
                <p className="text-gray-900">{user.company || 'Not set'}</p>
              )}
            </div>

            <div>
              <label className="block text-sm text-gray-600 mb-1">School</label>
              {isEditing ? (
                <input
                  type="text"
                  name="school"
                  value={formData.school}
                  onChange={handleChange}
                  className="input"
                />
              ) : (
                <p className="text-gray-900">{user.school || 'Not set'}</p>
              )}
            </div>
          </div>
        </div>

        {/* Preferences Link */}
        <Link to="/preferences" className="card p-4 mb-4 flex items-center justify-between">
          <span className="font-medium">Discovery Preferences</span>
          <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>

        {/* Logout */}
        <button
          onClick={logout}
          className="w-full p-4 text-center text-red-600 font-medium bg-white rounded-2xl shadow"
        >
          Log Out
        </button>
      </main>

      {/* Bottom Navigation */}
      <BottomNav />
    </div>
  );
}

export const Route = createFileRoute('/profile')({
  component: ProfilePage,
});
