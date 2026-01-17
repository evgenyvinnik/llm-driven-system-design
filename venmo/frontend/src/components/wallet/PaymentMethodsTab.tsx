/**
 * PaymentMethodsTab component for managing linked payment methods.
 * Displays existing methods and allows adding new bank accounts.
 */

import { useState } from 'react';
import { Button } from '../Button';
import { PaymentMethodItem } from './PaymentMethodItem';
import { AddBankForm } from './AddBankForm';
import type { PaymentMethod } from '../../types';

/**
 * Props for the PaymentMethodsTab component.
 */
interface PaymentMethodsTabProps {
  /** List of linked payment methods */
  methods: PaymentMethod[];
  /** Callback to refresh data after changes */
  onUpdate: () => void;
}

/**
 * Renders the Payment Methods tab content.
 * Shows a list of existing payment methods and allows adding new bank accounts.
 */
export function PaymentMethodsTab({ methods, onUpdate }: PaymentMethodsTabProps) {
  const [showAddBank, setShowAddBank] = useState(false);

  /**
   * Handles successful bank account addition.
   */
  const handleBankAdded = () => {
    onUpdate();
    setShowAddBank(false);
  };

  return (
    <div className="space-y-4">
      <PaymentMethodsList methods={methods} onUpdate={onUpdate} />

      <Button
        onClick={() => setShowAddBank(!showAddBank)}
        variant="secondary"
        className="w-full"
      >
        {showAddBank ? 'Cancel' : 'Add Bank Account'}
      </Button>

      {showAddBank && (
        <AddBankForm
          onSuccess={handleBankAdded}
          onCancel={() => setShowAddBank(false)}
        />
      )}
    </div>
  );
}

/**
 * Props for the PaymentMethodsList component.
 */
interface PaymentMethodsListProps {
  /** List of payment methods to display */
  methods: PaymentMethod[];
  /** Callback to refresh data after changes */
  onUpdate: () => void;
}

/**
 * Renders the list of payment methods or an empty state.
 */
function PaymentMethodsList({ methods, onUpdate }: PaymentMethodsListProps) {
  if (methods.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm">
        <div className="p-8 text-center">
          <p className="text-gray-500 mb-4">No payment methods linked</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm">
      <div className="divide-y">
        {methods.map((method) => (
          <PaymentMethodItem key={method.id} method={method} onUpdate={onUpdate} />
        ))}
      </div>
    </div>
  );
}
