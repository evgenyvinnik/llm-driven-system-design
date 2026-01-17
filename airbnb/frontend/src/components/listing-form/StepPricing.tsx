/**
 * Step 4 of the listing creation wizard.
 * Collects pricing and booking settings.
 */
import { ListingFormData, StepNavigationProps } from './types';

interface StepPricingProps extends StepNavigationProps {
  /** Current form data */
  formData: ListingFormData;
  /** Callback to update form fields */
  onUpdate: <K extends keyof ListingFormData>(field: K, value: ListingFormData[K]) => void;
  /** Whether the form is currently being submitted */
  isLoading: boolean;
  /** Callback to submit the form */
  onSubmit: () => void;
}

/**
 * Renders the pricing step of the listing form.
 * Includes price, cleaning fee, minimum nights, and instant book settings.
 * This is the final step that submits the form.
 *
 * @param props - Component props
 * @returns JSX element for the pricing step
 */
export function StepPricing({
  formData,
  onUpdate,
  onBack,
  isLoading,
  onSubmit,
}: StepPricingProps) {
  const { pricePerNight, cleaningFee, minimumNights, instantBook } = formData;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Set your price</h2>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-2">Price per night ($)</label>
          <input
            type="number"
            min={10}
            value={pricePerNight}
            onChange={(e) => onUpdate('pricePerNight', parseInt(e.target.value) || 0)}
            className="w-full input-field"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Cleaning fee ($)</label>
          <input
            type="number"
            min={0}
            value={cleaningFee}
            onChange={(e) => onUpdate('cleaningFee', parseInt(e.target.value) || 0)}
            className="w-full input-field"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Minimum nights</label>
        <input
          type="number"
          min={1}
          value={minimumNights}
          onChange={(e) => onUpdate('minimumNights', parseInt(e.target.value) || 1)}
          className="w-full input-field"
        />
      </div>

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={instantBook}
          onChange={(e) => onUpdate('instantBook', e.target.checked)}
          className="w-5 h-5"
        />
        <div>
          <span className="font-medium">Instant Book</span>
          <p className="text-sm text-gray-500">
            Allow guests to book immediately without approval
          </p>
        </div>
      </label>

      <div className="flex gap-4">
        <button onClick={onBack} className="btn-secondary">
          Back
        </button>
        <button
          onClick={onSubmit}
          disabled={isLoading}
          className="btn-primary disabled:opacity-50"
        >
          {isLoading ? 'Creating...' : 'Create Listing'}
        </button>
      </div>
    </div>
  );
}
