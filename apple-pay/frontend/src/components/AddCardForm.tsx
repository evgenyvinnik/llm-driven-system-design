/**
 * AddCardForm component for provisioning new payment cards.
 * Provides form fields for card number, expiry, CVV, and holder name.
 * Includes test card buttons for demo purposes.
 */
import { useState } from 'react';

/**
 * Props for the AddCardForm component.
 */
interface AddCardFormProps {
  /** Target device ID for card provisioning */
  deviceId: string;
  /** Submit handler - receives card data and provisions to device */
  onSubmit: (data: {
    pan: string;
    expiry_month: number;
    expiry_year: number;
    cvv: string;
    card_holder_name: string;
    device_id: string;
  }) => Promise<void>;
  /** Callback when user cancels the form */
  onCancel: () => void;
  /** Whether form submission is in progress */
  isLoading?: boolean;
}

/**
 * Renders a form for adding a new payment card to a device.
 * Includes validation, formatting, and test card quick-fill buttons.
 * Card numbers are validated for length before submission.
 *
 * @param props - AddCardForm component props
 * @returns JSX element representing the add card form
 */
export function AddCardForm({ deviceId, onSubmit, onCancel, isLoading }: AddCardFormProps) {
  const [pan, setPan] = useState('');
  const [expiryMonth, setExpiryMonth] = useState('');
  const [expiryYear, setExpiryYear] = useState('');
  const [cvv, setCvv] = useState('');
  const [cardHolderName, setCardHolderName] = useState('');
  const [error, setError] = useState('');

  const formatPan = (value: string) => {
    const digits = value.replace(/\D/g, '');
    return digits.slice(0, 16);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (pan.length < 13) {
      setError('Please enter a valid card number');
      return;
    }

    if (!expiryMonth || !expiryYear) {
      setError('Please enter a valid expiry date');
      return;
    }

    if (cvv.length < 3) {
      setError('Please enter a valid CVV');
      return;
    }

    if (!cardHolderName.trim()) {
      setError('Please enter the card holder name');
      return;
    }

    try {
      await onSubmit({
        pan,
        expiry_month: parseInt(expiryMonth),
        expiry_year: parseInt(expiryYear),
        cvv,
        card_holder_name: cardHolderName.trim(),
        device_id: deviceId,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Test card numbers for demo
  const testCards = [
    { name: 'Visa', pan: '4111111111111111' },
    { name: 'Mastercard', pan: '5555555555554444' },
    { name: 'Amex', pan: '378282246310005' },
  ];

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h3 className="text-xl font-semibold text-apple-gray-900 mb-4">
        Add a Card
      </h3>

      {error && (
        <div className="bg-apple-red/10 text-apple-red p-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* Test cards for demo */}
      <div className="bg-apple-gray-100 p-3 rounded-xl">
        <div className="text-xs text-apple-gray-500 mb-2">
          Demo: Click to use a test card
        </div>
        <div className="flex gap-2 flex-wrap">
          {testCards.map((card) => (
            <button
              key={card.name}
              type="button"
              onClick={() => {
                setPan(card.pan);
                setExpiryMonth('12');
                setExpiryYear('2028');
                setCvv('123');
                setCardHolderName('Demo User');
              }}
              className="text-xs bg-white px-3 py-1 rounded-lg hover:bg-apple-gray-50"
            >
              {card.name}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-apple-gray-700 mb-1">
          Card Number
        </label>
        <input
          type="text"
          value={pan.replace(/(.{4})/g, '$1 ').trim()}
          onChange={(e) => setPan(formatPan(e.target.value))}
          placeholder="1234 5678 9012 3456"
          className="input font-mono"
          maxLength={19}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-apple-gray-700 mb-1">
            Month
          </label>
          <select
            value={expiryMonth}
            onChange={(e) => setExpiryMonth(e.target.value)}
            className="input"
          >
            <option value="">MM</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m.toString().padStart(2, '0')}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-apple-gray-700 mb-1">
            Year
          </label>
          <select
            value={expiryYear}
            onChange={(e) => setExpiryYear(e.target.value)}
            className="input"
          >
            <option value="">YYYY</option>
            {Array.from({ length: 10 }, (_, i) => new Date().getFullYear() + i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-apple-gray-700 mb-1">
            CVV
          </label>
          <input
            type="text"
            value={cvv}
            onChange={(e) => setCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="123"
            className="input font-mono"
            maxLength={4}
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-apple-gray-700 mb-1">
          Card Holder Name
        </label>
        <input
          type="text"
          value={cardHolderName}
          onChange={(e) => setCardHolderName(e.target.value.toUpperCase())}
          placeholder="JOHN SMITH"
          className="input uppercase"
        />
      </div>

      <div className="flex gap-3 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="btn-secondary flex-1"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="btn-primary flex-1"
        >
          {isLoading ? 'Adding...' : 'Add Card'}
        </button>
      </div>
    </form>
  );
}
