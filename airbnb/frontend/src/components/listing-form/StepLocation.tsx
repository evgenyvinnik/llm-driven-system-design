/**
 * Step 2 of the listing creation wizard.
 * Collects location information including city, state, country, and coordinates.
 */
import { ListingFormData, StepNavigationProps } from './types';

interface StepLocationProps extends StepNavigationProps {
  /** Current form data */
  formData: ListingFormData;
  /** Callback to update form fields */
  onUpdate: <K extends keyof ListingFormData>(field: K, value: ListingFormData[K]) => void;
}

/**
 * Renders the location step of the listing form.
 * Includes city, state, country, latitude, and longitude fields.
 *
 * @param props - Component props
 * @returns JSX element for the location step
 */
export function StepLocation({ formData, onUpdate, onNext, onBack }: StepLocationProps) {
  const { city, state, country, latitude, longitude } = formData;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Where is your place located?</h2>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-2">City</label>
          <input
            type="text"
            value={city}
            onChange={(e) => onUpdate('city', e.target.value)}
            className="w-full input-field"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">State/Province</label>
          <input
            type="text"
            value={state}
            onChange={(e) => onUpdate('state', e.target.value)}
            className="w-full input-field"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Country</label>
        <input
          type="text"
          value={country}
          onChange={(e) => onUpdate('country', e.target.value)}
          className="w-full input-field"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-2">Latitude</label>
          <input
            type="number"
            step="any"
            value={latitude}
            onChange={(e) => onUpdate('latitude', e.target.value)}
            placeholder="40.7128"
            className="w-full input-field"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Longitude</label>
          <input
            type="number"
            step="any"
            value={longitude}
            onChange={(e) => onUpdate('longitude', e.target.value)}
            placeholder="-74.0060"
            className="w-full input-field"
          />
        </div>
      </div>

      <div className="flex gap-4">
        <button onClick={onBack} className="btn-secondary">
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!city || !country}
          className="btn-primary disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
