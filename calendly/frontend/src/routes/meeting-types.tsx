import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { meetingTypesApi } from '../services/api';
import type { MeetingType } from '../types';
import { LoadingSpinner } from '../components/LoadingSpinner';

export const Route = createFileRoute('/meeting-types')({
  beforeLoad: async () => {
    const { isAuthenticated, checkAuth, isLoading } = useAuthStore.getState();
    if (!isAuthenticated && !isLoading) {
      await checkAuth();
      if (!useAuthStore.getState().isAuthenticated) {
        throw redirect({ to: '/login' });
      }
    }
  },
  component: MeetingTypesPage,
});

function MeetingTypesPage() {
  const { user } = useAuthStore();
  const [meetingTypes, setMeetingTypes] = useState<MeetingType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingType, setEditingType] = useState<MeetingType | null>(null);

  useEffect(() => {
    loadMeetingTypes();
  }, []);

  const loadMeetingTypes = async () => {
    try {
      const response = await meetingTypesApi.list();
      if (response.success && response.data) {
        setMeetingTypes(response.data);
      }
    } catch (error) {
      console.error('Failed to load meeting types:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this event type?')) return;

    try {
      const response = await meetingTypesApi.delete(id);
      if (response.success) {
        setMeetingTypes(meetingTypes.filter((mt) => mt.id !== id));
      }
    } catch (error) {
      console.error('Failed to delete meeting type:', error);
    }
  };

  const handleToggleActive = async (type: MeetingType) => {
    try {
      const response = await meetingTypesApi.update(type.id, {
        is_active: !type.is_active,
      });
      if (response.success && response.data) {
        setMeetingTypes(
          meetingTypes.map((mt) => (mt.id === type.id ? response.data! : mt))
        );
      }
    } catch (error) {
      console.error('Failed to toggle meeting type:', error);
    }
  };

  const copyBookingLink = (type: MeetingType) => {
    const link = `${window.location.origin}/book/${type.id}`;
    navigator.clipboard.writeText(link);
    alert('Booking link copied to clipboard!');
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Event Types</h1>
          <p className="text-gray-600 mt-1">
            Create and manage meeting types that people can book with you.
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="btn btn-primary"
        >
          + New Event Type
        </button>
      </div>

      {meetingTypes.length === 0 ? (
        <div className="card text-center py-12">
          <svg className="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            No event types yet
          </h3>
          <p className="text-gray-500 mb-4">
            Create your first event type to start accepting bookings.
          </p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn btn-primary"
          >
            Create Event Type
          </button>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {meetingTypes.map((type) => (
            <div
              key={type.id}
              className={`card border-t-4 ${type.is_active ? '' : 'opacity-60'}`}
              style={{ borderTopColor: type.color }}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{type.name}</h3>
                  <p className="text-sm text-gray-500">{type.duration_minutes} min</p>
                </div>
                <span
                  className={`px-2 py-1 text-xs rounded-full ${
                    type.is_active
                      ? 'bg-green-100 text-green-800'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {type.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>

              {type.description && (
                <p className="text-sm text-gray-600 mb-4 line-clamp-2">
                  {type.description}
                </p>
              )}

              <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                <button
                  onClick={() => copyBookingLink(type)}
                  className="text-primary-600 hover:text-primary-700 text-sm font-medium"
                >
                  Copy Link
                </button>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => handleToggleActive(type)}
                    className="p-2 text-gray-400 hover:text-gray-600"
                    title={type.is_active ? 'Deactivate' : 'Activate'}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {type.is_active ? (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      )}
                    </svg>
                  </button>
                  <button
                    onClick={() => setEditingType(type)}
                    className="p-2 text-gray-400 hover:text-gray-600"
                    title="Edit"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(type.id)}
                    className="p-2 text-gray-400 hover:text-red-600"
                    title="Delete"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>

              <Link
                to="/book/$meetingTypeId"
                params={{ meetingTypeId: type.id }}
                className="block mt-4 text-center btn btn-secondary text-sm"
              >
                Preview Booking Page
              </Link>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      {(showCreateModal || editingType) && (
        <MeetingTypeModal
          type={editingType}
          onClose={() => {
            setShowCreateModal(false);
            setEditingType(null);
          }}
          onSave={(savedType) => {
            if (editingType) {
              setMeetingTypes(
                meetingTypes.map((mt) => (mt.id === savedType.id ? savedType : mt))
              );
            } else {
              setMeetingTypes([...meetingTypes, savedType]);
            }
            setShowCreateModal(false);
            setEditingType(null);
          }}
        />
      )}
    </div>
  );
}

interface MeetingTypeModalProps {
  type: MeetingType | null;
  onClose: () => void;
  onSave: (type: MeetingType) => void;
}

function MeetingTypeModal({ type, onClose, onSave }: MeetingTypeModalProps) {
  const [name, setName] = useState(type?.name || '');
  const [slug, setSlug] = useState(type?.slug || '');
  const [description, setDescription] = useState(type?.description || '');
  const [duration, setDuration] = useState(type?.duration_minutes || 30);
  const [bufferBefore, setBufferBefore] = useState(type?.buffer_before_minutes || 0);
  const [bufferAfter, setBufferAfter] = useState(type?.buffer_after_minutes || 0);
  const [color, setColor] = useState(type?.color || '#3B82F6');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Auto-generate slug from name
  useEffect(() => {
    if (!type) {
      setSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }
  }, [name, type]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const data = {
        name,
        slug,
        description: description || undefined,
        duration_minutes: duration,
        buffer_before_minutes: bufferBefore,
        buffer_after_minutes: bufferAfter,
        color,
      };

      const response = type
        ? await meetingTypesApi.update(type.id, data)
        : await meetingTypesApi.create(data);

      if (response.success && response.data) {
        onSave(response.data);
      } else {
        setError(response.error || 'Failed to save event type');
      }
    } catch (err) {
      setError('An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">
            {type ? 'Edit Event Type' : 'New Event Type'}
          </h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="name" className="label">Event Name</label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input"
                required
                placeholder="e.g., 30 Minute Meeting"
              />
            </div>

            <div>
              <label htmlFor="slug" className="label">URL Slug</label>
              <input
                id="slug"
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="input"
                required
                pattern="[a-z0-9-]+"
                placeholder="e.g., 30-minute-meeting"
              />
              <p className="text-xs text-gray-500 mt-1">Lowercase letters, numbers, and hyphens only</p>
            </div>

            <div>
              <label htmlFor="description" className="label">Description (optional)</label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="input"
                rows={3}
                placeholder="Brief description of this meeting type"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label htmlFor="duration" className="label">Duration (min)</label>
                <select
                  id="duration"
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className="input"
                >
                  <option value={15}>15</option>
                  <option value={30}>30</option>
                  <option value={45}>45</option>
                  <option value={60}>60</option>
                  <option value={90}>90</option>
                  <option value={120}>120</option>
                </select>
              </div>

              <div>
                <label htmlFor="bufferBefore" className="label">Buffer Before</label>
                <select
                  id="bufferBefore"
                  value={bufferBefore}
                  onChange={(e) => setBufferBefore(Number(e.target.value))}
                  className="input"
                >
                  <option value={0}>None</option>
                  <option value={5}>5 min</option>
                  <option value={10}>10 min</option>
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                </select>
              </div>

              <div>
                <label htmlFor="bufferAfter" className="label">Buffer After</label>
                <select
                  id="bufferAfter"
                  value={bufferAfter}
                  onChange={(e) => setBufferAfter(Number(e.target.value))}
                  className="input"
                >
                  <option value={0}>None</option>
                  <option value={5}>5 min</option>
                  <option value={10}>10 min</option>
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="color" className="label">Color</label>
              <input
                id="color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-full h-10 rounded-lg cursor-pointer"
              />
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading}
                className="btn btn-primary"
              >
                {isLoading ? 'Saving...' : type ? 'Save Changes' : 'Create Event Type'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
