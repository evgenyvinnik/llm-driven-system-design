import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { usersApi, feedApi, connectionsApi } from '../services/api';
import type { User, Experience, Education, UserSkill, Post } from '../types';
import { PostCard } from '../components/PostCard';
import {
  MapPin,
  Building2,
  Pencil,
  Plus,
  X,
  Check,
  UserPlus,
  UserMinus,
} from 'lucide-react';

export const Route = createFileRoute('/profile/$userId')({
  component: ProfilePage,
});

function ProfilePage() {
  const { userId } = Route.useParams();
  const { user: currentUser, isAuthenticated, updateUser } = useAuthStore();
  const navigate = useNavigate();

  const [profile, setProfile] = useState<User | null>(null);
  const [experiences, setExperiences] = useState<Experience[]>([]);
  const [education, setEducation] = useState<Education[]>([]);
  const [skills, setSkills] = useState<UserSkill[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionDegree, setConnectionDegree] = useState<number | null>(null);
  const [mutualConnections, setMutualConnections] = useState<User[]>([]);

  const [editingProfile, setEditingProfile] = useState(false);
  const [editFormData, setEditFormData] = useState<Partial<User>>({});
  const [addingSkill, setAddingSkill] = useState(false);
  const [newSkill, setNewSkill] = useState('');

  const isOwnProfile = currentUser?.id === parseInt(userId);

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

        if (!isOwnProfile) {
          const [degreeData, mutualData] = await Promise.all([
            connectionsApi.getConnectionDegree(parseInt(userId)),
            connectionsApi.getMutualConnections(parseInt(userId)),
          ]);
          setConnectionDegree(degreeData.degree);
          setMutualConnections(mutualData.mutual_connections);
        }
      } catch (error) {
        console.error('Failed to load profile:', error);
      }
      setLoading(false);
    };

    loadProfile();
  }, [userId, isAuthenticated, navigate, isOwnProfile]);

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

  const handleAddSkill = async () => {
    if (!newSkill.trim()) return;
    try {
      const { skills: updatedSkills } = await usersApi.addSkill(newSkill);
      setSkills(updatedSkills);
      setNewSkill('');
      setAddingSkill(false);
    } catch (error) {
      console.error('Failed to add skill:', error);
    }
  };

  const handleRemoveSkill = async (skillId: number) => {
    try {
      await usersApi.removeSkill(skillId);
      setSkills(skills.filter((s) => s.skill_id !== skillId));
    } catch (error) {
      console.error('Failed to remove skill:', error);
    }
  };

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

  const handleConnect = async () => {
    try {
      await connectionsApi.sendRequest(parseInt(userId));
      setConnectionDegree(-1); // -1 = pending
    } catch (error) {
      console.error('Failed to send connection request:', error);
    }
  };

  const handleRemoveConnection = async () => {
    try {
      await connectionsApi.removeConnection(parseInt(userId));
      setConnectionDegree(null);
    } catch (error) {
      console.error('Failed to remove connection:', error);
    }
  };

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="card p-8 text-center text-gray-500">Loading profile...</div>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="card p-8 text-center text-gray-500">User not found</div>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-6 space-y-4">
      {/* Profile Header */}
      <div className="card overflow-hidden">
        <div className="h-48 bg-gradient-to-r from-linkedin-blue to-blue-400" />
        <div className="px-6 pb-6 -mt-16">
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
                onClick={() => {
                  setEditFormData({
                    first_name: profile.first_name,
                    last_name: profile.last_name,
                    headline: profile.headline,
                    summary: profile.summary,
                    location: profile.location,
                    industry: profile.industry,
                  });
                  setEditingProfile(true);
                }}
                className="btn-secondary flex items-center gap-2"
              >
                <Pencil className="w-4 h-4" />
                Edit profile
              </button>
            ) : (
              <div className="flex gap-2">
                {connectionDegree === 1 ? (
                  <button
                    onClick={handleRemoveConnection}
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
                    onClick={handleConnect}
                    className="btn-primary flex items-center gap-2"
                  >
                    <UserPlus className="w-4 h-4" />
                    Connect
                  </button>
                )}
              </div>
            )}
          </div>

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
                  {connectionDegree === 1
                    ? '1st'
                    : connectionDegree === 2
                    ? '2nd'
                    : '3rd'}
                </span>
              )}
            </div>
            {!isOwnProfile && mutualConnections.length > 0 && (
              <div className="mt-2 text-sm text-gray-600">
                {mutualConnections.length} mutual connection
                {mutualConnections.length > 1 ? 's' : ''}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit Profile Modal */}
      {editingProfile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto m-4">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-xl font-semibold">Edit intro</h2>
              <button onClick={() => setEditingProfile(false)}>
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">First name</label>
                  <input
                    type="text"
                    value={editFormData.first_name || ''}
                    onChange={(e) =>
                      setEditFormData({ ...editFormData, first_name: e.target.value })
                    }
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Last name</label>
                  <input
                    type="text"
                    value={editFormData.last_name || ''}
                    onChange={(e) =>
                      setEditFormData({ ...editFormData, last_name: e.target.value })
                    }
                    className="input"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Headline</label>
                <input
                  type="text"
                  value={editFormData.headline || ''}
                  onChange={(e) =>
                    setEditFormData({ ...editFormData, headline: e.target.value })
                  }
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Location</label>
                <input
                  type="text"
                  value={editFormData.location || ''}
                  onChange={(e) =>
                    setEditFormData({ ...editFormData, location: e.target.value })
                  }
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Industry</label>
                <input
                  type="text"
                  value={editFormData.industry || ''}
                  onChange={(e) =>
                    setEditFormData({ ...editFormData, industry: e.target.value })
                  }
                  className="input"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Summary</label>
                <textarea
                  value={editFormData.summary || ''}
                  onChange={(e) =>
                    setEditFormData({ ...editFormData, summary: e.target.value })
                  }
                  rows={4}
                  className="input"
                />
              </div>
            </div>
            <div className="p-4 border-t flex justify-end gap-2">
              <button onClick={() => setEditingProfile(false)} className="btn-secondary">
                Cancel
              </button>
              <button onClick={handleSaveProfile} className="btn-primary">
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* About */}
      {profile.summary && (
        <div className="card p-6">
          <h2 className="text-xl font-semibold mb-4">About</h2>
          <p className="whitespace-pre-wrap">{profile.summary}</p>
        </div>
      )}

      {/* Experience */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Experience</h2>
          {isOwnProfile && (
            <button className="text-gray-600 hover:bg-gray-100 p-2 rounded-full">
              <Plus className="w-5 h-5" />
            </button>
          )}
        </div>
        {experiences.length === 0 ? (
          <p className="text-gray-500">No experience added yet</p>
        ) : (
          <div className="space-y-4">
            {experiences.map((exp) => (
              <div key={exp.id} className="flex gap-4">
                <div className="w-12 h-12 bg-gray-200 rounded flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-6 h-6 text-gray-400" />
                </div>
                <div>
                  <h3 className="font-semibold">{exp.title}</h3>
                  <div className="text-gray-700">{exp.company_name}</div>
                  <div className="text-sm text-gray-500">
                    {new Date(exp.start_date).getFullYear()} -{' '}
                    {exp.is_current ? 'Present' : new Date(exp.end_date!).getFullYear()}
                  </div>
                  {exp.description && (
                    <p className="mt-2 text-sm text-gray-600">{exp.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Education */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Education</h2>
          {isOwnProfile && (
            <button className="text-gray-600 hover:bg-gray-100 p-2 rounded-full">
              <Plus className="w-5 h-5" />
            </button>
          )}
        </div>
        {education.length === 0 ? (
          <p className="text-gray-500">No education added yet</p>
        ) : (
          <div className="space-y-4">
            {education.map((edu) => (
              <div key={edu.id} className="flex gap-4">
                <div className="w-12 h-12 bg-gray-200 rounded flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-6 h-6 text-gray-400" />
                </div>
                <div>
                  <h3 className="font-semibold">{edu.school_name}</h3>
                  {edu.degree && (
                    <div className="text-gray-700">
                      {edu.degree}
                      {edu.field_of_study && `, ${edu.field_of_study}`}
                    </div>
                  )}
                  {(edu.start_year || edu.end_year) && (
                    <div className="text-sm text-gray-500">
                      {edu.start_year} - {edu.end_year || 'Present'}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Skills */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Skills</h2>
          {isOwnProfile && (
            <button
              onClick={() => setAddingSkill(true)}
              className="text-gray-600 hover:bg-gray-100 p-2 rounded-full"
            >
              <Plus className="w-5 h-5" />
            </button>
          )}
        </div>

        {addingSkill && (
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newSkill}
              onChange={(e) => setNewSkill(e.target.value)}
              placeholder="Enter skill name"
              className="input flex-1"
            />
            <button onClick={handleAddSkill} className="btn-primary">
              <Check className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                setAddingSkill(false);
                setNewSkill('');
              }}
              className="btn-secondary"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {skills.length === 0 ? (
          <p className="text-gray-500">No skills added yet</p>
        ) : (
          <div className="space-y-3">
            {skills.map((skill) => (
              <div
                key={skill.skill_id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded"
              >
                <div>
                  <div className="font-medium">{skill.skill_name}</div>
                  {skill.endorsement_count > 0 && (
                    <div className="text-sm text-gray-500">
                      {skill.endorsement_count} endorsement
                      {skill.endorsement_count > 1 ? 's' : ''}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  {!isOwnProfile && (
                    <button
                      onClick={() => handleEndorseSkill(skill.skill_id)}
                      className="text-sm text-linkedin-blue hover:underline"
                    >
                      Endorse
                    </button>
                  )}
                  {isOwnProfile && (
                    <button
                      onClick={() => handleRemoveSkill(skill.skill_id)}
                      className="text-gray-400 hover:text-red-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Activity/Posts */}
      <div className="card p-6">
        <h2 className="text-xl font-semibold mb-4">Activity</h2>
        {posts.length === 0 ? (
          <p className="text-gray-500">No posts yet</p>
        ) : (
          <div className="space-y-4">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
