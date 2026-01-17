/**
 * Step 3 of the listing creation wizard.
 * Collects property details including capacity, amenities, and house rules.
 */
import { getAmenityLabel } from '../../utils/helpers';
import { AMENITIES, ListingFormData, StepNavigationProps } from './types';

interface StepDetailsProps extends StepNavigationProps {
  /** Current form data */
  formData: ListingFormData;
  /** Callback to update form fields */
  onUpdate: <K extends keyof ListingFormData>(field: K, value: ListingFormData[K]) => void;
}

/**
 * Toggles an amenity in the amenities array.
 *
 * @param amenities - Current amenities array
 * @param amenity - Amenity to toggle
 * @returns New amenities array with the amenity toggled
 */
function toggleAmenity(amenities: string[], amenity: string): string[] {
  return amenities.includes(amenity)
    ? amenities.filter((a) => a !== amenity)
    : [...amenities, amenity];
}

/**
 * Renders the details step of the listing form.
 * Includes guest capacity, rooms, amenities, and house rules fields.
 *
 * @param props - Component props
 * @returns JSX element for the details step
 */
export function StepDetails({ formData, onUpdate, onNext, onBack }: StepDetailsProps) {
  const { maxGuests, bedrooms, beds, bathrooms, amenities, houseRules } = formData;

  /**
   * Handles amenity button clicks by toggling the amenity.
   */
  const handleAmenityToggle = (amenity: string) => {
    onUpdate('amenities', toggleAmenity(amenities, amenity));
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Share some details</h2>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-2">Max guests</label>
          <input
            type="number"
            min={1}
            value={maxGuests}
            onChange={(e) => onUpdate('maxGuests', parseInt(e.target.value) || 1)}
            className="w-full input-field"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Bedrooms</label>
          <input
            type="number"
            min={0}
            value={bedrooms}
            onChange={(e) => onUpdate('bedrooms', parseInt(e.target.value) || 0)}
            className="w-full input-field"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Beds</label>
          <input
            type="number"
            min={1}
            value={beds}
            onChange={(e) => onUpdate('beds', parseInt(e.target.value) || 1)}
            className="w-full input-field"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Bathrooms</label>
          <input
            type="number"
            min={0}
            step={0.5}
            value={bathrooms}
            onChange={(e) => onUpdate('bathrooms', parseFloat(e.target.value) || 1)}
            className="w-full input-field"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Amenities</label>
        <div className="flex flex-wrap gap-2">
          {AMENITIES.map((amenity) => (
            <button
              key={amenity}
              type="button"
              onClick={() => handleAmenityToggle(amenity)}
              className={`px-3 py-2 rounded-lg text-sm ${
                amenities.includes(amenity)
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {getAmenityLabel(amenity)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">House rules</label>
        <textarea
          value={houseRules}
          onChange={(e) => onUpdate('houseRules', e.target.value)}
          placeholder="No smoking, no parties..."
          rows={3}
          className="w-full input-field"
        />
      </div>

      <div className="flex gap-4">
        <button onClick={onBack} className="btn-secondary">
          Back
        </button>
        <button onClick={onNext} className="btn-primary">
          Next
        </button>
      </div>
    </div>
  );
}
