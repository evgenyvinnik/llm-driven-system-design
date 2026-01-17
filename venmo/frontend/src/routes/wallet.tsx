/**
 * Wallet page component for managing Venmo balance and payment methods.
 * Provides tabbed interface for overview, transaction history, and payment methods.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useWalletStore, useAuthStore } from '../stores';
import { formatCurrency } from '../utils';
import {
  WalletOverview,
  TransactionHistory,
  PaymentMethodsTab,
} from '../components/wallet';

/** Tab options for the wallet page */
type WalletTab = 'overview' | 'history' | 'methods';

/**
 * Main wallet page component.
 * Displays balance card and tabbed navigation between overview, history, and payment methods.
 */
function WalletPage() {
  const [activeTab, setActiveTab] = useState<WalletTab>('overview');
  const { balance, paymentMethods, isLoading, loadWallet } = useWalletStore();
  const { checkAuth } = useAuthStore();

  /**
   * Load wallet data on component mount.
   */
  useEffect(() => {
    loadWallet();
  }, [loadWallet]);

  /**
   * Handles refresh of both wallet and auth data.
   */
  const handleUpdate = () => {
    loadWallet();
    checkAuth();
  };

  return (
    <div className="max-w-md mx-auto">
      <WalletBalanceCard balance={balance} isLoading={isLoading} />

      <WalletTabNavigation activeTab={activeTab} onTabChange={setActiveTab} />

      <WalletTabContent
        activeTab={activeTab}
        balance={balance}
        paymentMethods={paymentMethods}
        onUpdate={handleUpdate}
        onMethodsUpdate={loadWallet}
      />
    </div>
  );
}

/**
 * Props for the WalletBalanceCard component.
 */
interface WalletBalanceCardProps {
  /** Current balance in cents */
  balance: number;
  /** Whether balance is currently loading */
  isLoading: boolean;
}

/**
 * Displays the current Venmo balance in a styled card.
 */
function WalletBalanceCard({ balance, isLoading }: WalletBalanceCardProps) {
  return (
    <div className="bg-venmo-blue text-white rounded-lg p-6 mb-6">
      <p className="text-sm opacity-80">Venmo Balance</p>
      <p className="text-3xl font-bold mt-1">
        {isLoading ? '...' : formatCurrency(balance)}
      </p>
    </div>
  );
}

/**
 * Props for the WalletTabNavigation component.
 */
interface WalletTabNavigationProps {
  /** Currently active tab */
  activeTab: WalletTab;
  /** Callback when tab changes */
  onTabChange: (tab: WalletTab) => void;
}

/** Tab configuration for display labels */
const tabLabels: Record<WalletTab, string> = {
  overview: 'Overview',
  history: 'History',
  methods: 'Payment Methods',
};

/**
 * Renders the tab navigation buttons.
 */
function WalletTabNavigation({ activeTab, onTabChange }: WalletTabNavigationProps) {
  const tabs: WalletTab[] = ['overview', 'history', 'methods'];

  return (
    <div className="flex gap-2 mb-6 overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
          className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
            activeTab === tab
              ? 'bg-venmo-blue text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {tabLabels[tab]}
        </button>
      ))}
    </div>
  );
}

/**
 * Props for the WalletTabContent component.
 */
interface WalletTabContentProps {
  /** Currently active tab */
  activeTab: WalletTab;
  /** Current balance in cents */
  balance: number;
  /** List of linked payment methods */
  paymentMethods: import('../types').PaymentMethod[];
  /** Callback for overview updates (refreshes wallet + auth) */
  onUpdate: () => void;
  /** Callback for payment methods updates (refreshes wallet only) */
  onMethodsUpdate: () => void;
}

/**
 * Renders the content for the currently active tab.
 */
function WalletTabContent({
  activeTab,
  balance,
  paymentMethods,
  onUpdate,
  onMethodsUpdate,
}: WalletTabContentProps) {
  switch (activeTab) {
    case 'overview':
      return (
        <WalletOverview
          balance={balance}
          paymentMethods={paymentMethods}
          onUpdate={onUpdate}
        />
      );
    case 'history':
      return <TransactionHistory />;
    case 'methods':
      return <PaymentMethodsTab methods={paymentMethods} onUpdate={onMethodsUpdate} />;
    default:
      return null;
  }
}

export const Route = createFileRoute('/wallet')({
  component: WalletPage,
});
