# Design Venmo - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thank you for having me. Today I'll design Venmo, a peer-to-peer payment platform with social features. From a frontend perspective, the key challenges are:

1. **Payment Flow UX**: Building trust through clear feedback during money transfers
2. **Social Feed**: Rendering transaction feeds with virtualization for performance
3. **Real-time Updates**: Instant notifications when receiving payments or requests
4. **Mobile-First Design**: Touch-friendly interactions for the primary use case

I'll focus on the component architecture, state management, and the user experience patterns that make a payment app feel trustworthy and responsive."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our frontend:

1. **Send Money**: Step-by-step payment flow with recipient search and confirmation
2. **Request Money**: Create payment requests with user search and notes
3. **Social Feed**: Scrollable transaction feed with likes, comments, and privacy indicators
4. **Wallet Management**: View balance, transaction history, linked accounts
5. **Notifications**: Real-time updates for incoming payments and requests

I'll focus on the payment flow and feed components since those are the core interactions."

### Non-Functional Requirements

"Key UX constraints:

- **Perceived Speed**: Payment confirmation feels instant (optimistic updates)
- **Trust Signals**: Clear feedback at every step - users need confidence money went to the right person
- **Accessibility**: Full keyboard and screen reader support for financial operations
- **Offline Resilience**: Graceful handling of network issues during transfers

The trust factor is paramount. Users are sending real money - every interaction must feel deliberate and confirmed."

---

## Component Architecture (10 minutes)

### Directory Structure

```
frontend/src/
├── components/
│   ├── icons/                 # SVG icon components
│   │   ├── index.ts
│   │   ├── ArrowIcon.tsx      # Transaction direction arrows
│   │   ├── BankIcon.tsx
│   │   ├── CardIcon.tsx
│   │   └── SpinnerIcon.tsx
│   ├── wallet/                # Wallet feature components
│   │   ├── index.ts
│   │   ├── WalletOverview.tsx
│   │   ├── TransactionHistory.tsx
│   │   ├── PaymentMethodsTab.tsx
│   │   ├── DepositForm.tsx
│   │   └── CashoutForm.tsx
│   ├── request/               # Payment request components
│   │   ├── index.ts
│   │   ├── CreateRequestForm.tsx
│   │   ├── ReceivedRequests.tsx
│   │   ├── RequestCard.tsx
│   │   └── UserSearchDropdown.tsx
│   ├── feed/                  # Social feed components
│   │   ├── index.ts
│   │   ├── TransactionFeed.tsx
│   │   ├── TransactionCard.tsx
│   │   ├── LikeButton.tsx
│   │   └── CommentSection.tsx
│   ├── pay/                   # Payment flow components
│   │   ├── index.ts
│   │   ├── PaymentFlow.tsx
│   │   ├── RecipientSearch.tsx
│   │   ├── AmountInput.tsx
│   │   ├── NoteInput.tsx
│   │   └── ConfirmationScreen.tsx
│   └── common/
│       ├── Avatar.tsx
│       ├── Button.tsx
│       ├── Input.tsx
│       └── LoadingSpinner.tsx
├── routes/
│   ├── __root.tsx
│   ├── index.tsx              # Feed page
│   ├── pay.tsx                # Send payment
│   ├── request.tsx            # Request money
│   └── wallet.tsx             # Wallet management
├── stores/
│   └── index.ts               # Zustand stores
├── services/
│   └── api.ts                 # API client
└── types/
    └── index.ts               # TypeScript definitions
```

### Core Type Definitions

```typescript
// types/index.ts
export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Wallet {
  balance: number;  // In cents
  pendingBalance: number;
}

export interface Transfer {
  id: string;
  sender: User;
  receiver: User;
  amount: number;  // In cents
  note: string;
  visibility: 'public' | 'friends' | 'private';
  createdAt: string;
  likeCount: number;
  commentCount: number;
  isLikedByMe: boolean;
}

export interface PaymentRequest {
  id: string;
  requester: User;
  requestee: User;
  amount: number;
  note: string;
  status: 'pending' | 'paid' | 'declined' | 'cancelled';
  createdAt: string;
}

export interface PaymentMethod {
  id: string;
  type: 'bank' | 'card' | 'debit_card';
  last4: string;
  bankName: string;
  isDefault: boolean;
  verified: boolean;
}
```

---

## Deep Dive: Payment Flow UX (10 minutes)

### Multi-Step Payment Flow

"The payment flow is the core trust-building experience. I use a step-by-step wizard pattern with clear confirmation."

```tsx
// components/pay/PaymentFlow.tsx
import { useState, useCallback } from 'react';
import { RecipientSearch } from './RecipientSearch';
import { AmountInput } from './AmountInput';
import { NoteInput } from './NoteInput';
import { ConfirmationScreen } from './ConfirmationScreen';
import { useWalletStore } from '../../stores';

type PaymentStep = 'recipient' | 'amount' | 'note' | 'confirm' | 'success';

interface PaymentState {
  recipient: User | null;
  amount: number;
  note: string;
  visibility: 'public' | 'friends' | 'private';
}

export function PaymentFlow() {
  const [step, setStep] = useState<PaymentStep>('recipient');
  const [payment, setPayment] = useState<PaymentState>({
    recipient: null,
    amount: 0,
    note: '',
    visibility: 'public'
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { balance, refreshBalance } = useWalletStore();

  const handleRecipientSelect = useCallback((user: User) => {
    setPayment(prev => ({ ...prev, recipient: user }));
    setStep('amount');
  }, []);

  const handleAmountConfirm = useCallback((amount: number) => {
    setPayment(prev => ({ ...prev, amount }));
    setStep('note');
  }, []);

  const handleNoteConfirm = useCallback((note: string, visibility: string) => {
    setPayment(prev => ({ ...prev, note, visibility }));
    setStep('confirm');
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!payment.recipient) return;

    setIsSubmitting(true);
    setError(null);

    // Generate idempotency key on button click (not on page load)
    const idempotencyKey = crypto.randomUUID();

    try {
      await api.createTransfer({
        receiverId: payment.recipient.id,
        amount: payment.amount,
        note: payment.note,
        visibility: payment.visibility,
        idempotencyKey
      });

      // Optimistic balance update
      await refreshBalance();
      setStep('success');
    } catch (err) {
      setError(err.message || 'Payment failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [payment, refreshBalance]);

  // Render current step
  return (
    <div className="min-h-screen bg-white">
      <PaymentProgress currentStep={step} />

      {step === 'recipient' && (
        <RecipientSearch onSelect={handleRecipientSelect} />
      )}

      {step === 'amount' && (
        <AmountInput
          recipient={payment.recipient!}
          maxAmount={balance}
          onConfirm={handleAmountConfirm}
          onBack={() => setStep('recipient')}
        />
      )}

      {step === 'note' && (
        <NoteInput
          onConfirm={handleNoteConfirm}
          onBack={() => setStep('amount')}
        />
      )}

      {step === 'confirm' && (
        <ConfirmationScreen
          payment={payment}
          isSubmitting={isSubmitting}
          error={error}
          onConfirm={handleConfirm}
          onBack={() => setStep('note')}
        />
      )}

      {step === 'success' && (
        <SuccessScreen
          payment={payment}
          onSendAnother={() => {
            setPayment({ recipient: null, amount: 0, note: '', visibility: 'public' });
            setStep('recipient');
          }}
          onDone={() => navigate('/')}
        />
      )}
    </div>
  );
}
```

### Confirmation Screen with Trust Signals

```tsx
// components/pay/ConfirmationScreen.tsx
interface ConfirmationScreenProps {
  payment: PaymentState;
  isSubmitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onBack: () => void;
}

export function ConfirmationScreen({
  payment,
  isSubmitting,
  error,
  onConfirm,
  onBack
}: ConfirmationScreenProps) {
  return (
    <div className="flex flex-col items-center p-6">
      {/* Recipient confirmation - prominent display */}
      <div className="text-center mb-8">
        <Avatar
          src={payment.recipient.avatarUrl}
          name={payment.recipient.displayName}
          size="xl"
          className="mb-4"
        />
        <h2 className="text-2xl font-bold text-gray-900">
          {payment.recipient.displayName}
        </h2>
        <p className="text-gray-500">@{payment.recipient.username}</p>
      </div>

      {/* Amount - large, clear display */}
      <div className="text-5xl font-bold text-venmo-blue mb-4">
        {formatCurrency(payment.amount)}
      </div>

      {/* Note preview */}
      {payment.note && (
        <p className="text-gray-600 text-center mb-6 max-w-xs">
          "{payment.note}"
        </p>
      )}

      {/* Visibility indicator */}
      <div className="flex items-center gap-2 text-gray-500 mb-8">
        <VisibilityIcon type={payment.visibility} />
        <span className="text-sm capitalize">{payment.visibility}</span>
      </div>

      {/* Error display */}
      {error && (
        <div
          role="alert"
          className="w-full bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4"
        >
          {error}
        </div>
      )}

      {/* Action buttons */}
      <div className="w-full space-y-3">
        <Button
          onClick={onConfirm}
          disabled={isSubmitting}
          variant="primary"
          size="lg"
          className="w-full"
          aria-busy={isSubmitting}
        >
          {isSubmitting ? (
            <span className="flex items-center justify-center gap-2">
              <SpinnerIcon className="w-5 h-5 animate-spin" />
              Sending...
            </span>
          ) : (
            `Pay ${formatCurrency(payment.amount)}`
          )}
        </Button>

        <Button
          onClick={onBack}
          disabled={isSubmitting}
          variant="ghost"
          size="lg"
          className="w-full"
        >
          Go Back
        </Button>
      </div>
    </div>
  );
}
```

### Amount Input with Currency Formatting

```tsx
// components/pay/AmountInput.tsx
import { useState, useRef, useEffect } from 'react';

interface AmountInputProps {
  recipient: User;
  maxAmount: number;
  onConfirm: (amount: number) => void;
  onBack: () => void;
}

export function AmountInput({ recipient, maxAmount, onConfirm, onBack }: AmountInputProps) {
  const [displayValue, setDisplayValue] = useState('');
  const [cents, setCents] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Strip non-numeric characters
    const numericValue = e.target.value.replace(/[^0-9]/g, '');

    if (numericValue === '') {
      setDisplayValue('');
      setCents(0);
      return;
    }

    // Convert to cents, then format as dollars
    const newCents = parseInt(numericValue, 10);
    const dollars = newCents / 100;

    // Format with up to 2 decimal places
    setDisplayValue(dollars.toFixed(2).replace(/^0+/, '') || '0');
    setCents(newCents);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (cents > 0 && cents <= maxAmount) {
      onConfirm(cents);
    }
  };

  const insufficientFunds = cents > maxAmount;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col items-center p-6">
      <p className="text-gray-600 mb-2">Paying {recipient.displayName}</p>

      <div className="flex items-baseline justify-center mb-4">
        <span className="text-4xl text-gray-400">$</span>
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={displayValue}
          onChange={handleChange}
          placeholder="0"
          className="text-6xl font-bold text-center w-48 outline-none bg-transparent"
          aria-label="Payment amount in dollars"
        />
      </div>

      {insufficientFunds && (
        <p className="text-red-500 text-sm mb-4" role="alert">
          Exceeds your balance of {formatCurrency(maxAmount)}
        </p>
      )}

      <p className="text-gray-500 text-sm mb-8">
        Balance: {formatCurrency(maxAmount)}
      </p>

      <div className="w-full space-y-3">
        <Button
          type="submit"
          disabled={cents === 0 || insufficientFunds}
          variant="primary"
          size="lg"
          className="w-full"
        >
          Next
        </Button>
        <Button
          type="button"
          onClick={onBack}
          variant="ghost"
          size="lg"
          className="w-full"
        >
          Back
        </Button>
      </div>
    </form>
  );
}
```

---

## Deep Dive: Social Feed with Virtualization (8 minutes)

### Virtualized Feed Component

"The feed can have thousands of transactions. We use virtualization to only render visible items."

```tsx
// components/feed/TransactionFeed.tsx
import { useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { TransactionCard } from './TransactionCard';
import { useFeedStore } from '../../stores';

export function TransactionFeed() {
  const parentRef = useRef<HTMLDivElement>(null);
  const { transactions, hasMore, loadMore, isLoading } = useFeedStore();

  const virtualizer = useVirtualizer({
    count: hasMore ? transactions.length + 1 : transactions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180,  // Estimated card height
    overscan: 5,
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  // Infinite scroll trigger
  const handleScroll = useCallback(() => {
    if (!parentRef.current || isLoading || !hasMore) return;

    const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
    if (scrollHeight - scrollTop - clientHeight < 500) {
      loadMore();
    }
  }, [isLoading, hasMore, loadMore]);

  return (
    <div
      ref={parentRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto"
      role="feed"
      aria-busy={isLoading}
      aria-label="Transaction feed"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const isLoaderRow = virtualItem.index >= transactions.length;

          return (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {isLoaderRow ? (
                <LoadingIndicator />
              ) : (
                <TransactionCard
                  transaction={transactions[virtualItem.index]}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### Transaction Card Component

```tsx
// components/feed/TransactionCard.tsx
import { useState, memo } from 'react';
import { Avatar } from '../common/Avatar';
import { LikeButton } from './LikeButton';
import { CommentSection } from './CommentSection';
import { formatCurrency, formatRelativeTime } from '../../utils';

interface TransactionCardProps {
  transaction: Transfer;
}

export const TransactionCard = memo(function TransactionCard({
  transaction
}: TransactionCardProps) {
  const [showComments, setShowComments] = useState(false);

  const { sender, receiver, amount, note, createdAt, visibility } = transaction;

  return (
    <article
      className="bg-white border-b border-gray-100 p-4"
      aria-label={`${sender.displayName} paid ${receiver.displayName} ${formatCurrency(amount)}`}
    >
      {/* Header with avatars */}
      <div className="flex items-start gap-3">
        <div className="flex -space-x-2">
          <Avatar
            src={sender.avatarUrl}
            name={sender.displayName}
            size="md"
            className="ring-2 ring-white"
          />
          <Avatar
            src={receiver.avatarUrl}
            name={receiver.displayName}
            size="md"
            className="ring-2 ring-white"
          />
        </div>

        <div className="flex-1 min-w-0">
          {/* Transaction description */}
          <p className="text-sm">
            <span className="font-semibold">{sender.displayName}</span>
            <span className="text-gray-500"> paid </span>
            <span className="font-semibold">{receiver.displayName}</span>
          </p>

          {/* Timestamp and visibility */}
          <div className="flex items-center gap-2 text-xs text-gray-500 mt-1">
            <time dateTime={createdAt}>
              {formatRelativeTime(createdAt)}
            </time>
            <VisibilityBadge type={visibility} />
          </div>
        </div>
      </div>

      {/* Note */}
      {note && (
        <p className="mt-3 text-gray-800">{note}</p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-50">
        <LikeButton
          transactionId={transaction.id}
          likeCount={transaction.likeCount}
          isLiked={transaction.isLikedByMe}
        />

        <button
          onClick={() => setShowComments(!showComments)}
          className="flex items-center gap-1 text-gray-500 hover:text-gray-700"
          aria-expanded={showComments}
        >
          <CommentIcon className="w-5 h-5" />
          <span className="text-sm">{transaction.commentCount}</span>
        </button>
      </div>

      {/* Comments section */}
      {showComments && (
        <CommentSection transactionId={transaction.id} />
      )}
    </article>
  );
});
```

---

## Deep Dive: State Management with Zustand (5 minutes)

### Store Architecture

```typescript
// stores/index.ts
import { create } from 'zustand';
import { api } from '../services/api';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,

  login: async (username, password) => {
    const response = await api.login({ username, password });
    set({ user: response.user, isAuthenticated: true });
  },

  logout: async () => {
    await api.logout();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    try {
      const user = await api.getCurrentUser();
      set({ user, isAuthenticated: true });
    } catch {
      set({ user: null, isAuthenticated: false });
    }
  },
}));

interface WalletState {
  balance: number;
  pendingBalance: number;
  paymentMethods: PaymentMethod[];
  transactions: Transfer[];
  isLoading: boolean;

  fetchWallet: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  fetchTransactionHistory: (cursor?: string) => Promise<void>;
}

export const useWalletStore = create<WalletState>((set, get) => ({
  balance: 0,
  pendingBalance: 0,
  paymentMethods: [],
  transactions: [],
  isLoading: false,

  fetchWallet: async () => {
    set({ isLoading: true });
    try {
      const [wallet, methods] = await Promise.all([
        api.getWallet(),
        api.getPaymentMethods()
      ]);
      set({
        balance: wallet.balance,
        pendingBalance: wallet.pendingBalance,
        paymentMethods: methods
      });
    } finally {
      set({ isLoading: false });
    }
  },

  refreshBalance: async () => {
    const wallet = await api.getWallet();
    set({ balance: wallet.balance, pendingBalance: wallet.pendingBalance });
  },

  fetchTransactionHistory: async (cursor) => {
    const response = await api.getTransactionHistory(cursor);
    set(state => ({
      transactions: cursor
        ? [...state.transactions, ...response.items]
        : response.items
    }));
  },
}));

interface FeedState {
  transactions: Transfer[];
  hasMore: boolean;
  isLoading: boolean;
  cursor: string | null;

  fetchFeed: () => Promise<void>;
  loadMore: () => Promise<void>;
  likeTransaction: (id: string) => Promise<void>;
  unlikeTransaction: (id: string) => Promise<void>;
}

export const useFeedStore = create<FeedState>((set, get) => ({
  transactions: [],
  hasMore: true,
  isLoading: false,
  cursor: null,

  fetchFeed: async () => {
    set({ isLoading: true });
    try {
      const response = await api.getFeed();
      set({
        transactions: response.items,
        cursor: response.nextCursor,
        hasMore: !!response.nextCursor
      });
    } finally {
      set({ isLoading: false });
    }
  },

  loadMore: async () => {
    const { cursor, isLoading, hasMore } = get();
    if (isLoading || !hasMore || !cursor) return;

    set({ isLoading: true });
    try {
      const response = await api.getFeed(cursor);
      set(state => ({
        transactions: [...state.transactions, ...response.items],
        cursor: response.nextCursor,
        hasMore: !!response.nextCursor
      }));
    } finally {
      set({ isLoading: false });
    }
  },

  likeTransaction: async (id) => {
    // Optimistic update
    set(state => ({
      transactions: state.transactions.map(t =>
        t.id === id
          ? { ...t, isLikedByMe: true, likeCount: t.likeCount + 1 }
          : t
      )
    }));

    try {
      await api.likeTransaction(id);
    } catch {
      // Rollback on failure
      set(state => ({
        transactions: state.transactions.map(t =>
          t.id === id
            ? { ...t, isLikedByMe: false, likeCount: t.likeCount - 1 }
            : t
        )
      }));
    }
  },

  unlikeTransaction: async (id) => {
    // Optimistic update
    set(state => ({
      transactions: state.transactions.map(t =>
        t.id === id
          ? { ...t, isLikedByMe: false, likeCount: t.likeCount - 1 }
          : t
      )
    }));

    try {
      await api.unlikeTransaction(id);
    } catch {
      // Rollback on failure
      set(state => ({
        transactions: state.transactions.map(t =>
          t.id === id
            ? { ...t, isLikedByMe: true, likeCount: t.likeCount + 1 }
            : t
        )
      }));
    }
  },
}));
```

---

## Deep Dive: Accessibility (5 minutes)

### ARIA Patterns for Payment Flows

```tsx
// Accessible payment form with live regions
function PaymentForm() {
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  return (
    <div>
      {/* Progress indicator for screen readers */}
      <div
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={1}
        aria-valuemax={4}
        aria-label={`Payment step ${step} of 4`}
      >
        <VisualProgressBar step={step} />
      </div>

      {/* Live region for status updates */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {error && `Error: ${error}`}
        {success && 'Payment sent successfully'}
      </div>

      {/* Error display (visible) */}
      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg"
        >
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Form content */}
      <form
        onSubmit={handleSubmit}
        aria-describedby={error ? 'error-message' : undefined}
      >
        {/* Form fields... */}
      </form>
    </div>
  );
}

// Skip link for keyboard navigation
function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:bg-white focus:px-4 focus:py-2 focus:rounded"
    >
      Skip to main content
    </a>
  );
}

// Focus management after payment
function SuccessScreen({ onDone }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Move focus to success heading for screen reader announcement
    headingRef.current?.focus();
  }, []);

  return (
    <div className="text-center p-6">
      <CheckmarkAnimation aria-hidden="true" />
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-2xl font-bold text-green-600 mt-4 outline-none"
      >
        Payment Sent!
      </h1>
      <p className="text-gray-600 mt-2">
        Your payment was sent successfully.
      </p>
      <Button onClick={onDone} className="mt-6">
        Done
      </Button>
    </div>
  );
}
```

### Keyboard Navigation Patterns

```tsx
// User search with keyboard navigation
function UserSearchDropdown({ onSelect }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex(prev => Math.min(prev + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && results[activeIndex]) {
          onSelect(results[activeIndex]);
        }
        break;
      case 'Escape':
        setResults([]);
        setActiveIndex(-1);
        break;
    }
  };

  return (
    <div className="relative">
      <label htmlFor="recipient-search" className="sr-only">
        Search for a recipient
      </label>
      <input
        ref={inputRef}
        id="recipient-search"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Name, @username, email, or phone"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-autocomplete="list"
        aria-controls="recipient-listbox"
        aria-activedescendant={
          activeIndex >= 0 ? `recipient-${results[activeIndex]?.id}` : undefined
        }
        className="w-full px-4 py-3 border rounded-lg"
      />

      {results.length > 0 && (
        <ul
          id="recipient-listbox"
          role="listbox"
          className="absolute w-full mt-1 bg-white border rounded-lg shadow-lg max-h-60 overflow-y-auto"
        >
          {results.map((user, index) => (
            <li
              key={user.id}
              id={`recipient-${user.id}`}
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => onSelect(user)}
              className={`flex items-center gap-3 p-3 cursor-pointer ${
                index === activeIndex ? 'bg-venmo-blue/10' : 'hover:bg-gray-50'
              }`}
            >
              <Avatar src={user.avatarUrl} name={user.displayName} size="sm" />
              <div>
                <div className="font-medium">{user.displayName}</div>
                <div className="text-sm text-gray-500">@{user.username}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State management | Zustand | Redux, Context | Simpler API, less boilerplate, good performance |
| Feed rendering | TanStack Virtual | react-window | Built-in dynamic heights, modern API |
| Routing | TanStack Router | React Router | Type-safe routes, better DX |
| Styling | Tailwind CSS | CSS Modules, styled-components | Rapid development, consistent design |
| Payment flow | Multi-step wizard | Single page form | Clearer confirmation, fewer mistakes |
| Amount input | Cents-based | Decimal input | Avoids floating point errors |

---

## Performance Optimizations (2 minutes)

```tsx
// 1. Memoized components to prevent re-renders
const TransactionCard = memo(function TransactionCard({ transaction }) {
  // Component implementation
});

// 2. Code splitting for routes
const WalletPage = lazy(() => import('./routes/wallet'));
const PayPage = lazy(() => import('./routes/pay'));

// 3. Debounced search
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// 4. Optimistic updates for instant feedback
const likeTransaction = async (id) => {
  // Update UI immediately
  set(state => updateLike(state, id, true));

  try {
    await api.like(id);
  } catch {
    // Rollback on failure
    set(state => updateLike(state, id, false));
  }
};
```

---

## Summary

"To summarize the frontend design:

1. **Multi-Step Payment Flow**: Wizard pattern with clear confirmation screens builds trust for financial transactions

2. **Virtualized Feed**: TanStack Virtual renders only visible transactions for smooth scrolling with thousands of items

3. **Zustand State Management**: Centralized stores for wallet, feed, and auth with optimistic updates for perceived speed

4. **Trust-Building UX**: Large recipient display, explicit confirmation, loading states, and clear error messages

5. **Accessibility First**: ARIA patterns for screen readers, keyboard navigation, focus management after actions

6. **Currency Handling**: Cents-based amounts to avoid floating point errors, formatted for display

The design prioritizes user trust and confidence while delivering the fast, social experience Venmo is known for.

What would you like me to elaborate on?"
