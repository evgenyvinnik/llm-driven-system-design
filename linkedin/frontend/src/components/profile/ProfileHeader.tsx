/**
 * Profile header component displaying user banner, avatar, name, and connection actions.
 * This component shows the top section of a user's profile including their photo,
 * name, headline, location, and connection status/actions.
 *
 * @module components/profile/ProfileHeader
 */
import { MapPin, Pencil, UserPlus, UserMinus } from 'lucide-react';
import type { User } from '../../types';

/**
 * Props for the ProfileHeader component.
 */
interface ProfileHeaderProps {
  /** The user profile being displayed */
  profile: User;
  /** Whether this is the current user's own profile */
  isOwnProfile: boolean;
  /** Connection degree (1, 2, 3, or null/undefined for no connection, -1 for pending) */
  connectionDegree: number | null;
  /** List of mutual connections with the profile user */
  mutualConnections: User[];
  /** Callback to open the edit profile modal */
  onEditProfile: () => void;
  /** Callback to send a connection request */
  onConnect: () => void;
  /** Callback to remove an existing connection */
  onRemoveConnection: () => void;
}

/**
 * Displays the header section of a user's profile page.
 * Includes the banner image, profile photo, user details, and connection actions.
 *
 * @param props - Component props
 * @returns The profile header JSX element
 */
export function ProfileHeader({
  profile,
  isOwnProfile,
  connectionDegree,
  mutualConnections,
  onEditProfile,
  onConnect,
  onRemoveConnection,
}: ProfileHeaderProps) {
  /**
   * Formats the connection degree as a human-readable ordinal string.
   *
   * @param degree - The connection degree (1, 2, or 3)
   * @returns Formatted degree string (e.g., "1st", "2nd", "3rd")
   */
  const formatConnectionDegree = (degree: number): string => {
    switch (degree) {
      case 1:
        return '1st';
      case 2:
        return '2nd';
      default:
        return '3rd';
    }
  };

  return (
    <div className="card overflow-hidden">
      {/* Banner image */}
      <div className="h-48 bg-gradient-to-r from-linkedin-blue to-blue-400" />

      <div className="px-6 pb-6 -mt-16">
        {/* Profile photo and action buttons */}
        <div className="flex items-end justify-between">
          <div className="w-32 h-32 rounded-full bg-white border-4 border-white flex items-center justify-center text-5xl font-bold bg-gray-300">
            {profile.profile_image_url ? (
              <img
                src={profile.profile_image_url}
                alt={profile.first_name}
                className="w-full h-full rounded-full object-cover"
              />
            ) : (
              profile.first_name?.[0]
            )}
          </div>

          {/* Action buttons based on profile ownership and connection status */}
          {isOwnProfile ? (
            <button
              onClick={onEditProfile}
              className="btn-secondary flex items-center gap-2"
            >
              <Pencil className="w-4 h-4" />
              Edit profile
            </button>
          ) : (
            <div className="flex gap-2">
              {connectionDegree === 1 ? (
                <button
                  onClick={onRemoveConnection}
                  className="btn-secondary flex items-center gap-2"
                >
                  <UserMinus className="w-4 h-4" />
                  Connected
                </button>
              ) : connectionDegree === -1 ? (
                <button disabled className="btn-secondary opacity-50">
                  Pending
                </button>
              ) : (
                <button
                  onClick={onConnect}
                  className="btn-primary flex items-center gap-2"
                >
                  <UserPlus className="w-4 h-4" />
                  Connect
                </button>
              )}
            </div>
          )}
        </div>

        {/* User name and details */}
        <div className="mt-4">
          <h1 className="text-2xl font-bold">
            {profile.first_name} {profile.last_name}
          </h1>

          {profile.headline && (
            <p className="text-lg text-gray-700 mt-1">{profile.headline}</p>
          )}

          <div className="flex items-center gap-4 mt-2 text-sm text-gray-600">
            {profile.location && (
              <span className="flex items-center gap-1">
                <MapPin className="w-4 h-4" />
                {profile.location}
              </span>
            )}

            {profile.connection_count > 0 && (
              <span className="text-linkedin-blue font-semibold">
                {profile.connection_count} connections
              </span>
            )}

            {connectionDegree && connectionDegree > 0 && (
              <span className="bg-gray-100 px-2 py-0.5 rounded text-xs">
                {formatConnectionDegree(connectionDegree)}
              </span>
            )}
          </div>

          {/* Mutual connections info (only shown for other users' profiles) */}
          {!isOwnProfile && mutualConnections.length > 0 && (
            <div className="mt-2 text-sm text-gray-600">
              {mutualConnections.length} mutual connection
              {mutualConnections.length > 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
