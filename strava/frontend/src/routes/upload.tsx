import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { activities } from '../services/api';

function Upload() {
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [activityType, setActivityType] = useState('run');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAuthenticated) {
    return (
      <div className="max-w-2xl mx-auto mt-12 text-center">
        <h1 className="text-2xl font-bold text-strava-gray-800 mb-4">
          Please log in to upload activities
        </h1>
      </div>
    );
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (
        !selectedFile.name.endsWith('.gpx') &&
        selectedFile.type !== 'application/gpx+xml'
      ) {
        setError('Please select a GPX file');
        return;
      }
      setFile(selectedFile);
      setError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file) {
      setError('Please select a file');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await activities.upload(file, {
        type: activityType,
        name: name || undefined,
        description: description || undefined,
      });

      navigate({ to: `/activity/${result.activity.id}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSimulate = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await activities.simulate({
        type: activityType,
        name: name || undefined,
        numPoints: 100,
      });

      navigate({ to: `/activity/${result.activity.id}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto mt-8">
      <h1 className="text-2xl font-bold text-strava-gray-800 mb-6">
        Upload Activity
      </h1>

      <div className="bg-white rounded-lg shadow p-6">
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* File Upload */}
          <div>
            <label className="block text-sm font-medium text-strava-gray-700 mb-2">
              GPX File
            </label>
            <div className="border-2 border-dashed border-strava-gray-300 rounded-lg p-6 text-center">
              <input
                type="file"
                accept=".gpx"
                onChange={handleFileChange}
                className="hidden"
                id="gpx-file"
              />
              <label
                htmlFor="gpx-file"
                className="cursor-pointer block"
              >
                {file ? (
                  <div className="text-strava-gray-700">
                    <span className="text-2xl">📄</span>
                    <p className="mt-2 font-medium">{file.name}</p>
                    <p className="text-sm text-strava-gray-500">
                      Click to change file
                    </p>
                  </div>
                ) : (
                  <div className="text-strava-gray-500">
                    <span className="text-4xl">📤</span>
                    <p className="mt-2">Click to select a GPX file</p>
                    <p className="text-sm">or drag and drop</p>
                  </div>
                )}
              </label>
            </div>
          </div>

          {/* Activity Type */}
          <div>
            <label className="block text-sm font-medium text-strava-gray-700 mb-2">
              Activity Type
            </label>
            <select
              value={activityType}
              onChange={(e) => setActivityType(e.target.value)}
              className="w-full px-4 py-2 border border-strava-gray-300 rounded-lg focus:ring-2 focus:ring-strava-orange focus:border-transparent"
            >
              <option value="run">Run</option>
              <option value="ride">Ride</option>
              <option value="hike">Hike</option>
              <option value="walk">Walk</option>
              <option value="swim">Swim</option>
            </select>
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-strava-gray-700 mb-2">
              Activity Name (optional)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Morning Run"
              className="w-full px-4 py-2 border border-strava-gray-300 rounded-lg focus:ring-2 focus:ring-strava-orange focus:border-transparent"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-strava-gray-700 mb-2">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="How was your activity?"
              rows={3}
              className="w-full px-4 py-2 border border-strava-gray-300 rounded-lg focus:ring-2 focus:ring-strava-orange focus:border-transparent"
            />
          </div>

          {/* Submit Buttons */}
          <div className="flex gap-4">
            <button
              type="submit"
              disabled={loading || !file}
              className="flex-1 py-3 bg-strava-orange text-white font-semibold rounded-lg hover:bg-strava-orange-dark disabled:opacity-50"
            >
              {loading ? 'Uploading...' : 'Upload Activity'}
            </button>
            <button
              type="button"
              onClick={handleSimulate}
              disabled={loading}
              className="px-6 py-3 bg-strava-gray-200 text-strava-gray-700 font-semibold rounded-lg hover:bg-strava-gray-300 disabled:opacity-50"
            >
              Simulate
            </button>
          </div>
        </form>

        <div className="mt-6 pt-6 border-t border-strava-gray-200">
          <p className="text-sm text-strava-gray-500 text-center">
            No GPX file? Use the Simulate button to create a test activity with random data.
          </p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/upload')({
  component: Upload,
});
