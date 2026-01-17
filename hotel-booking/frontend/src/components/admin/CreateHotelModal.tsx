import { useState } from 'react';
import { api } from '@/services/api';
import { CloseIcon } from '@/components/icons';

/**
 * Props for the CreateHotelModal component.
 */
interface CreateHotelModalProps {
  /** Callback when the modal is closed without saving */
  onClose: () => void;
  /** Callback when the hotel is successfully created */
  onSuccess: () => void;
}

/**
 * Form data structure for hotel creation.
 */
interface CreateHotelFormData {
  name: string;
  description: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  starRating: number;
  amenities: string[];
}

/** Available amenity options for hotels. */
const HOTEL_AMENITY_OPTIONS = ['wifi', 'pool', 'gym', 'spa', 'restaurant', 'bar', 'parking', 'room_service'];

/** Star rating options. */
const STAR_RATING_OPTIONS = [1, 2, 3, 4, 5];

/**
 * Modal component for creating a new hotel property.
 * Provides a comprehensive form for entering hotel details including
 * location, star rating, and amenities.
 *
 * @param props - Component props
 * @returns A modal dialog for hotel creation
 *
 * @example
 * ```tsx
 * <CreateHotelModal
 *   onClose={() => setShowModal(false)}
 *   onSuccess={() => { setShowModal(false); refreshHotels(); }}
 * />
 * ```
 */
export function CreateHotelModal({ onClose, onSuccess }: CreateHotelModalProps) {
  const [formData, setFormData] = useState<CreateHotelFormData>({
    name: '',
    description: '',
    address: '',
    city: '',
    state: '',
    country: 'USA',
    postalCode: '',
    starRating: 3,
    amenities: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Handles form submission for creating a hotel.
   * @param e - Form submission event
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await api.createHotel(formData);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create hotel');
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
  const updateField = <K extends keyof CreateHotelFormData>(field: K, value: CreateHotelFormData[K]) => {
    setFormData({ ...formData, [field]: value });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-auto">
        <ModalHeader title="Add New Hotel" onClose={onClose} />

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <ErrorAlert message={error} />}

          <FormField label="Hotel Name *">
            <input
              type="text"
              className="input"
              value={formData.name}
              onChange={(e) => updateField('name', e.target.value)}
              required
            />
          </FormField>

          <FormField label="Description">
            <textarea
              className="input"
              rows={3}
              value={formData.description}
              onChange={(e) => updateField('description', e.target.value)}
            />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Address *">
              <input
                type="text"
                className="input"
                value={formData.address}
                onChange={(e) => updateField('address', e.target.value)}
                required
              />
            </FormField>
            <FormField label="City *">
              <input
                type="text"
                className="input"
                value={formData.city}
                onChange={(e) => updateField('city', e.target.value)}
                required
              />
            </FormField>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <FormField label="State">
              <input
                type="text"
                className="input"
                value={formData.state}
                onChange={(e) => updateField('state', e.target.value)}
              />
            </FormField>
            <FormField label="Country *">
              <input
                type="text"
                className="input"
                value={formData.country}
                onChange={(e) => updateField('country', e.target.value)}
                required
              />
            </FormField>
            <FormField label="Postal Code">
              <input
                type="text"
                className="input"
                value={formData.postalCode}
                onChange={(e) => updateField('postalCode', e.target.value)}
              />
            </FormField>
          </div>

          <FormField label="Star Rating">
            <select
              className="input"
              value={formData.starRating}
              onChange={(e) => updateField('starRating', Number(e.target.value))}
            >
              {STAR_RATING_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} Star{n !== 1 ? 's' : ''}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Amenities">
            <div className="flex flex-wrap gap-2">
              {HOTEL_AMENITY_OPTIONS.map((amenity) => (
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
                  {formatAmenityLabel(amenity)}
                </button>
              ))}
            </div>
          </FormField>

          <div className="flex space-x-4 pt-4">
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? 'Creating...' : 'Create Hotel'}
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
 * Formats an amenity code to a display label.
 * @param amenity - The amenity code
 * @returns Human-readable amenity label
 */
function formatAmenityLabel(amenity: string): string {
  return amenity.replace(/_/g, ' ');
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
