/**
 * PaymentMethodItem component for displaying a single payment method.
 */

import { api } from '../../services/api';
import { BankIcon, CardIcon, CloseIcon } from '../icons';
import type { PaymentMethod } from '../../types';

/**
 * Props for the PaymentMethodItem component.
 */
interface PaymentMethodItemProps {
  /** The payment method to display */
  method: PaymentMethod;
  /** Callback to refresh data after changes */
  onUpdate: () => void;
}

/**
 * Renders a single payment method with icon, details, and action buttons.
 * Allows setting as default or removing the payment method.
 */
export function PaymentMethodItem({ method, onUpdate }: PaymentMethodItemProps) {
  /**
   * Handles setting this payment method as the default.
   */
  const handleSetDefault = async () => {
    try {
      await api.setDefaultPaymentMethod(method.id);
      onUpdate();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to set default');
    }
  };

  /**
   * Handles deleting this payment method with confirmation.
   */
  const handleDelete = async () => {
    if (!confirm('Remove this payment method?')) return;
    try {
      await api.deletePaymentMethod(method.id);
      onUpdate();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  return (
    <div className="p-4 flex items-center gap-3">
      <PaymentMethodIcon type={method.type} />
      <div className="flex-1">
        <p className="font-medium">{method.name}</p>
        <p className="text-sm text-gray-500">
          {method.type === 'bank' ? method.bank_name : 'Card'} - ...{method.last4}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {method.is_default ? (
          <span className="text-xs bg-venmo-blue text-white px-2 py-1 rounded-full">
            Default
          </span>
        ) : (
          <button
            onClick={handleSetDefault}
            className="text-xs text-venmo-blue hover:underline"
          >
            Set default
          </button>
        )}
        <button
          onClick={handleDelete}
          className="text-gray-400 hover:text-red-500"
        >
          <CloseIcon className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

/**
 * Props for the PaymentMethodIcon component.
 */
interface PaymentMethodIconProps {
  /** Type of payment method */
  type: 'bank' | 'card' | 'debit_card';
}

/**
 * Renders the appropriate icon for a payment method type.
 */
function PaymentMethodIcon({ type }: PaymentMethodIconProps) {
  return (
    <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
      {type === 'bank' ? (
        <BankIcon className="w-5 h-5 text-gray-600" />
      ) : (
        <CardIcon className="w-5 h-5 text-gray-600" />
      )}
    </div>
  );
}
