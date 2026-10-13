/**
 * Profile page route component for displaying user profiles.
 * Shows a user's complete professional profile including header, about,
 * experience, education, skills, and activity sections.
 *
 * @module routes/profile.$userId
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { usersApi, feedApi, connectionsApi } from '../services/api';
import type { User, Experience, Education, UserSkill, Post, Relationship } from '../types';
import {
  ProfileHeader,
  EditProfileModal,
  ProfileAbout,
  ExperienceSection,
  EducationSection,
  SkillsSection,
  ActivitySection,
  type EditProfileFormData,
} from '../components/profile';

export const Route = createFileRoute('/profile/$userId')({
  component: ProfilePage,
});

/**
 * Main profile page component.
 * Fetches and displays user profile data including connections,
 * experiences, education, skills, and posts.
 *
 * @returns The profile page JSX element
 */
function ProfilePage() {
  const { userId } = Route.useParams();
  const { user: currentUser, isAuthenticated, updateUser } = useAuthStore();
  const navigate = useNavigate();

  // Profile data state
  const [profile, setProfile] = useState<User | null>(null);
  const [experiences, setExperiences] = useState<Experience[]>([]);
  const [education, setEducation] = useState<Education[]>([]);
  const [skills, setSkills] = useState<UserSkill[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  // Relationship with the viewer: degree, invitation state, mutual count, path
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Edit modal state
  const [editingProfile, setEditingProfile] = useState(false);
  const [editFormData, setEditFormData] = useState<EditProfileFormData>({});

  const isOwnProfile = currentUser?.id === parseInt(userId);

  /**
   * Loads the user profile and related data on component mount
   * or when the userId changes.
   */
  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    const loadProfile = async () => {
      setLoading(true);
      try {
        const [profileData, postsData] = await Promise.all([
          usersApi.getProfile(parseInt(userId)),
          feedApi.getUserPosts(parseInt(userId)),
        ]);

        setProfile(profileData.user);
        setExperiences(profileData.experiences);
        setEducation(profileData.education);
        setSkills(profileData.skills);
        setPosts(postsData.posts);

        // Load the relationship for other users' profiles
        setRelationship(null);
        setActionError(null);
        if (!isOwnProfile) {
          setRelationship(await connectionsApi.getRelationship(parseInt(userId)));
        }
      } catch (error) {
        console.error('Failed to load profile:', error);
      }
      setLoading(false);
    };

    loadProfile();
  }, [userId, isAuthenticated, navigate, isOwnProfile]);

  /**
   * Opens the edit profile modal with current profile data.
   */
  const handleOpenEditModal = () => {
    if (profile) {
      setEditFormData({
        first_name: profile.first_name,
        last_name: profile.last_name,
        headline: profile.headline,
        summary: profile.summary,
        location: profile.location,
        industry: profile.industry,
      });
      setEditingProfile(true);
    }
  };

  /**
   * Saves profile changes to the server and updates local state.
   */
  const handleSaveProfile = async () => {
    try {
      const { user } = await usersApi.updateProfile(editFormData);
      setProfile(user);
      updateUser(user);
      setEditingProfile(false);
    } catch (error) {
      console.error('Failed to update profile:', error);
    }
  };

  /**
   * Adds a new skill to the user's profile.
   *
   * @param skillName - The name of the skill to add
   */
  const handleAddSkill = async (skillName: string) => {
    try {
      const { skills: updatedSkills } = await usersApi.addSkill(skillName);
      setSkills(updatedSkills);
    } catch (error) {
      console.error('Failed to add skill:', error);
    }
  };

  /**
   * Removes a skill from the user's profile.
   *
   * @param skillId - The ID of the skill to remove
   */
  const handleRemoveSkill = async (skillId: number) => {
    try {
      await usersApi.removeSkill(skillId);
      setSkills(skills.filter((s) => s.skill_id !== skillId));
    } catch (error) {
      console.error('Failed to remove skill:', error);
    }
  };

  /**
   * Endorses a skill on another user's profile.
   *
   * @param skillId - The ID of the skill to endorse
   */
  const handleEndorseSkill = async (skillId: number) => {
    try {
      await usersApi.endorseSkill(parseInt(userId), skillId);
      setSkills(
        skills.map((s) =>
          s.skill_id === skillId
            ? { ...s, endorsement_count: s.endorsement_count + 1 }
            : s
        )
      );
    } catch (error) {
      console.error('Failed to endorse skill:', error);
    }
  };

  /**
   * Runs a connection mutation, then re-reads the relationship from the server so
   * the button, badge and path all reflect what actually happened. An optimistic
   * status can be shown first; it is rolled back if the call fails.
   */
  const runConnectionAction = useCallback(
    async (action: () => Promise<unknown>, optimistic?: Relationship['status']) => {
      const previous = relationship;
      setActionPending(true);
      setActionError(null);
      if (optimistic && previous) setRelationship({ ...previous, status: optimistic });
      try {
        await action();
        setRelationship(await connectionsApi.getRelationship(parseInt(userId)));
      } catch (error) {
        setRelationship(previous);
        setActionError(error instanceof Error ? error.message : 'Something went wrong');
      }
      setActionPending(false);
    },
    [relationship, userId]
  );

  const handleConnect = () =>
    runConnectionAction(() => connectionsApi.sendRequest(parseInt(userId)), 'pending_sent');

  const handleWithdraw = () => {
    const requestId = relationship?.request_id;
    if (requestId) runConnectionAction(() => connectionsApi.withdrawRequest(requestId), 'none');
  };

  const handleAccept = () => {
    const requestId = relationship?.request_id;
    if (requestId) runConnectionAction(() => connectionsApi.acceptRequest(requestId), 'connected');
  };

  const handleIgnore = () => {
    const requestId = relationship?.request_id;
    if (requestId) runConnectionAction(() => connectionsApi.rejectRequest(requestId), 'none');
  };

  const handleRemoveConnection = () => {
    if (!profile || !window.confirm(`Remove ${profile.first_name} from your connections?`)) return;
    runConnectionAction(() => connectionsApi.removeConnection(parseInt(userId)));
  };

  // Loading state
  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="card p-8 text-center text-gray-500">Loading profile...</div>
      </main>
    );
  }

  // Not found state
  if (!profile) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="card p-8 text-center text-gray-500">User not found</div>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-6 space-y-4">
      {/* Profile Header with avatar, name, and connection actions */}
      <ProfileHeader
        profile={profile}
        isOwnProfile={isOwnProfile}
        relationship={relationship}
        actionPending={actionPending}
        actionError={actionError}
        onEditProfile={handleOpenEditModal}
        onConnect={handleConnect}
        onWithdraw={handleWithdraw}
        onAccept={handleAccept}
        onIgnore={handleIgnore}
        onRemoveConnection={handleRemoveConnection}
      />

      {/* Edit Profile Modal */}
      <EditProfileModal
        isOpen={editingProfile}
        formData={editFormData}
        onFormDataChange={setEditFormData}
        onSave={handleSaveProfile}
        onClose={() => setEditingProfile(false)}
      />

      {/* About Section */}
      <ProfileAbout summary={profile.summary || ''} />

      {/* Experience Section */}
      <ExperienceSection
        experiences={experiences}
        isOwnProfile={isOwnProfile}
      />

      {/* Education Section */}
      <EducationSection
        education={education}
        isOwnProfile={isOwnProfile}
      />

      {/* Skills Section */}
      <SkillsSection
        skills={skills}
        isOwnProfile={isOwnProfile}
        onAddSkill={handleAddSkill}
        onRemoveSkill={handleRemoveSkill}
        onEndorseSkill={handleEndorseSkill}
      />

      {/* Activity/Posts Section */}
      <ActivitySection posts={posts} />
    </main>
  );
}
