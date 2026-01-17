import { createFileRoute, Navigate, Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useState, useEffect } from 'react';
import { userApi } from '../services/api';
import type { UserPreferences } from '../types';

function PreferencesPage() {
  const { isAuthenticated } = useAuthStore();
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      loadPreferences();
    }
  }, [isAuthenticated]);

  const loadPreferences = async () => {
    try {
      const prefs = await userApi.getPreferences();
      setPreferences(prefs);
    } catch (error) {
      console.error('Failed to load preferences:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!preferences) return;
    setIsSaving(true);
    try {
      await userApi.updatePreferences(preferences);
    } catch (error) {
      console.error('Failed to save preferences:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const toggleInterest = (gender: string) => {
    if (!preferences) return;
    const interested_in = preferences.interested_in.includes(gender)
      ? preferences.interested_in.filter((g) => g !== gender)
      : [...preferences.interested_in, gender];

    if (interested_in.length === 0) return; // Must have at least one

    setPreferences({ ...preferences, interested_in });
  };

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="w-8 h-8 border-4 border-gradient-start border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!preferences) {
    return <Navigate to="/profile" />;
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm px-4 py-3 flex items-center">
        <Link to="/profile" className="mr-3">
          <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h1 className="text-xl font-bold flex-1">Discovery Preferences</h1>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="text-gradient-start font-medium"
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </header>

      {/* Content */}
      <main className="p-4 space-y-4">
        {/* Interested In */}
        <div className="card p-4">
          <h3 className="font-semibold mb-3">Show Me</h3>
          <div className="flex gap-2">
            {['male', 'female', 'other'].map((gender) => (
              <button
                key={gender}
                onClick={() => toggleInterest(gender)}
                className={`flex-1 py-2 rounded-full font-medium transition-colors ${
                  preferences.interested_in.includes(gender)
                    ? 'bg-tinder-gradient text-white'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                {gender.charAt(0).toUpperCase() + gender.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Age Range */}
        <div className="card p-4">
          <h3 className="font-semibold mb-3">Age Range</h3>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="block text-sm text-gray-600 mb-1">Min Age</label>
              <input
                type="number"
                min={18}
                max={preferences.age_max}
                value={preferences.age_min}
                onChange={(e) =>
                  setPreferences({
                    ...preferences,
                    age_min: Math.max(18, parseInt(e.target.value) || 18),
                  })
                }
                className="input text-center"
              />
            </div>
            <span className="text-gray-400 pt-6">-</span>
            <div className="flex-1">
              <label className="block text-sm text-gray-600 mb-1">Max Age</label>
              <input
                type="number"
                min={preferences.age_min}
                max={100}
                value={preferences.age_max}
                onChange={(e) =>
                  setPreferences({
                    ...preferences,
                    age_max: Math.min(100, parseInt(e.target.value) || 100),
                  })
                }
                className="input text-center"
              />
            </div>
          </div>
        </div>

        {/* Distance */}
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">Maximum Distance</h3>
            <span className="text-gradient-start font-medium">{preferences.distance_km} km</span>
          </div>
          <input
            type="range"
            min={1}
            max={500}
            value={preferences.distance_km}
            onChange={(e) =>
              setPreferences({
                ...preferences,
                distance_km: parseInt(e.target.value),
              })
            }
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-gradient-start"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>1 km</span>
            <span>500 km</span>
          </div>
        </div>

        {/* Show Me Toggle */}
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Show Me in Discovery</h3>
              <p className="text-sm text-gray-500">Turn off to hide your profile</p>
            </div>
            <button
              onClick={() =>
                setPreferences({ ...preferences, show_me: !preferences.show_me })
              }
              className={`w-12 h-6 rounded-full transition-colors ${
                preferences.show_me ? 'bg-tinder-gradient' : 'bg-gray-300'
              }`}
            >
              <div
                className={`w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  preferences.show_me ? 'translate-x-6' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

export const Route = createFileRoute('/preferences')({
  component: PreferencesPage,
});
