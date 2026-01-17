import React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Plus, Edit2 } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';

const AVATAR_OPTIONS = [
  '/avatars/avatar1.png',
  '/avatars/avatar2.png',
  '/avatars/avatar3.png',
  '/avatars/avatar4.png',
  '/avatars/avatar-kids.png',
];

const AVATAR_COLORS = ['#E50914', '#1D9BF0', '#8B5CF6', '#22C55E', '#F59E0B'];

export function ProfilesPage() {
  const navigate = useNavigate();
  const { profiles, selectProfile, loadProfiles, isAuthenticated } = useAuthStore();
  const [isEditing, setIsEditing] = React.useState(false);

  React.useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
    }
  }, [isAuthenticated, navigate]);

  React.useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const handleSelectProfile = async (profileId: string) => {
    if (isEditing) return;

    try {
      await selectProfile(profileId);
      navigate({ to: '/browse' });
    } catch (error) {
      console.error('Failed to select profile:', error);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      <h1 className="text-white text-3xl md:text-5xl mb-8">Who's watching?</h1>

      <div className="flex flex-wrap justify-center gap-4 md:gap-6 mb-8">
        {profiles.map((profile, index) => (
          <button
            key={profile.id}
            onClick={() => handleSelectProfile(profile.id)}
            className="group flex flex-col items-center"
          >
            <div
              className={`relative w-24 h-24 md:w-32 md:h-32 rounded overflow-hidden border-2 border-transparent group-hover:border-white transition-colors`}
              style={{ backgroundColor: AVATAR_COLORS[index % AVATAR_COLORS.length] }}
            >
              {profile.avatarUrl ? (
                <img
                  src={profile.avatarUrl}
                  alt={profile.name}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-white text-4xl font-bold">
                  {profile.name.charAt(0).toUpperCase()}
                </div>
              )}

              {isEditing && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <Edit2 className="text-white" size={32} />
                </div>
              )}

              {profile.isKids && (
                <div className="absolute bottom-0 left-0 right-0 bg-yellow-500 text-black text-xs font-bold text-center py-0.5">
                  KIDS
                </div>
              )}
            </div>
            <span className="text-netflix-light-gray group-hover:text-white mt-2 text-sm md:text-base">
              {profile.name}
            </span>
          </button>
        ))}

        {/* Add profile button */}
        {profiles.length < 5 && !isEditing && (
          <button
            onClick={() => navigate({ to: '/profiles/add' })}
            className="group flex flex-col items-center"
          >
            <div className="w-24 h-24 md:w-32 md:h-32 rounded border-2 border-netflix-gray group-hover:border-white flex items-center justify-center transition-colors">
              <Plus className="text-netflix-gray group-hover:text-white" size={48} />
            </div>
            <span className="text-netflix-light-gray group-hover:text-white mt-2 text-sm md:text-base">
              Add Profile
            </span>
          </button>
        )}
      </div>

      <button
        onClick={() => setIsEditing(!isEditing)}
        className={`px-8 py-2 border ${
          isEditing
            ? 'bg-white text-black border-white'
            : 'border-netflix-gray text-netflix-gray hover:border-white hover:text-white'
        } transition-colors`}
      >
        {isEditing ? 'Done' : 'Manage Profiles'}
      </button>
    </div>
  );
}
