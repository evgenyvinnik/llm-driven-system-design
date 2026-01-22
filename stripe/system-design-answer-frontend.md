# Stripe - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thank you for the opportunity. Today I'll design Stripe's frontend interfaces. As a frontend engineer, I'm particularly interested in the unique challenges of building payment UIs:

1. **Merchant Dashboard** - Real-time payment analytics, API key management, webhook configuration
2. **Payment Elements** - Embeddable, accessible card input components
3. **Trust signals** - Visual security indicators that increase conversion
4. **Error handling** - Clear, actionable feedback for failed payments

Let me clarify the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For Stripe's frontend interfaces:

1. **Merchant Dashboard**: View payments, manage API keys, configure webhooks
2. **Payment Elements**: Embeddable card input for merchant websites
3. **Checkout Pages**: Hosted payment pages for merchants
4. **Developer Portal**: API documentation and testing tools

I'll focus on the Merchant Dashboard and Payment Elements since they represent the most interesting frontend challenges."

### Non-Functional Requirements

"Payment UIs have critical requirements:

- **Accessibility**: WCAG 2.1 AA compliance for all payment forms
- **Performance**: First paint < 1.5s, Time to Interactive < 3s
- **Cross-browser**: Support all modern browsers plus 2 versions back
- **Security**: XSS prevention, CSP headers, secure iframe isolation
- **Mobile**: Responsive design, touch-friendly payment inputs"

---

## High-Level Design (8 minutes)

### Application Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Merchant Dashboard                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│   │  Payments   │  │  Developers │  │   Balance   │  │  Settings   │       │
│   │   Module    │  │    Module   │  │   Module    │  │   Module    │       │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘       │
│          │                │                │                │               │
│   ┌──────▼────────────────▼────────────────▼────────────────▼──────┐       │
│   │                      Shared Components                          │       │
│   │   DataTable │ Chart │ Modal │ Form │ Notification │ Skeleton   │       │
│   └────────────────────────────────────────────────────────────────┘       │
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────┐       │
│   │                         State Layer                             │       │
│   │              Zustand (Global) + React Query (Server)           │       │
│   └────────────────────────────────────────────────────────────────┘       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                          Payment Elements                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                        │
│   │ CardElement │  │ PaymentForm │  │ AddressForm │                        │
│   │  (iframe)   │  │  (React)    │  │  (React)    │                        │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                        │
│          │                │                │                                │
│   ┌──────▼────────────────▼────────────────▼───────┐                       │
│   │            Stripe.js SDK                        │                       │
│   │   - Tokenization - Validation - Styles         │                       │
│   └────────────────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Route Structure

```typescript
// TanStack Router file-based routing
frontend/src/routes/
├── __root.tsx              // Root layout with navigation
├── index.tsx               // Dashboard overview
├── payments/
│   ├── index.tsx           // Payment list with filters
│   └── $paymentId.tsx      // Payment detail view
├── developers/
│   ├── index.tsx           // API keys and webhooks
│   └── webhooks.tsx        // Webhook configuration
├── balance/
│   └── index.tsx           // Balance and payouts
├── settings/
│   ├── index.tsx           // Account settings
│   └── team.tsx            // Team management
└── login.tsx               // Authentication
```

---

## Deep Dive: Merchant Dashboard (12 minutes)

### Payments List with Virtualization

```tsx
// routes/payments/index.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';

interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: 'succeeded' | 'failed' | 'pending' | 'canceled';
  customer_email: string;
  created_at: string;
  payment_method: {
    brand: string;
    last4: string;
  };
}

export function PaymentsPage() {
  const parentRef = useRef<HTMLDivElement>(null);
  const [filters, setFilters] = useState({
    status: 'all',
    dateRange: 'last_7_days'
  });

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage
  } = useInfiniteQuery({
    queryKey: ['payments', filters],
    queryFn: async ({ pageParam = null }) => {
      const params = new URLSearchParams({
        ...filters,
        cursor: pageParam || ''
      });
      const res = await fetch(`/api/v1/payments?${params}`);
      return res.json();
    },
    getNextPageParam: (lastPage) => lastPage.cursor,
    staleTime: 30000 // 30 seconds
  });

  const allPayments = data?.pages.flatMap(page => page.payments) ?? [];

  const virtualizer = useVirtualizer({
    count: hasNextPage ? allPayments.length + 1 : allPayments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64, // Row height
    overscan: 10
  });

  // Fetch more when scrolling near bottom
  const virtualItems = virtualizer.getVirtualItems();
  if (
    virtualItems.length > 0 &&
    virtualItems[virtualItems.length - 1].index >= allPayments.length - 5 &&
    hasNextPage &&
    !isFetchingNextPage
  ) {
    fetchNextPage();
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Payments</h1>
        <PaymentFilters filters={filters} onChange={setFilters} />
      </header>

      {/* Summary cards */}
      <PaymentsSummary dateRange={filters.dateRange} />

      {/* Payment list */}
      <div
        ref={parentRef}
        className="h-[600px] overflow-auto rounded-lg border border-gray-200 bg-white"
      >
        <table className="w-full">
          <thead className="sticky top-0 bg-gray-50 border-b">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Amount
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Customer
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Payment Method
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Date
              </th>
            </tr>
          </thead>
          <tbody
            className="relative"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((virtualItem) => {
              const payment = allPayments[virtualItem.index];

              if (!payment) {
                // Loading skeleton
                return (
                  <tr
                    key={virtualItem.key}
                    className="absolute w-full"
                    style={{
                      transform: `translateY(${virtualItem.start}px)`,
                      height: `${virtualItem.size}px`
                    }}
                  >
                    <td colSpan={5} className="px-6 py-4">
                      <div className="animate-pulse bg-gray-200 h-4 rounded" />
                    </td>
                  </tr>
                );
              }

              return (
                <PaymentRow
                  key={payment.id}
                  payment={payment}
                  style={{
                    transform: `translateY(${virtualItem.start}px)`,
                    height: `${virtualItem.size}px`
                  }}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PaymentRow({ payment, style }: { payment: PaymentIntent; style: React.CSSProperties }) {
  return (
    <tr
      className="absolute w-full hover:bg-gray-50 cursor-pointer border-b"
      style={style}
    >
      <td className="px-6 py-4 whitespace-nowrap">
        <span className="font-medium text-gray-900">
          {formatCurrency(payment.amount, payment.currency)}
        </span>
      </td>
      <td className="px-6 py-4">
        <PaymentStatusBadge status={payment.status} />
      </td>
      <td className="px-6 py-4 text-gray-600">
        {payment.customer_email}
      </td>
      <td className="px-6 py-4">
        <div className="flex items-center gap-2">
          <CardBrandIcon brand={payment.payment_method.brand} />
          <span className="text-gray-600">
            •••• {payment.payment_method.last4}
          </span>
        </div>
      </td>
      <td className="px-6 py-4 text-gray-500">
        {formatRelativeTime(payment.created_at)}
      </td>
    </tr>
  );
}

function PaymentStatusBadge({ status }: { status: string }) {
  const styles = {
    succeeded: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    pending: 'bg-yellow-100 text-yellow-800',
    canceled: 'bg-gray-100 text-gray-800'
  };

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${styles[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
```

### API Key Management

```tsx
// routes/developers/index.tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;        // First 8 chars
  last_used: string;
  created_at: string;
  type: 'publishable' | 'secret';
}

export function DevelopersPage() {
  const [showSecret, setShowSecret] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: keys, isLoading } = useQuery({
    queryKey: ['api-keys'],
    queryFn: async () => {
      const res = await fetch('/api/v1/api-keys');
      return res.json() as Promise<ApiKey[]>;
    }
  });

  const rollKeyMutation = useMutation({
    mutationFn: async (keyId: string) => {
      const res = await fetch(`/api/v1/api-keys/${keyId}/roll`, {
        method: 'POST'
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      // Show the new key (only time it's visible)
      setRevealedKey(data.key);
    }
  });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Developers</h1>
        <p className="text-gray-600 mt-1">
          Manage your API keys and webhook endpoints
        </p>
      </header>

      {/* API Keys Section */}
      <section className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">API Keys</h2>

        <div className="space-y-4">
          {keys?.map((key) => (
            <div
              key={key.id}
              className="flex items-center justify-between p-4 bg-gray-50 rounded-lg"
            >
              <div className="flex items-center gap-4">
                <div className={`
                  px-2 py-1 rounded text-xs font-mono
                  ${key.type === 'secret' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}
                `}>
                  {key.type}
                </div>
                <div>
                  <p className="font-mono text-sm">
                    {showSecret === key.id ? revealedKey : `${key.prefix}••••••••`}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Last used {formatRelativeTime(key.last_used)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {key.type === 'secret' && (
                  <button
                    onClick={() => setShowSecret(showSecret === key.id ? null : key.id)}
                    className="text-sm text-gray-600 hover:text-gray-900"
                  >
                    {showSecret === key.id ? 'Hide' : 'Reveal'}
                  </button>
                )}
                <button
                  onClick={() => {
                    if (confirm('Rolling this key will invalidate the current key immediately.')) {
                      rollKeyMutation.mutate(key.id);
                    }
                  }}
                  className="text-sm text-red-600 hover:text-red-800"
                  disabled={rollKeyMutation.isPending}
                >
                  {rollKeyMutation.isPending ? 'Rolling...' : 'Roll Key'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Security warning */}
        <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex gap-3">
            <WarningIcon className="w-5 h-5 text-yellow-600 flex-shrink-0" />
            <div className="text-sm text-yellow-800">
              <p className="font-medium">Keep your secret key secure</p>
              <p className="mt-1">
                Never expose your secret key in client-side code. Only use the
                publishable key in your frontend.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Webhook Endpoints */}
      <WebhookEndpoints />
    </div>
  );
}
```

### Real-time Balance Display

```tsx
// routes/balance/index.tsx
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

interface BalanceData {
  available: number;
  pending: number;
  currency: string;
  reserved: number;
  next_payout: {
    amount: number;
    arrival_date: string;
  };
}

export function BalancePage() {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data: balance, refetch } = useQuery({
    queryKey: ['balance'],
    queryFn: async () => {
      const res = await fetch('/api/v1/balance');
      return res.json() as Promise<BalanceData>;
    },
    refetchInterval: 60000 // Refresh every minute
  });

  // Real-time updates via SSE
  useEffect(() => {
    const eventSource = new EventSource('/api/v1/balance/stream');

    eventSource.onmessage = () => {
      setIsRefreshing(true);
      refetch().then(() => setIsRefreshing(false));
    };

    return () => eventSource.close();
  }, [refetch]);

  if (!balance) {
    return <BalanceSkeleton />;
  }

  return (
    <div className="space-y-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Balance</h1>
        {isRefreshing && (
          <span className="text-sm text-gray-500 flex items-center gap-2">
            <RefreshIcon className="w-4 h-4 animate-spin" />
            Updating...
          </span>
        )}
      </header>

      {/* Balance cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <BalanceCard
          title="Available"
          amount={balance.available}
          currency={balance.currency}
          description="Ready to pay out"
          variant="primary"
        />
        <BalanceCard
          title="Pending"
          amount={balance.pending}
          currency={balance.currency}
          description="Arriving soon"
          variant="secondary"
        />
        <BalanceCard
          title="Reserved"
          amount={balance.reserved}
          currency={balance.currency}
          description="For disputes"
          variant="muted"
        />
      </div>

      {/* Next payout */}
      {balance.next_payout && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Next Payout</h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-3xl font-semibold text-gray-900">
                {formatCurrency(balance.next_payout.amount, balance.currency)}
              </p>
              <p className="text-gray-600 mt-1">
                Arriving {formatDate(balance.next_payout.arrival_date)}
              </p>
            </div>
            <div className="text-right">
              <PayoutTimeline arrivalDate={balance.next_payout.arrival_date} />
            </div>
          </div>
        </div>
      )}

      {/* Payout history */}
      <PayoutHistory />
    </div>
  );
}

function BalanceCard({
  title,
  amount,
  currency,
  description,
  variant
}: {
  title: string;
  amount: number;
  currency: string;
  description: string;
  variant: 'primary' | 'secondary' | 'muted';
}) {
  const styles = {
    primary: 'bg-indigo-600 text-white',
    secondary: 'bg-white border border-gray-200 text-gray-900',
    muted: 'bg-gray-100 text-gray-900'
  };

  return (
    <div className={`rounded-lg p-6 ${styles[variant]}`}>
      <p className={`text-sm ${variant === 'primary' ? 'text-indigo-200' : 'text-gray-500'}`}>
        {title}
      </p>
      <p className="text-3xl font-semibold mt-2">
        {formatCurrency(amount, currency)}
      </p>
      <p className={`text-sm mt-1 ${variant === 'primary' ? 'text-indigo-200' : 'text-gray-500'}`}>
        {description}
      </p>
    </div>
  );
}
```

---

## Deep Dive: Payment Elements (10 minutes)

### Embeddable Card Element

```tsx
// components/CardElement.tsx
import { useEffect, useRef, useState } from 'react';

interface CardElementProps {
  publishableKey: string;
  onReady?: () => void;
  onChange?: (event: CardChangeEvent) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  style?: CardElementStyle;
}

interface CardChangeEvent {
  complete: boolean;
  error?: {
    type: 'validation_error';
    code: string;
    message: string;
  };
  brand?: string;
}

interface CardElementStyle {
  base?: {
    color?: string;
    fontFamily?: string;
    fontSize?: string;
    '::placeholder'?: { color?: string };
  };
  invalid?: {
    color?: string;
    iconColor?: string;
  };
}

export function CardElement({
  publishableKey,
  onReady,
  onChange,
  onFocus,
  onBlur,
  style
}: CardElementProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [stripe, setStripe] = useState<any>(null);
  const [element, setElement] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  // Load Stripe.js
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.async = true;
    script.onload = () => {
      const stripeInstance = (window as any).Stripe(publishableKey);
      setStripe(stripeInstance);
    };
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, [publishableKey]);

  // Create card element
  useEffect(() => {
    if (!stripe || !containerRef.current) return;

    const elements = stripe.elements();
    const cardElement = elements.create('card', {
      style: style || {
        base: {
          color: '#32325d',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '16px',
          '::placeholder': { color: '#aab7c4' }
        },
        invalid: {
          color: '#dc2626',
          iconColor: '#dc2626'
        }
      },
      hidePostalCode: false
    });

    cardElement.mount(containerRef.current);
    setElement(cardElement);

    // Event handlers
    cardElement.on('ready', () => onReady?.());

    cardElement.on('change', (event: CardChangeEvent) => {
      setError(event.error?.message || null);
      onChange?.(event);
    });

    cardElement.on('focus', () => {
      setIsFocused(true);
      onFocus?.();
    });

    cardElement.on('blur', () => {
      setIsFocused(false);
      onBlur?.();
    });

    return () => {
      cardElement.destroy();
    };
  }, [stripe]);

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className={`
          p-3 border rounded-lg transition-all
          ${isFocused ? 'border-indigo-500 ring-2 ring-indigo-200' : 'border-gray-300'}
          ${error ? 'border-red-500 ring-2 ring-red-200' : ''}
        `}
      />
      {error && (
        <p className="text-sm text-red-600 flex items-center gap-1" role="alert">
          <ErrorIcon className="w-4 h-4" />
          {error}
        </p>
      )}
    </div>
  );
}
```

### Payment Form with Accessibility

```tsx
// components/PaymentForm.tsx
import { useState, useId } from 'react';
import { CardElement } from './CardElement';

interface PaymentFormProps {
  amount: number;
  currency: string;
  onSuccess: (paymentIntent: any) => void;
  onError: (error: Error) => void;
}

export function PaymentForm({
  amount,
  currency,
  onSuccess,
  onError
}: PaymentFormProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [cardComplete, setCardComplete] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  const formId = useId();
  const emailId = `${formId}-email`;
  const nameId = `${formId}-name`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!cardComplete) {
      return;
    }

    setIsProcessing(true);

    try {
      // 1. Create payment intent on server
      const res = await fetch('/api/v1/payment-intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, currency, email })
      });

      const { client_secret, id } = await res.json();

      // 2. Confirm with Stripe.js
      const { error, paymentIntent } = await stripe.confirmCardPayment(
        client_secret,
        {
          payment_method: {
            card: cardElement,
            billing_details: { name, email }
          }
        }
      );

      if (error) {
        throw new Error(error.message);
      }

      onSuccess(paymentIntent);

    } catch (error) {
      onError(error as Error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6" aria-label="Payment form">
      {/* Amount display */}
      <div
        className="text-center p-4 bg-gray-50 rounded-lg"
        aria-live="polite"
      >
        <p className="text-sm text-gray-500">Amount due</p>
        <p className="text-3xl font-semibold text-gray-900">
          {formatCurrency(amount, currency)}
        </p>
      </div>

      {/* Email field */}
      <div>
        <label htmlFor={emailId} className="block text-sm font-medium text-gray-700">
          Email
        </label>
        <input
          id={emailId}
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg
                     focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          placeholder="you@example.com"
          autoComplete="email"
          aria-describedby={`${emailId}-hint`}
        />
        <p id={`${emailId}-hint`} className="mt-1 text-xs text-gray-500">
          Receipt will be sent to this email
        </p>
      </div>

      {/* Name field */}
      <div>
        <label htmlFor={nameId} className="block text-sm font-medium text-gray-700">
          Name on card
        </label>
        <input
          id={nameId}
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg
                     focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          placeholder="Jane Doe"
          autoComplete="cc-name"
        />
      </div>

      {/* Card element */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Card details
        </label>
        <CardElement
          publishableKey={import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY}
          onChange={(e) => setCardComplete(e.complete)}
        />
      </div>

      {/* Submit button */}
      <button
        type="submit"
        disabled={!cardComplete || isProcessing}
        className={`
          w-full py-3 px-4 rounded-lg font-medium
          transition-colors flex items-center justify-center gap-2
          ${cardComplete && !isProcessing
            ? 'bg-indigo-600 text-white hover:bg-indigo-700'
            : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }
        `}
        aria-busy={isProcessing}
      >
        {isProcessing ? (
          <>
            <SpinnerIcon className="w-5 h-5 animate-spin" aria-hidden="true" />
            <span>Processing...</span>
          </>
        ) : (
          <>
            <LockIcon className="w-5 h-5" aria-hidden="true" />
            <span>Pay {formatCurrency(amount, currency)}</span>
          </>
        )}
      </button>

      {/* Security badges */}
      <div className="flex items-center justify-center gap-4 text-xs text-gray-500">
        <div className="flex items-center gap-1">
          <ShieldIcon className="w-4 h-4" aria-hidden="true" />
          <span>Secure payment</span>
        </div>
        <div className="flex items-center gap-1">
          <LockIcon className="w-4 h-4" aria-hidden="true" />
          <span>SSL encrypted</span>
        </div>
      </div>
    </form>
  );
}
```

### Card Brand Icons

```tsx
// components/icons/CardBrandIcon.tsx
interface CardBrandIconProps {
  brand: string;
  className?: string;
}

export function CardBrandIcon({ brand, className = 'w-8 h-5' }: CardBrandIconProps) {
  switch (brand.toLowerCase()) {
    case 'visa':
      return (
        <svg className={className} viewBox="0 0 32 20" aria-label="Visa">
          <rect width="32" height="20" rx="2" fill="#1A1F71" />
          <path d="M13.5 14h-2l1.25-7.5h2L13.5 14z" fill="#fff" />
          <path d="M19.5 6.5c-.5-.2-1.2-.4-2.1-.4-2.3 0-4 1.2-4 2.9 0 1.3 1.1 2 2 2.4.9.4 1.2.7 1.2 1.1 0 .6-.7.9-1.4.9-.9 0-1.4-.1-2.2-.5l-.3-.1-.3 2c.5.3 1.5.5 2.5.5 2.5 0 4.1-1.2 4.1-3 0-1-.6-1.8-2-2.4-.8-.4-1.3-.7-1.3-1.1 0-.4.4-.8 1.3-.8.7 0 1.3.2 1.7.4l.2.1.6-1.9z" fill="#fff" />
          <path d="M24.5 6.5h-1.8c-.6 0-1 .2-1.2.7l-3.5 8.3h2.5l.5-1.4h3l.3 1.4h2.2l-2-8.5zm-2.9 5.5l1.2-3.3.7 3.3h-1.9z" fill="#fff" />
          <path d="M10 6.5l-2.3 5.1-.2-1.2c-.4-1.4-1.7-3-3.2-3.7l2.1 7.7h2.5l3.8-8h-2.7z" fill="#fff" />
        </svg>
      );

    case 'mastercard':
      return (
        <svg className={className} viewBox="0 0 32 20" aria-label="Mastercard">
          <rect width="32" height="20" rx="2" fill="#000" />
          <circle cx="12" cy="10" r="6" fill="#EB001B" />
          <circle cx="20" cy="10" r="6" fill="#F79E1B" />
          <path d="M16 5.5c1.5 1.2 2.5 3 2.5 5s-1 3.8-2.5 5c-1.5-1.2-2.5-3-2.5-5s1-3.8 2.5-5z" fill="#FF5F00" />
        </svg>
      );

    case 'amex':
      return (
        <svg className={className} viewBox="0 0 32 20" aria-label="American Express">
          <rect width="32" height="20" rx="2" fill="#016FD0" />
          <path d="M7 8h3l1.5 3.5L13 8h3v6h-2v-4l-1.5 4h-2L9 10v4H7V8z" fill="#fff" />
          <path d="M17 8h5l.5 1h-4v1h4l-.5 1H18v1h4l-.5 1h-4.5V8z" fill="#fff" />
        </svg>
      );

    default:
      return (
        <svg className={className} viewBox="0 0 32 20" aria-label="Card">
          <rect width="32" height="20" rx="2" fill="#6B7280" />
          <rect x="4" y="6" width="8" height="2" rx="1" fill="#fff" />
          <rect x="4" y="12" width="12" height="2" rx="1" fill="#fff" opacity="0.5" />
        </svg>
      );
  }
}
```

---

## Deep Dive: Webhook Configuration UI (5 minutes)

```tsx
// routes/developers/webhooks.tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface WebhookEndpoint {
  id: string;
  url: string;
  status: 'active' | 'disabled';
  events: string[];
  created_at: string;
  last_delivery: {
    status: 'success' | 'failed';
    timestamp: string;
    response_code: number;
  } | null;
}

const AVAILABLE_EVENTS = [
  { id: 'payment_intent.succeeded', label: 'Payment succeeded', category: 'Payments' },
  { id: 'payment_intent.failed', label: 'Payment failed', category: 'Payments' },
  { id: 'charge.refunded', label: 'Charge refunded', category: 'Refunds' },
  { id: 'charge.dispute.created', label: 'Dispute opened', category: 'Disputes' },
  { id: 'payout.paid', label: 'Payout sent', category: 'Payouts' }
];

export function WebhooksPage() {
  const [isCreating, setIsCreating] = useState(false);
  const queryClient = useQueryClient();

  const { data: endpoints } = useQuery({
    queryKey: ['webhook-endpoints'],
    queryFn: async () => {
      const res = await fetch('/api/v1/webhook-endpoints');
      return res.json() as Promise<WebhookEndpoint[]>;
    }
  });

  const createMutation = useMutation({
    mutationFn: async (data: { url: string; events: string[] }) => {
      const res = await fetch('/api/v1/webhook-endpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
      setIsCreating(false);
    }
  });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Webhooks</h1>
          <p className="text-gray-600 mt-1">
            Receive real-time notifications about events in your account
          </p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          Add endpoint
        </button>
      </header>

      {/* Endpoint list */}
      <div className="space-y-4">
        {endpoints?.map((endpoint) => (
          <WebhookEndpointCard key={endpoint.id} endpoint={endpoint} />
        ))}

        {endpoints?.length === 0 && (
          <div className="text-center py-12 bg-gray-50 rounded-lg">
            <WebhookIcon className="w-12 h-12 text-gray-400 mx-auto" />
            <p className="mt-4 text-gray-600">No webhook endpoints configured</p>
            <button
              onClick={() => setIsCreating(true)}
              className="mt-4 text-indigo-600 hover:text-indigo-800"
            >
              Add your first endpoint
            </button>
          </div>
        )}
      </div>

      {/* Create modal */}
      {isCreating && (
        <CreateEndpointModal
          onClose={() => setIsCreating(false)}
          onSubmit={(data) => createMutation.mutate(data)}
          isLoading={createMutation.isPending}
          availableEvents={AVAILABLE_EVENTS}
        />
      )}
    </div>
  );
}

function WebhookEndpointCard({ endpoint }: { endpoint: WebhookEndpoint }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span className={`
              px-2 py-0.5 rounded-full text-xs font-medium
              ${endpoint.status === 'active'
                ? 'bg-green-100 text-green-800'
                : 'bg-gray-100 text-gray-800'
              }
            `}>
              {endpoint.status}
            </span>
            <code className="text-sm font-mono text-gray-900">{endpoint.url}</code>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {endpoint.events.map((event) => (
              <span
                key={event}
                className="px-2 py-1 bg-gray-100 rounded text-xs font-mono"
              >
                {event}
              </span>
            ))}
          </div>
        </div>

        {/* Last delivery status */}
        {endpoint.last_delivery && (
          <div className="text-right">
            <div className={`
              flex items-center gap-1
              ${endpoint.last_delivery.status === 'success'
                ? 'text-green-600'
                : 'text-red-600'
              }
            `}>
              {endpoint.last_delivery.status === 'success' ? (
                <CheckIcon className="w-4 h-4" />
              ) : (
                <ErrorIcon className="w-4 h-4" />
              )}
              <span className="text-sm">
                {endpoint.last_delivery.response_code}
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {formatRelativeTime(endpoint.last_delivery.timestamp)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## State Management (3 minutes)

### Zustand Store

```typescript
// stores/merchantStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MerchantState {
  merchant: {
    id: string;
    name: string;
    email: string;
  } | null;
  isLiveMode: boolean;
  sidebarOpen: boolean;

  // Actions
  setMerchant: (merchant: MerchantState['merchant']) => void;
  toggleLiveMode: () => void;
  toggleSidebar: () => void;
  logout: () => void;
}

export const useMerchantStore = create<MerchantState>()(
  persist(
    (set) => ({
      merchant: null,
      isLiveMode: false, // Start in test mode for safety
      sidebarOpen: true,

      setMerchant: (merchant) => set({ merchant }),

      toggleLiveMode: () => set((state) => ({
        isLiveMode: !state.isLiveMode
      })),

      toggleSidebar: () => set((state) => ({
        sidebarOpen: !state.sidebarOpen
      })),

      logout: () => set({
        merchant: null,
        isLiveMode: false
      })
    }),
    {
      name: 'merchant-storage',
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        isLiveMode: state.isLiveMode
      })
    }
  )
);
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| **Card input** | Stripe Elements iframe | Custom inputs | PCI scope reduction, security isolation |
| **State management** | Zustand + React Query | Redux | Simpler API, built-in persistence |
| **Virtualization** | TanStack Virtual | react-window | Better TypeScript support, dynamic heights |
| **Real-time updates** | SSE | WebSocket | Simpler, sufficient for dashboard updates |
| **Styling** | Tailwind CSS | CSS-in-JS | Utility-first, consistent design system |

---

## Accessibility Considerations

1. **Form labels**: All inputs have associated labels with proper `htmlFor`
2. **Error states**: Errors announced via `role="alert"` and `aria-live`
3. **Focus management**: Modal traps focus, returns focus on close
4. **Keyboard navigation**: All interactive elements keyboard accessible
5. **Color contrast**: All text meets WCAG 2.1 AA requirements
6. **Screen readers**: Card brands and icons have proper aria-labels

---

## Future Enhancements

1. **Dark mode**: System preference detection with manual toggle
2. **Keyboard shortcuts**: Quick actions (N for new, S for search)
3. **Offline support**: Service worker for dashboard caching
4. **Mobile app**: React Native with shared business logic
5. **Analytics dashboard**: Interactive charts with D3/Recharts

---

## Summary

"I've designed Stripe's frontend with:

1. **Merchant Dashboard** with virtualized payment list, real-time balance updates
2. **API key management** with secure reveal/roll workflows
3. **Payment Elements** using Stripe.js with accessible card inputs
4. **Webhook configuration** UI with event selection and delivery status
5. **State management** using Zustand for global state, React Query for server state

The design prioritizes security (iframe isolation for card inputs), accessibility (WCAG 2.1 AA), and performance (virtualization for large lists)."
