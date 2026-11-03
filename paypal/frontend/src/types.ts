export interface User {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  role: string;
}

export interface Wallet {
  id: string;
  userId: string;
  balanceCents: number;
  currency: string;
  version: number;
}

export interface Transaction {
  id: string;
  senderId: string | null;
  recipientId: string;
  amountCents: number;
  currency: string;
  type: 'transfer' | 'deposit' | 'withdrawal';
  status: string;
  note: string | null;
  paymentMethodId?: string | null;
  createdAt: string;
  senderUsername?: string;
  senderDisplayName?: string;
  recipientUsername?: string;
  recipientDisplayName?: string;
}

export interface LedgerEntry {
  id: string;
  transactionId: string;
  walletId: string;
  entryType: 'debit' | 'credit';
  amountCents: number;
  balanceAfterCents: number;
  createdAt: string;
}

export interface TransferRequest {
  id: string;
  requesterId: string;
  payerId: string;
  amountCents: number;
  currency: string;
  note: string | null;
  status: 'pending' | 'paid' | 'declined' | 'cancelled';
  /** The transfer that settled the request, once paid. */
  transactionId: string | null;
  createdAt: string;
  updatedAt: string;
  requesterUsername?: string;
  requesterDisplayName?: string;
  payerUsername?: string;
  payerDisplayName?: string;
}

export interface PaymentMethod {
  id: string;
  type: 'bank' | 'card';
  label: string;
  lastFour: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface ReconciliationWallet {
  walletId: string;
  username: string;
  displayName: string | null;
  accountType: 'customer' | 'platform_cash';
  balanceCents: number;
  ledgerBalanceCents: number;
  driftCents: number;
  entries: number;
}

export interface ReconciliationReport {
  balanced: boolean;
  summary: {
    totalDebitsCents: number;
    totalCreditsCents: number;
    customerTotalCents: number;
    platformCashCents: number;
    walletsWithDrift: number;
    unbalancedTransactions: number;
    transactionsWithoutEntries: number;
  };
  wallets: ReconciliationWallet[];
}
