/**
 * WalletOverview component displaying quick actions and recent cashouts.
 * This is the main view shown on the Wallet Overview tab.
 */

import { useState, useEffect } from 'react';
import { api } from '../../services/api';
import { Button } from '../Button';
import { DepositForm } from './DepositForm';
import { CashoutForm } from './CashoutForm';
import { RecentCashouts } from './RecentCashouts';
import type { PaymentMethod, Cashout } from '../../types';

/**
 * Props for the WalletOverview component.
 */
interface WalletOverviewProps {
  /** Current wallet balance in cents */
  balance: number;
  /** List of linked payment methods */
  paymentMethods: PaymentMethod[];
  /** Callback to refresh wallet data */
  onUpdate: () => void;
}

/**
 * Renders the wallet overview section with quick actions (Add Money, Cash Out)
 * and a list of recent cashout transactions.
 */
export function WalletOverview({
  balance,
  paymentMethods,
  onUpdate,
}: WalletOverviewProps) {
  const [showDeposit, setShowDeposit] = useState(false);
  const [showCashout, setShowCashout] = useState(false);
  const [cashouts, setCashouts] = useState<Cashout[]>([]);

  /**
   * Load recent cashouts on component mount.
   */
  useEffect(() => {
    api.getCashouts().then(setCashouts).catch(() => {});
  }, []);

  /**
   * Handles successful deposit - closes form and refreshes data.
   */
  const handleDepositSuccess = () => {
    onUpdate();
    setShowDeposit(false);
  };

  /**
   * Handles successful cashout - closes form and refreshes data.
   */
  const handleCashoutSuccess = () => {
    onUpdate();
    setShowCashout(false);
    api.getCashouts().then(setCashouts).catch(() => {});
  };

  const hasBankAccount = paymentMethods.some((m) => m.type === 'bank');

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow-sm p-4">
        <h3 className="font-medium mb-4">Quick Actions</h3>
        <QuickActionButtons
          hasBankAccount={hasBankAccount}
          balance={balance}
          showDeposit={showDeposit}
          showCashout={showCashout}
          onToggleDeposit={() => {
            setShowDeposit(true);
            setShowCashout(false);
          }}
          onToggleCashout={() => {
            setShowCashout(true);
            setShowDeposit(false);
          }}
        />

        {showDeposit && <DepositForm onSuccess={handleDepositSuccess} />}

        {showCashout && (
          <CashoutForm balance={balance} onSuccess={handleCashoutSuccess} />
        )}
      </div>

      <RecentCashouts cashouts={cashouts} />
    </div>
  );
}

/**
 * Props for the QuickActionButtons component.
 */
interface QuickActionButtonsProps {
  /** Whether user has a linked bank account */
  hasBankAccount: boolean;
  /** Current balance in cents */
  balance: number;
  /** Whether deposit form is shown */
  showDeposit: boolean;
  /** Whether cashout form is shown */
  showCashout: boolean;
  /** Handler to show deposit form */
  onToggleDeposit: () => void;
  /** Handler to show cashout form */
  onToggleCashout: () => void;
}

/**
 * Renders Add Money and Cash Out buttons.
 */
function QuickActionButtons({
  hasBankAccount,
  balance,
  onToggleDeposit,
  onToggleCashout,
}: QuickActionButtonsProps) {
  return (
    <div className="flex gap-3">
      <Button onClick={onToggleDeposit} variant="secondary" className="flex-1">
        Add Money
      </Button>
      <Button
        onClick={onToggleCashout}
        variant="secondary"
        className="flex-1"
        disabled={!hasBankAccount || balance === 0}
      >
        Cash Out
      </Button>
    </div>
  );
}
