import { useState } from 'react';
import type { Wallet } from '../types';
import { formatCents } from '../utils/money';
import { WalletActionModal } from './WalletActionModal';

interface WalletCardProps {
  wallet: Wallet | null;
  loading: boolean;
  onRefresh: () => void;
}

/** Displays the PayPal wallet balance with add-money and withdraw actions. */
export function WalletCard({ wallet, loading, onRefresh }: WalletCardProps) {
  const [mode, setMode] = useState<'deposit' | 'withdraw' | null>(null);

  return (
    <div className="bg-gradient-to-r from-paypal-sidebar to-paypal-primary rounded-xl shadow-lg p-6 text-white">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-white/80">PayPal Balance</span>
        <button
          onClick={onRefresh}
          className="text-xs text-white/60 hover:text-white/90 transition-colors"
        >
          Refresh
        </button>
      </div>
      <div className="text-3xl font-bold mb-4">
        {loading ? (
          <span className="animate-pulse">---.--</span>
        ) : (
          formatCents(wallet?.balanceCents ?? 0)
        )}
      </div>
      <div className="flex items-center justify-between">
        <div className="text-sm text-white/70">
          {wallet?.currency || 'USD'} available
        </div>
        <div className="flex space-x-2">
          <button
            onClick={() => setMode('deposit')}
            className="px-4 py-1.5 bg-white text-paypal-sidebar rounded-full text-sm font-medium hover:bg-white/90"
          >
            Add money
          </button>
          <button
            onClick={() => setMode('withdraw')}
            className="px-4 py-1.5 bg-white/15 text-white rounded-full text-sm font-medium hover:bg-white/25"
          >
            Withdraw
          </button>
        </div>
      </div>

      {mode && (
        <div className="text-paypal-text">
          <WalletActionModal
            mode={mode}
            onClose={() => setMode(null)}
            onDone={() => {
              setMode(null);
              onRefresh();
            }}
          />
        </div>
      )}
    </div>
  );
}
