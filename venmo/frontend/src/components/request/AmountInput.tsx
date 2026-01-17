/**
 * AmountInput component for entering monetary amounts.
 * Displays a styled input with dollar sign prefix.
 */

/**
 * Props for the AmountInput component.
 */
interface AmountInputProps {
  /** Current amount value as a string */
  value: string;
  /** Callback when amount changes */
  onChange: (value: string) => void;
  /** Maximum allowed amount (optional) */
  max?: number;
  /** Whether the field is required */
  required?: boolean;
}

/**
 * Renders a styled monetary amount input with dollar sign prefix.
 */
export function AmountInput({
  value,
  onChange,
  max = 5000,
  required = false,
}: AmountInputProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Amount
      </label>
      <div className="relative">
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">
          $
        </span>
        <input
          type="number"
          step="0.01"
          min="0.01"
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.00"
          required={required}
          className="w-full pl-8 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-venmo-blue focus:border-transparent"
        />
      </div>
    </div>
  );
}
