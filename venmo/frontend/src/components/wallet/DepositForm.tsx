/**
 * DepositForm component for adding money to Venmo balance.
 * This is a simulated deposit form for demo purposes.
 */

import { useState } from 'react';
import { api } from '../../services/api';
import { Button } from '../Button';

/**
 * Props for the DepositForm component.
 */
interface DepositFormProps {
  /** Callback function called when deposit is successful */
  onSuccess: () => void;
}

/**
 * Renders a form for depositing money into the Venmo wallet.
 * Allows users to enter an amount and add it to their balance.
 *
 * @remarks
 * This is a simulated deposit for demo purposes - in production,
 * this would integrate with actual payment processors.
 */
export function DepositForm({ onSuccess }: DepositFormProps) {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Handles the deposit submission.
   * Validates the amount and calls the API to process the deposit.
   */
  const handleDeposit = async () => {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await api.deposit(amountNum);
      onSuccess();
      setAmount('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deposit failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-4 p-4 bg-gray-50 rounded-lg">
      <h4 className="font-medium mb-3">Add Money (Demo)</h4>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
            $
          </span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-venmo-blue"
          />
        </div>
        <Button onClick={handleDeposit} loading={loading}>
          Add
        </Button>
      </div>
      {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
      <p className="text-xs text-gray-500 mt-2">
        This is a simulated deposit for demo purposes.
      </p>
    </div>
  );
}
