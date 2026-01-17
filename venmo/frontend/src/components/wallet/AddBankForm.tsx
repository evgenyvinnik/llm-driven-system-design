/**
 * AddBankForm component for linking a new bank account.
 * This is a simulated bank linking form for demo purposes.
 */

import { useState } from 'react';
import { api } from '../../services/api';
import { Button } from '../Button';
import { Input } from '../Input';

/**
 * Props for the AddBankForm component.
 */
interface AddBankFormProps {
  /** Callback when bank account is successfully added */
  onSuccess: () => void;
  /** Callback to cancel/close the form */
  onCancel: () => void;
}

/**
 * Form data structure for adding a bank account.
 */
interface BankFormData {
  bankName: string;
  accountType: string;
  routingNumber: string;
  accountNumber: string;
}

const initialFormData: BankFormData = {
  bankName: '',
  accountType: 'Checking',
  routingNumber: '',
  accountNumber: '',
};

/**
 * Renders a form for adding a new bank account to the user's wallet.
 * Collects bank name, routing number, and account number.
 *
 * @remarks
 * This is a simulated bank link for demo purposes - in production,
 * this would use Plaid or similar for secure bank verification.
 */
export function AddBankForm({ onSuccess, onCancel }: AddBankFormProps) {
  const [formData, setFormData] = useState<BankFormData>(initialFormData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Updates a specific field in the form data.
   */
  const updateField = (field: keyof BankFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  /**
   * Handles form submission - validates and adds the bank account.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      await api.addBankAccount(formData);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add bank');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white rounded-lg shadow-sm p-4 space-y-4"
    >
      <h3 className="font-medium">Add Bank Account (Simulated)</h3>

      <Input
        label="Bank Name"
        value={formData.bankName}
        onChange={(e) => updateField('bankName', e.target.value)}
        placeholder="e.g., Chase, Bank of America"
        required
      />

      <Input
        label="Routing Number"
        value={formData.routingNumber}
        onChange={(e) => updateField('routingNumber', e.target.value)}
        placeholder="9 digits"
        maxLength={9}
        required
      />

      <Input
        label="Account Number"
        value={formData.accountNumber}
        onChange={(e) => updateField('accountNumber', e.target.value)}
        placeholder="Account number"
        required
      />

      {error && <p className="text-red-500 text-sm">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" loading={loading} className="flex-1">
          Link Bank Account
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
          Cancel
        </Button>
      </div>

      <p className="text-xs text-gray-500 text-center">
        This is a simulated bank link for demo purposes.
      </p>
    </form>
  );
}
