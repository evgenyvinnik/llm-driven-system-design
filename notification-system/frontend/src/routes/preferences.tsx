import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useNotificationStore } from '../stores/notificationStore';

function PreferencesPage() {
  const { isAuthenticated } = useAuthStore();
  const { preferences, isLoading, fetchPreferences, updatePreferences, setQuietHours } = useNotificationStore();
  const navigate = useNavigate();
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('08:00');

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }
    fetchPreferences();
  }, [isAuthenticated, navigate, fetchPreferences]);

  useEffect(() => {
    if (preferences) {
      setQuietHoursEnabled(preferences.quietHoursStart !== null);
      if (preferences.quietHoursStart !== null) {
        const startHours = Math.floor(preferences.quietHoursStart / 60);
        const startMinutes = preferences.quietHoursStart % 60;
        setQuietStart(`${startHours.toString().padStart(2, '0')}:${startMinutes.toString().padStart(2, '0')}`);
      }
      if (preferences.quietHoursEnd !== null) {
        const endHours = Math.floor(preferences.quietHoursEnd / 60);
        const endMinutes = preferences.quietHoursEnd % 60;
        setQuietEnd(`${endHours.toString().padStart(2, '0')}:${endMinutes.toString().padStart(2, '0')}`);
      }
    }
  }, [preferences]);

  const handleChannelToggle = async (channel: 'push' | 'email' | 'sms', enabled: boolean) => {
    if (!preferences) return;
    await updatePreferences({
      channels: {
        ...preferences.channels,
        [channel]: { enabled },
      },
    });
  };

  const handleQuietHoursSave = async () => {
    await setQuietHours(quietHoursEnabled ? quietStart : null, quietHoursEnabled ? quietEnd : null, quietHoursEnabled);
  };

  if (isLoading && !preferences) {
    return (
      <div className="text-center py-12">
        <div className="text-gray-500">Loading preferences...</div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Notification Preferences</h1>

      {/* Channel Preferences */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Channel Preferences</h2>
        <p className="text-sm text-gray-500 mb-4">
          Choose which notification channels you want to receive messages on.
        </p>
        <div className="space-y-4">
          {(['push', 'email', 'sms'] as const).map((channel) => (
            <div key={channel} className="flex items-center justify-between">
              <div>
                <div className="font-medium capitalize">{channel} Notifications</div>
                <div className="text-sm text-gray-500">
                  {channel === 'push' && 'Receive push notifications on your devices'}
                  {channel === 'email' && 'Receive notifications via email'}
                  {channel === 'sms' && 'Receive notifications via SMS (carrier charges may apply)'}
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={preferences?.channels[channel]?.enabled ?? false}
                  onChange={(e) => handleChannelToggle(channel, e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>
          ))}
        </div>
      </div>

      {/* Quiet Hours */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Quiet Hours</h2>
        <p className="text-sm text-gray-500 mb-4">
          During quiet hours, non-critical notifications will be held and delivered later.
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Enable Quiet Hours</div>
              <div className="text-sm text-gray-500">Pause notifications during specified hours</div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={quietHoursEnabled}
                onChange={(e) => setQuietHoursEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            </label>
          </div>

          {quietHoursEnabled && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
                <input
                  type="time"
                  value={quietStart}
                  onChange={(e) => setQuietStart(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">End Time</label>
                <input
                  type="time"
                  value={quietEnd}
                  onChange={(e) => setQuietEnd(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>
            </div>
          )}

          <button
            onClick={handleQuietHoursSave}
            disabled={isLoading}
            className="px-4 py-2 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {isLoading ? 'Saving...' : 'Save Quiet Hours'}
          </button>
        </div>
      </div>

      {/* Timezone */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Timezone</h2>
        <p className="text-sm text-gray-500 mb-4">
          Current timezone: <strong>{preferences?.timezone || 'UTC'}</strong>
        </p>
        <p className="text-xs text-gray-400">
          Timezone is automatically detected based on your browser settings.
        </p>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/preferences')({
  component: PreferencesPage,
});
