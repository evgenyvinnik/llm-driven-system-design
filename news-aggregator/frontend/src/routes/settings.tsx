import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores';
import { userApi } from '../services/api';
import { Settings, Check, X } from 'lucide-react';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate();
  const { user, preferences, updatePreferences } = useAuthStore();
  const [availableTopics, setAvailableTopics] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
      return;
    }

    userApi.getAvailableTopics().then((response) => {
      setAvailableTopics(response.topics);
    });
  }, [user, navigate]);

  useEffect(() => {
    if (preferences) {
      setSelectedTopics(preferences.preferred_topics);
    }
  }, [preferences]);

  const handleTopicToggle = (topic: string) => {
    setSelectedTopics((prev) =>
      prev.includes(topic)
        ? prev.filter((t) => t !== topic)
        : [...prev, topic]
    );
  };

  const handleSave = async () => {
    setIsSaving(true);
    setMessage(null);
    try {
      await updatePreferences({ preferred_topics: selectedTopics });
      setMessage('Preferences saved successfully!');
    } catch {
      setMessage('Failed to save preferences');
    } finally {
      setIsSaving(false);
    }
  };

  if (!user) {
    return null;
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Settings className="w-8 h-8 text-primary-500" />
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
      </div>

      {message && (
        <div
          className={`px-4 py-3 rounded-lg mb-6 ${
            message.includes('success')
              ? 'bg-green-50 border border-green-200 text-green-700'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}
        >
          {message}
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Account</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-gray-600">Username</span>
            <span className="font-medium">{user.username}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-gray-600">Email</span>
            <span className="font-medium">{user.email}</span>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-gray-600">Role</span>
            <span className="font-medium capitalize">{user.role}</span>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Topic Preferences</h2>
        <p className="text-gray-600 mb-4">
          Select topics you're interested in to personalize your news feed.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
          {availableTopics.map((topic) => (
            <button
              key={topic}
              onClick={() => handleTopicToggle(topic)}
              className={`flex items-center justify-between px-4 py-3 rounded-lg border transition-colors ${
                selectedTopics.includes(topic)
                  ? 'bg-primary-50 border-primary-300 text-primary-700'
                  : 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100'
              }`}
            >
              <span className="capitalize font-medium">{topic}</span>
              {selectedTopics.includes(topic) ? (
                <Check className="w-4 h-4" />
              ) : (
                <X className="w-4 h-4 opacity-30" />
              )}
            </button>
          ))}
        </div>

        <button
          onClick={handleSave}
          disabled={isSaving}
          className="btn btn-primary"
        >
          {isSaving ? 'Saving...' : 'Save Preferences'}
        </button>
      </div>
    </div>
  );
}
