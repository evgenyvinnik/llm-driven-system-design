import { useState } from 'react';
import { api } from '@/services/api';
import { CloseIcon } from '@/components/icons';

/**
 * Props for the PricingModal component.
 */
interface PricingModalProps {
  /** The room type ID to set pricing for */
  roomTypeId: string;
  /** Callback when the modal is closed */
  onClose: () => void;
}

/**
 * Modal component for managing dynamic pricing overrides for room types.
 * Allows hotel admins to set custom prices for specific dates, which
 * override the base price for that room type.
 *
 * @param props - Component props
 * @returns A modal dialog for price override management
 *
 * @example
 * ```tsx
 * <PricingModal
 *   roomTypeId="room-123"
 *   onClose={() => setShowPricingModal(false)}
 * />
 * ```
 */
export function PricingModal({ roomTypeId, onClose }: PricingModalProps) {
  const [date, setDate] = useState('');
  const [price, setPrice] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  /**
   * Handles form submission for setting a price override.
   * @param e - Form submission event
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await api.setPriceOverride(roomTypeId, date, Number(price));
      setSuccess(`Price set for ${date}`);
      setDate('');
      setPrice('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set price');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Gets the minimum selectable date (today).
   * @returns Today's date in ISO format (YYYY-MM-DD)
   */
  const getMinDate = () => new Date().toISOString().split('T')[0];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 max-w-md w-full">
        <ModalHeader title="Manage Pricing" onClose={onClose} />

        <p className="text-gray-600 mb-4">
          Set custom pricing for specific dates. This will override the base price.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <ErrorAlert message={error} />}
          {success && <SuccessAlert message={success} />}

          <FormField label="Date">
            <input
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={getMinDate()}
              required
            />
          </FormField>

          <FormField label="Price">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
              <input
                type="number"
                className="input pl-8"
                min="1"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required
              />
            </div>
          </FormField>

          <div className="flex space-x-4 pt-4">
            <button type="submit" disabled={loading} className="btn-primary flex-1">
              {loading ? 'Saving...' : 'Set Price'}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Close
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

/**
 * Success alert component for displaying success messages.
 */
function SuccessAlert({ message }: { message: string }) {
  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-3">
      <p className="text-green-800 text-sm">{message}</p>
    </div>
  );
}
