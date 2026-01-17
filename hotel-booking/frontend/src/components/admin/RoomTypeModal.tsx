import { useState } from 'react';
import { api } from '@/services/api';
import type { RoomType } from '@/types';
import { getAmenityLabel } from '@/utils';
import { CloseIcon } from '@/components/icons';

/**
 * Props for the RoomTypeModal component.
 */
interface RoomTypeModalProps {
  /** The hotel ID this room type belongs to */
  hotelId: string;
  /** Existing room type to edit, or null for creating a new one */
  room: RoomType | null;
  /** Callback when the modal is closed without saving */
  onClose: () => void;
  /** Callback when the room type is successfully saved */
  onSuccess: () => void;
}

/**
 * Form data structure for room type creation/editing.
 */
interface RoomTypeFormData {
  name: string;
  description: string;
  capacity: number;
  bedType: string;
  totalCount: number;
  basePrice: number;
  amenities: string[];
  sizeSqm: number;
}

/** Available amenity options for room types. */
const AMENITY_OPTIONS = ['wifi', 'tv', 'minibar', 'safe', 'balcony', 'bathtub', 'living_room', 'kitchen'];

/** Available bed type options. */
const BED_TYPE_OPTIONS = ['Single', 'Double', 'Queen', 'King', 'Twin', 'Multiple'];

/**
 * Modal component for creating and editing hotel room types.
 * Provides a form for room details including name, capacity, pricing, and amenities.
 *
 * @param props - Component props
 * @returns A modal dialog for room type management
 *
 * @example
 * ```tsx
 * <RoomTypeModal
 *   hotelId="hotel-123"
 *   room={null}
 *   onClose={() => setShowModal(false)}
 *   onSuccess={() => { setShowModal(false); refreshData(); }}
 * />
 * ```
 */
export function RoomTypeModal({ hotelId, room, onClose, onSuccess }: RoomTypeModalProps) {
  const [formData, setFormData] = useState<RoomTypeFormData>({
    name: room?.name || '',
    description: room?.description || '',
    capacity: room?.capacity || 2,
    bedType: room?.bedType || 'Queen',
    totalCount: room?.totalCount || 1,
    basePrice: room?.basePrice || 100,
    amenities: room?.amenities || [],
    sizeSqm: room?.sizeSqm || 25,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Handles form submission for creating or updating a room type.
   * @param e - Form submission event
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (room) {
        await api.updateRoomType(room.id, formData);
      } else {
        await api.createRoomType(hotelId, formData);
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save room type');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Toggles an amenity in the selected amenities list.
   * @param amenity - The amenity code to toggle
   */
  const toggleAmenity = (amenity: string) => {
    setFormData({
      ...formData,
      amenities: formData.amenities.includes(amenity)
        ? formData.amenities.filter((a) => a !== amenity)
        : [...formData.amenities, amenity],
    });
  };

  /**
   * Updates a form field value.
   * @param field - The field name to update
   * @param value - The new value
   */
  const updateField = <K extends keyof RoomTypeFormData>(field: K, value: RoomTypeFormData[K]) => {
    setFormData({ ...formData, [field]: value });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 max-w-lg w-full max-h-[90vh] overflow-auto">
        <ModalHeader title={room ? 'Edit Room Type' : 'Add Room Type'} onClose={onClose} />

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <ErrorAlert message={error} />}

          <FormField label="Room Name *">
            <input
              type="text"
              className="input"
              value={formData.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="e.g., Deluxe King Room"
              required
            />
          </FormField>

          <FormField label="Description">
            <textarea
              className="input"
              rows={2}
              value={formData.description}
              onChange={(e) => updateField('description', e.target.value)}
            />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Capacity *">
              <input
                type="number"
                className="input"
                min="1"
                value={formData.capacity}
                onChange={(e) => updateField('capacity', Number(e.target.value))}
                required
              />
            </FormField>
            <FormField label="Bed Type">
              <select
                className="input"
                value={formData.bedType}
                onChange={(e) => updateField('bedType', e.target.value)}
              >
                {BED_TYPE_OPTIONS.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Total Rooms *">
              <input
                type="number"
                className="input"
                min="1"
                value={formData.totalCount}
                onChange={(e) => updateField('totalCount', Number(e.target.value))}
                required
              />
            </FormField>
            <FormField label="Size (m2)">
              <input
                type="number"
                className="input"
                min="1"
                value={formData.sizeSqm}
                onChange={(e) => updateField('sizeSqm', Number(e.target.value))}
              />
            </FormField>
          </div>

          <FormField label="Base Price per Night *">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
              <input
                type="number"
                className="input pl-8"
                min="1"
                step="0.01"
                value={formData.basePrice}
                onChange={(e) => updateField('basePrice', Number(e.target.value))}
                required
              />
            </div>
          </FormField>

          <FormField label="Amenities">
            <div className="flex flex-wrap gap-2">
              {AMENITY_OPTIONS.map((amenity) => (
                <button
                  key={amenity}
                  type="button"
                  onClick={() => toggleAmenity(amenity)}
                  className={`px-3 py-1 rounded-full text-sm ${
                    formData.amenities.includes(amenity)
                      ? 'bg-primary-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {getAmenityLabel(amenity)}
                </button>
              ))}
            </div>
          </FormField>

          <div className="flex space-x-4 pt-4">
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? 'Saving...' : room ? 'Update Room' : 'Add Room'}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Modal header with title and close button.
 */
function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex justify-between items-center mb-6">
      <h2 className="text-xl font-bold">{title}</h2>
      <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
        <CloseIcon className="w-6 h-6" />
      </button>
    </div>
  );
}

/**
 * Reusable form field wrapper with label.
 */
function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

/**
 * Error alert component for displaying form errors.
 */
function ErrorAlert({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-3">
      <p className="text-red-800 text-sm">{message}</p>
    </div>
  );
}
