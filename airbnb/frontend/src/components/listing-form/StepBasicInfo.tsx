/**
 * Step 1 of the listing creation wizard.
 * Collects basic information about the property including type, title, and description.
 */
import { getPropertyTypeLabel, getRoomTypeLabel } from '../../utils/helpers';
import {
  PROPERTY_TYPES,
  ROOM_TYPES,
  ListingFormData,
  StepNavigationProps,
} from './types';

interface StepBasicInfoProps extends StepNavigationProps {
  /** Current form data */
  formData: ListingFormData;
  /** Callback to update form fields */
  onUpdate: <K extends keyof ListingFormData>(field: K, value: ListingFormData[K]) => void;
}

/**
 * Renders the basic information step of the listing form.
 * Includes property type, room type, title, and description fields.
 *
 * @param props - Component props
 * @returns JSX element for the basic info step
 */
export function StepBasicInfo({ formData, onUpdate, onNext }: StepBasicInfoProps) {
  const { propertyType, roomType, title, description } = formData;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Tell us about your place</h2>

      <div>
        <label className="block text-sm font-medium mb-2">Property type</label>
        <select
          value={propertyType}
          onChange={(e) => onUpdate('propertyType', e.target.value as ListingFormData['propertyType'])}
          className="w-full input-field"
        >
          {PROPERTY_TYPES.map((type) => (
            <option key={type} value={type}>
              {getPropertyTypeLabel(type)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Room type</label>
        <select
          value={roomType}
          onChange={(e) => onUpdate('roomType', e.target.value as ListingFormData['roomType'])}
          className="w-full input-field"
        >
          {ROOM_TYPES.map((type) => (
            <option key={type} value={type}>
              {getRoomTypeLabel(type)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => onUpdate('title', e.target.value)}
          placeholder="Cozy apartment in downtown..."
          className="w-full input-field"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Description</label>
        <textarea
          value={description}
          onChange={(e) => onUpdate('description', e.target.value)}
          placeholder="Describe your space..."
          rows={4}
          className="w-full input-field"
        />
      </div>

      <button
        onClick={onNext}
        disabled={!title}
        className="btn-primary disabled:opacity-50"
      >
        Next
      </button>
    </div>
  );
}
