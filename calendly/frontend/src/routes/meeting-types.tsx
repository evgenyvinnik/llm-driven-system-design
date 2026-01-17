import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { meetingTypesApi } from '../services/api';
import type { MeetingType } from '../types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import {
  MeetingTypeCard,
  MeetingTypeModal,
  MeetingTypesEmptyState,
} from '../components/meeting-types';

/**
 * Route configuration for the meeting types page.
 * Requires authentication - redirects to login if not authenticated.
 */
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

/**
 * Meeting types management page component.
 * Allows users to view, create, edit, and delete their meeting types.
 * Displays meeting types as cards with actions for each.
 */
function MeetingTypesPage() {
  const [meetingTypes, setMeetingTypes] = useState<MeetingType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingType, setEditingType] = useState<MeetingType | null>(null);

  useEffect(() => {
    loadMeetingTypes();
  }, []);

  /**
   * Fetches meeting types from the API and updates state.
   */
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

  /**
   * Deletes a meeting type after confirmation.
   * @param id - The ID of the meeting type to delete
   */
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

  /**
   * Toggles the active state of a meeting type.
   * @param type - The meeting type to toggle
   */
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

  /**
   * Copies the booking link for a meeting type to the clipboard.
   * @param type - The meeting type to copy the link for
   */
  const copyBookingLink = (type: MeetingType) => {
    const link = `${window.location.origin}/book/${type.id}`;
    navigator.clipboard.writeText(link);
    alert('Booking link copied to clipboard!');
  };

  /**
   * Handles saving a meeting type from the modal.
   * Updates or adds the meeting type to the list.
   * @param savedType - The saved meeting type
   */
  const handleSave = (savedType: MeetingType) => {
    if (editingType) {
      setMeetingTypes(
        meetingTypes.map((mt) => (mt.id === savedType.id ? savedType : mt))
      );
    } else {
      setMeetingTypes([...meetingTypes, savedType]);
    }
    setShowCreateModal(false);
    setEditingType(null);
  };

  /**
   * Closes the create/edit modal.
   */
  const handleCloseModal = () => {
    setShowCreateModal(false);
    setEditingType(null);
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
      <MeetingTypesHeader onCreateClick={() => setShowCreateModal(true)} />

      {meetingTypes.length === 0 ? (
        <MeetingTypesEmptyState onCreateClick={() => setShowCreateModal(true)} />
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {meetingTypes.map((type) => (
            <MeetingTypeCard
              key={type.id}
              meetingType={type}
              onCopyLink={copyBookingLink}
              onToggleActive={handleToggleActive}
              onEdit={setEditingType}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {(showCreateModal || editingType) && (
        <MeetingTypeModal
          type={editingType}
          onClose={handleCloseModal}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

/**
 * Props for the MeetingTypesHeader component.
 */
interface MeetingTypesHeaderProps {
  /** Callback fired when the create button is clicked */
  onCreateClick: () => void;
}

/**
 * Header section of the meeting types page.
 * Displays the page title, description, and create button.
 *
 * @param props - Component props
 */
function MeetingTypesHeader({ onCreateClick }: MeetingTypesHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Event Types</h1>
        <p className="text-gray-600 mt-1">
          Create and manage meeting types that people can book with you.
        </p>
      </div>
      <button
        onClick={onCreateClick}
        className="btn btn-primary"
      >
        + New Event Type
      </button>
    </div>
  );
}
