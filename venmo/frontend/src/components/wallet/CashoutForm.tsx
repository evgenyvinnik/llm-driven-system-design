/**
 * CashoutForm component for transferring money from Venmo to bank account.
 * Supports both standard (free, 1-3 days) and instant (1.5% fee) cashout options.
 */

import { useState } from 'react';
import { api } from '../../services/api';
import { Button } from '../Button';
import { formatCurrency } from '../../utils';

/**
 * Props for the CashoutForm component.
 */
interface CashoutFormProps {
  /** Current wallet balance in cents */
  balance: number;
  /** Callback function called when cashout is successful */
  onSuccess: () => void;
}

/**
 * Renders a form for cashing out from the Venmo wallet to a linked bank account.
 * Users can choose between standard (free) and instant (with fee) transfers.
 */
export function CashoutForm({ balance, onSuccess }: CashoutFormProps) {
  const [amount, setAmount] = useState('');
  const [speed, setSpeed] = useState<'standard' | 'instant'>('standard');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Handles the cashout submission.
   * Validates the amount against available balance and processes the transfer.
   */
  const handleCashout = async () => {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    if (amountNum * 100 > balance) {
      setError('Insufficient balance');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await api.cashout({ amount: amountNum, speed });
      onSuccess();
      setAmount('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cashout failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-4 p-4 bg-gray-50 rounded-lg">
      <h4 className="font-medium mb-3">Cash Out</h4>
      <div className="space-y-3">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
            $
          </span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max={(balance / 100).toFixed(2)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-venmo-blue"
          />
        </div>

        <CashoutSpeedSelector speed={speed} onSpeedChange={setSpeed} />

        <Button onClick={handleCashout} loading={loading} className="w-full">
          Cash Out {amount ? formatCurrency(parseFloat(amount) * 100) : ''}
        </Button>
      </div>
      {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
    </div>
  );
}

/**
 * Props for the CashoutSpeedSelector component.
 */
interface CashoutSpeedSelectorProps {
  /** Currently selected speed option */
  speed: 'standard' | 'instant';
  /** Callback when speed option changes */
  onSpeedChange: (speed: 'standard' | 'instant') => void;
}

/**
 * Renders speed selection buttons for cashout (standard vs instant).
 */
function CashoutSpeedSelector({ speed, onSpeedChange }: CashoutSpeedSelectorProps) {
  return (
    <div className="flex gap-2">
      <button
        onClick={() => onSpeedChange('standard')}
        className={`flex-1 p-3 rounded-lg border text-left ${
          speed === 'standard' ? 'border-venmo-blue bg-blue-50' : 'border-gray-200'
        }`}
      >
        <p className="font-medium">Standard</p>
        <p className="text-sm text-gray-500">1-3 business days</p>
        <p className="text-sm text-green-600">Free</p>
      </button>
      <button
        onClick={() => onSpeedChange('instant')}
        className={`flex-1 p-3 rounded-lg border text-left ${
          speed === 'instant' ? 'border-venmo-blue bg-blue-50' : 'border-gray-200'
        }`}
      >
        <p className="font-medium">Instant</p>
        <p className="text-sm text-gray-500">In minutes</p>
        <p className="text-sm text-gray-600">1.5% fee (max $15)</p>
      </button>
    </div>
  );
}
