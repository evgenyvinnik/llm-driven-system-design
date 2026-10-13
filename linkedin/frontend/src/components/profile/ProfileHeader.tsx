/**
 * Profile header component displaying user banner, avatar, name, and connection actions.
 * This component shows the top section of a user's profile including their photo,
 * name, headline, location, degree badge, "how you're connected" path and the
 * connection action that matches the server-reported relationship.
 *
 * @module components/profile/ProfileHeader
 */
import { MapPin, Pencil } from 'lucide-react';
import type { Relationship, User } from '../../types';
import { ConnectionActions } from './ConnectionActions';
import { ConnectionPath } from './ConnectionPath';

/**
 * Props for the ProfileHeader component.
 */
interface ProfileHeaderProps {
  /** The user profile being displayed */
  profile: User;
  /** Whether this is the current user's own profile */
  isOwnProfile: boolean;
  /** Relationship with the viewer (null while loading or on your own profile) */
  relationship: Relationship | null;
  /** True while a connection mutation is in flight */
  actionPending: boolean;
  /** Last connection action error, announced to screen readers */
  actionError: string | null;
  /** Callback to open the edit profile modal */
  onEditProfile: () => void;
  onConnect: () => void;
  onWithdraw: () => void;
  onAccept: () => void;
  onIgnore: () => void;
  onRemoveConnection: () => void;
}

const DEGREE_LABELS: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd' };

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
  relationship,
  actionPending,
  actionError,
  onEditProfile,
  onConnect,
  onWithdraw,
  onAccept,
  onIgnore,
  onRemoveConnection,
}: ProfileHeaderProps) {
  const degree = relationship?.degree;

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

          {isOwnProfile ? (
            <button
              onClick={onEditProfile}
              className="btn-secondary flex items-center gap-2"
            >
              <Pencil className="w-4 h-4" />
              Edit profile
            </button>
          ) : (
            <ConnectionActions
              relationship={relationship}
              busy={actionPending}
              onConnect={onConnect}
              onWithdraw={onWithdraw}
              onAccept={onAccept}
              onIgnore={onIgnore}
              onRemove={onRemoveConnection}
            />
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

            {degree && degree > 0 && (
              <span className="bg-gray-100 px-2 py-0.5 rounded text-xs">
                {DEGREE_LABELS[degree]}
              </span>
            )}
          </div>

          {!isOwnProfile && <ConnectionPath relationship={relationship} />}

          <p role="status" aria-live="polite" className="mt-2 text-sm text-red-600 min-h-[1.25rem]">
            {actionError ?? ''}
          </p>
        </div>
      </div>
    </div>
  );
}
