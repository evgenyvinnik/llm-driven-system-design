# Stripe - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Introduction (2 minutes)

"Thank you for the opportunity. Today I'll design Stripe, a payment processing platform. As a full-stack engineer, I'm particularly interested in the end-to-end flow:

1. **Payment flow** - From frontend form to database ledger entry
2. **Idempotency** - How frontend retries interact with backend deduplication
3. **Webhooks** - Server-to-server event delivery with frontend status display
4. **Shared types** - TypeScript contracts between frontend and backend

Let me clarify the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our core payment platform:

1. **Charge**: Process payments via API with idempotency guarantees
2. **Merchant Dashboard**: View payments, manage keys, configure webhooks
3. **Payment Elements**: Embeddable card input for merchant websites
4. **Webhooks**: Notify merchants with reliable delivery
5. **Refunds**: Full and partial refunds with ledger entries

I'll focus on the end-to-end payment flow and webhook system."

### Non-Functional Requirements

"Financial systems have critical requirements spanning both frontend and backend:

- **Accuracy**: Zero duplicate charges - idempotency across the stack
- **Latency**: < 500ms authorization, < 1.5s frontend first paint
- **Availability**: 99.999% for payment processing
- **Security**: PCI compliance, secure card input isolation"

---

## High-Level Architecture (8 minutes)

### End-to-End Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Merchant Website                                   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                       Payment Form (React)                           │   │
│   │   ┌──────────────────┐  ┌────────────────────────────────────────┐  │   │
│   │   │  CardElement     │  │  Customer Info                         │  │   │
│   │   │  (Stripe iframe) │  │  (Email, Name, Address)                │  │   │
│   │   └────────┬─────────┘  └─────────────────┬──────────────────────┘  │   │
│   │            │                              │                          │   │
│   │            └──────────────┬───────────────┘                          │   │
│   │                           ▼                                          │   │
│   │                    ┌──────────────┐                                  │   │
│   │                    │ Pay Button   │                                  │   │
│   │                    └──────┬───────┘                                  │   │
│   └───────────────────────────┼──────────────────────────────────────────┘   │
│                               │                                              │
└───────────────────────────────┼──────────────────────────────────────────────┘
                                │
    ┌───────────────────────────┼───────────────────────────────────────────┐
    │                           │                                           │
    │  ① Create PaymentIntent   │  ④ Confirm with Stripe.js                │
    │     (Merchant Server)     │     (Direct to Stripe)                    │
    │                           │                                           │
    │           ▼               │               ▼                           │
    │   ┌───────────────┐       │       ┌───────────────┐                   │
    │   │    Merchant   │       │       │   Stripe.js   │                   │
    │   │    Backend    │◄──────┼───────│   SDK         │                   │
    │   └───────┬───────┘       │       └───────┬───────┘                   │
    │           │               │               │                           │
    └───────────┼───────────────┼───────────────┼───────────────────────────┘
                │               │               │
                ▼               │               ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                              Stripe API                                        │
│                                                                                │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                    │
│   │   ② Create   │    │  ③ Return    │    │  ⑤ Authorize │                    │
│   │   Intent     │───►│  client_     │    │  with Card   │                    │
│   │              │    │  secret      │    │  Network     │                    │
│   └──────────────┘    └──────────────┘    └──────────────┘                    │
│                                                   │                            │
│                                           ┌───────▼───────┐                    │
│                                           │  ⑥ Create     │                    │
│                                           │  Ledger       │                    │
│                                           │  Entries      │                    │
│                                           └───────┬───────┘                    │
│                                                   │                            │
│                                           ┌───────▼───────┐                    │
│                                           │  ⑦ Send       │                    │
│                                           │  Webhook      │──────┐             │
│                                           └───────────────┘      │             │
│                                                                  │             │
└──────────────────────────────────────────────────────────────────┼─────────────┘
                                                                   │
                               ┌───────────────────────────────────┼─────────┐
                               │          Merchant Backend         │         │
                               │                                   ▼         │
                               │   ┌─────────────────────────────────────┐   │
                               │   │  ⑧ Webhook Handler                  │   │
                               │   │  - Verify signature                 │   │
                               │   │  - Update order status              │   │
                               │   │  - Send confirmation email          │   │
                               │   └─────────────────────────────────────┘   │
                               │                                              │
                               └──────────────────────────────────────────────┘
```

### Shared Type Definitions

```typescript
// shared/types.ts
// Used by both frontend and backend

export interface PaymentIntent {
  id: string;                    // pi_xxx format
  object: 'payment_intent';
  amount: number;                // In cents
  currency: string;              // 'usd', 'eur', etc.
  status: PaymentIntentStatus;
  client_secret: string;         // For frontend confirmation
  payment_method?: string;
  metadata: Record<string, string>;
  created: number;               // Unix timestamp
}

export type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface CreatePaymentIntentRequest {
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
}

export interface CreatePaymentIntentResponse {
  id: string;
  client_secret: string;
  status: PaymentIntentStatus;
}

export interface WebhookEvent<T = unknown> {
  id: string;                    // evt_xxx format
  type: string;                  // 'payment_intent.succeeded'
  data: {
    object: T;
    previous_attributes?: Partial<T>;
  };
  created: number;
  api_version: string;
}

export interface Merchant {
  id: string;
  name: string;
  email: string;
  webhook_url?: string;
}

export interface LedgerEntry {
  id: string;
  account: string;
  debit: number;
  credit: number;
  intent_id: string;
  created_at: string;
}
```

---

## Deep Dive: Payment Flow (12 minutes)

### Frontend: Payment Form Component

```tsx
// frontend/components/PaymentForm.tsx
import { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import type { CreatePaymentIntentRequest, PaymentIntent } from '@shared/types';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

interface PaymentFormProps {
  amount: number;
  currency: string;
  onSuccess: (paymentIntent: PaymentIntent) => void;
  onError: (error: Error) => void;
}

function PaymentFormInner({ amount, currency, onSuccess, onError }: PaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      // Step 1: Create PaymentIntent on backend
      const intentRes = await fetch('/api/v1/payment-intents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `checkout_${orderId}_${Date.now()}`
        },
        body: JSON.stringify({
          amount,
          currency
        } as CreatePaymentIntentRequest)
      });

      if (!intentRes.ok) {
        const errorData = await intentRes.json();
        throw new Error(errorData.message || 'Failed to create payment');
      }

      const { client_secret, id } = await intentRes.json();

      // Step 2: Confirm payment with Stripe.js (card tokenization + auth)
      const cardElement = elements.getElement(CardElement);
      if (!cardElement) {
        throw new Error('Card element not found');
      }

      const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(
        client_secret,
        {
          payment_method: {
            card: cardElement,
            billing_details: {
              name: 'Customer Name',
              email: 'customer@example.com'
            }
          }
        }
      );

      if (confirmError) {
        throw new Error(confirmError.message);
      }

      if (paymentIntent.status === 'succeeded') {
        onSuccess(paymentIntent as PaymentIntent);
      } else if (paymentIntent.status === 'requires_action') {
        // 3D Secure authentication needed
        setError('Additional authentication required');
      }

    } catch (err) {
      setError((err as Error).message);
      onError(err as Error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-gray-50 rounded-lg p-4 text-center">
        <p className="text-gray-500 text-sm">Total</p>
        <p className="text-3xl font-semibold">{formatCurrency(amount, currency)}</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Card details
        </label>
        <div className="p-3 border rounded-lg">
          <CardElement
            options={{
              style: {
                base: {
                  fontSize: '16px',
                  color: '#1f2937',
                  '::placeholder': { color: '#9ca3af' }
                }
              }
            }}
          />
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={!stripe || isProcessing}
        className={`w-full py-3 rounded-lg font-medium flex items-center justify-center gap-2
          ${isProcessing ? 'bg-gray-400' : 'bg-indigo-600 hover:bg-indigo-700'} text-white`}
      >
        {isProcessing ? (
          <>
            <Spinner className="w-5 h-5 animate-spin" />
            Processing...
          </>
        ) : (
          `Pay ${formatCurrency(amount, currency)}`
        )}
      </button>
    </form>
  );
}

export function PaymentForm(props: PaymentFormProps) {
  return (
    <Elements stripe={stripePromise}>
      <PaymentFormInner {...props} />
    </Elements>
  );
}
```

### Backend: Payment Intent Endpoint

```typescript
// backend/src/routes/paymentIntents.ts
import { Router } from 'express';
import { z } from 'zod';
import type { CreatePaymentIntentRequest, PaymentIntent, LedgerEntry } from '@shared/types';
import { pool } from '../shared/db.js';
import { redis } from '../shared/redis.js';
import { webhookService } from '../services/webhookService.js';
import { fraudService } from '../services/fraudService.js';
import { cardNetworkGateway } from '../services/cardNetwork.js';
import { auditLogger } from '../shared/audit.js';

const router = Router();

// Validation schema
const CreatePaymentIntentSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  metadata: z.record(z.string()).optional()
});

// POST /v1/payment-intents - Create a new payment intent
router.post('/payment-intents', async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'] as string;
  const merchantId = req.merchantId;

  // Validate request body
  const parseResult = CreatePaymentIntentSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'validation_error',
      message: parseResult.error.errors[0].message
    });
  }

  const { amount, currency, metadata } = parseResult.data;

  try {
    // Idempotency check
    if (idempotencyKey) {
      const cached = await checkIdempotency(merchantId, idempotencyKey);
      if (cached) {
        return res.status(200).json(cached);
      }
    }

    // Create payment intent in database
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const intentResult = await client.query(`
        INSERT INTO payment_intents
          (id, merchant_id, amount, currency, status, metadata, created_at)
        VALUES
          (gen_random_uuid(), $1, $2, $3, 'requires_payment_method', $4, NOW())
        RETURNING *
      `, [merchantId, amount, currency, JSON.stringify(metadata || {})]);

      const intent = intentResult.rows[0];

      // Generate client secret (signed token for frontend)
      const clientSecret = generateClientSecret(intent.id, merchantId);

      await client.query('COMMIT');

      const response = {
        id: `pi_${intent.id}`,
        object: 'payment_intent',
        amount: intent.amount,
        currency: intent.currency,
        status: intent.status,
        client_secret: clientSecret,
        metadata: intent.metadata,
        created: Math.floor(new Date(intent.created_at).getTime() / 1000)
      };

      // Cache for idempotency
      if (idempotencyKey) {
        await cacheIdempotencyResponse(merchantId, idempotencyKey, response);
      }

      // Audit log
      await auditLogger.logPaymentCreated(intent, {
        ipAddress: req.ip,
        traceId: req.headers['x-trace-id'] as string
      });

      res.status(201).json(response);

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Failed to create payment intent:', error);
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to create payment intent'
    });
  }
});

// POST /v1/payment-intents/:id/confirm - Confirm and charge
router.post('/payment-intents/:id/confirm', async (req, res) => {
  const intentId = req.params.id.replace('pi_', '');
  const { payment_method_id } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

    // Get current intent state
    const intentResult = await client.query(`
      SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE
    `, [intentId]);

    if (intentResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }

    const intent = intentResult.rows[0];

    // State machine validation
    if (intent.status !== 'requires_payment_method' &&
        intent.status !== 'requires_confirmation') {
      return res.status(400).json({
        error: 'invalid_state',
        message: `Cannot confirm intent in ${intent.status} state`
      });
    }

    // Get payment method
    const pmResult = await client.query(`
      SELECT * FROM payment_methods WHERE id = $1
    `, [payment_method_id]);

    const paymentMethod = pmResult.rows[0];

    // Fraud check
    const riskScore = await fraudService.assessRisk({
      intent,
      paymentMethod,
      merchantId: intent.merchant_id,
      ipAddress: req.ip
    });

    if (riskScore > 0.8) {
      // High risk - require 3D Secure
      await client.query(`
        UPDATE payment_intents SET status = 'requires_action' WHERE id = $1
      `, [intentId]);
      await client.query('COMMIT');

      return res.json({
        status: 'requires_action',
        next_action: { type: 'redirect_to_3ds' }
      });
    }

    // Authorize with card network
    const authResult = await cardNetworkGateway.authorize({
      amount: intent.amount,
      currency: intent.currency,
      cardToken: paymentMethod.card_token,
      merchantId: intent.merchant_id
    });

    if (!authResult.approved) {
      await client.query(`
        UPDATE payment_intents
        SET status = 'failed', decline_code = $2, updated_at = NOW()
        WHERE id = $1
      `, [intentId, authResult.declineCode]);
      await client.query('COMMIT');

      return res.json({
        status: 'failed',
        decline_code: authResult.declineCode
      });
    }

    // Success! Create ledger entries
    await createLedgerEntries(client, {
      intentId,
      amount: intent.amount,
      merchantId: intent.merchant_id
    });

    // Update intent status
    await client.query(`
      UPDATE payment_intents
      SET status = 'succeeded', auth_code = $2, updated_at = NOW()
      WHERE id = $1
    `, [intentId, authResult.authCode]);

    await client.query('COMMIT');

    // Send webhook (async - don't block response)
    webhookService.send(intent.merchant_id, 'payment_intent.succeeded', {
      id: `pi_${intentId}`,
      object: 'payment_intent',
      amount: intent.amount,
      currency: intent.currency,
      status: 'succeeded'
    });

    res.json({ status: 'succeeded' });

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

// Ledger entry creation (double-entry)
async function createLedgerEntries(
  client: PoolClient,
  { intentId, amount, merchantId }: { intentId: string; amount: number; merchantId: string }
) {
  // Fee calculation: 2.9% + 30 cents
  const fee = Math.round(amount * 0.029 + 30);
  const merchantAmount = amount - fee;

  const entries: Omit<LedgerEntry, 'id' | 'created_at'>[] = [
    {
      account: 'funds_receivable',
      debit: amount,
      credit: 0,
      intent_id: intentId
    },
    {
      account: `merchant:${merchantId}:payable`,
      debit: 0,
      credit: merchantAmount,
      intent_id: intentId
    },
    {
      account: 'revenue:transaction_fees',
      debit: 0,
      credit: fee,
      intent_id: intentId
    }
  ];

  // Verify balance invariant
  const totalDebit = entries.reduce((sum, e) => sum + e.debit, 0);
  const totalCredit = entries.reduce((sum, e) => sum + e.credit, 0);

  if (totalDebit !== totalCredit) {
    throw new Error('Ledger imbalance');
  }

  // Insert all entries
  for (const entry of entries) {
    await client.query(`
      INSERT INTO ledger_entries (account, debit, credit, intent_id)
      VALUES ($1, $2, $3, $4)
    `, [entry.account, entry.debit, entry.credit, entry.intent_id]);
  }
}

export { router as paymentIntentsRouter };
```

---

## Deep Dive: Webhook System (10 minutes)

### Backend: Webhook Delivery Service

```typescript
// backend/src/services/webhookService.ts
import crypto from 'crypto';
import Queue from 'bull';
import type { WebhookEvent } from '@shared/types';
import { pool } from '../shared/db.js';

const webhookQueue = new Queue('webhook-delivery', process.env.REDIS_URL);

class WebhookService {
  async send<T>(merchantId: string, eventType: string, data: T): Promise<void> {
    // Get merchant webhook config
    const result = await pool.query(`
      SELECT webhook_url, webhook_secret FROM merchants WHERE id = $1
    `, [merchantId]);

    const merchant = result.rows[0];
    if (!merchant?.webhook_url) {
      return; // No webhook configured
    }

    // Create event
    const event: WebhookEvent<T> = {
      id: `evt_${crypto.randomUUID()}`,
      type: eventType,
      data: { object: data },
      created: Math.floor(Date.now() / 1000),
      api_version: '2024-01-01'
    };

    // Generate signature
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${JSON.stringify(event)}`;
    const signature = crypto
      .createHmac('sha256', merchant.webhook_secret)
      .update(signedPayload)
      .digest('hex');

    // Log event
    await pool.query(`
      INSERT INTO webhook_events (id, merchant_id, type, data, status)
      VALUES ($1, $2, $3, $4, 'pending')
    `, [event.id, merchantId, eventType, JSON.stringify(event)]);

    // Queue for delivery
    await webhookQueue.add({
      eventId: event.id,
      merchantId,
      url: merchant.webhook_url,
      payload: event,
      signature: `t=${timestamp},v1=${signature}`
    }, {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 1000 // 1s, 2s, 4s, 8s, 16s
      }
    });
  }
}

// Webhook delivery worker
webhookQueue.process(async (job) => {
  const { eventId, url, payload, signature, merchantId } = job.data;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': signature,
        'User-Agent': 'Stripe/1.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Mark as delivered
    await pool.query(`
      UPDATE webhook_events
      SET status = 'delivered', delivered_at = NOW()
      WHERE id = $1
    `, [eventId]);

  } catch (error) {
    clearTimeout(timeout);

    // Update failure status
    await pool.query(`
      UPDATE webhook_events
      SET status = 'failed', last_error = $2, attempts = attempts + 1
      WHERE id = $1
    `, [eventId, (error as Error).message]);

    throw error; // Let Bull handle retry
  }
});

export const webhookService = new WebhookService();
```

### Frontend: Webhook Events Dashboard

```tsx
// frontend/routes/developers/webhooks/events.tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { WebhookEvent } from '@shared/types';

interface WebhookEventRow {
  id: string;
  type: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  created_at: string;
  delivered_at: string | null;
  last_error: string | null;
  data: WebhookEvent;
}

export function WebhookEventsPage() {
  const [selectedEvent, setSelectedEvent] = useState<WebhookEventRow | null>(null);
  const [filter, setFilter] = useState<'all' | 'delivered' | 'failed'>('all');

  const { data: events, isLoading } = useQuery({
    queryKey: ['webhook-events', filter],
    queryFn: async () => {
      const params = filter !== 'all' ? `?status=${filter}` : '';
      const res = await fetch(`/api/v1/webhook-events${params}`);
      return res.json() as Promise<WebhookEventRow[]>;
    },
    refetchInterval: 10000 // Refresh every 10 seconds
  });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Webhook Events</h1>
        <div className="flex gap-2">
          {(['all', 'delivered', 'failed'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium
                ${filter === f
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </header>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Event</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {events?.map((event) => (
              <tr
                key={event.id}
                onClick={() => setSelectedEvent(event)}
                className="hover:bg-gray-50 cursor-pointer"
              >
                <td className="px-4 py-3 font-mono text-sm text-gray-900">
                  {event.id}
                </td>
                <td className="px-4 py-3">
                  <span className="px-2 py-1 bg-gray-100 rounded text-xs font-mono">
                    {event.type}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={event.status} attempts={event.attempts} />
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {formatRelativeTime(event.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Event detail modal */}
      {selectedEvent && (
        <EventDetailModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          onRetry={async () => {
            await fetch(`/api/v1/webhook-events/${selectedEvent.id}/retry`, {
              method: 'POST'
            });
            // Refetch events
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status, attempts }: { status: string; attempts: number }) {
  const styles = {
    pending: 'bg-yellow-100 text-yellow-800',
    delivered: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800'
  };

  return (
    <div className="flex items-center gap-2">
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
        {status}
      </span>
      {status === 'failed' && (
        <span className="text-xs text-gray-500">
          {attempts} attempt{attempts !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}

function EventDetailModal({
  event,
  onClose,
  onRetry
}: {
  event: WebhookEventRow;
  onClose: () => void;
  onRetry: () => Promise<void>;
}) {
  const [isRetrying, setIsRetrying] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden">
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">{event.id}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto">
          {/* Metadata */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-500">Type</p>
              <p className="font-mono text-sm">{event.type}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Status</p>
              <StatusBadge status={event.status} attempts={event.attempts} />
            </div>
            <div>
              <p className="text-sm text-gray-500">Created</p>
              <p className="text-sm">{formatDate(event.created_at)}</p>
            </div>
            {event.delivered_at && (
              <div>
                <p className="text-sm text-gray-500">Delivered</p>
                <p className="text-sm">{formatDate(event.delivered_at)}</p>
              </div>
            )}
          </div>

          {/* Error message */}
          {event.last_error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">{event.last_error}</p>
            </div>
          )}

          {/* Payload */}
          <div>
            <p className="text-sm text-gray-500 mb-2">Payload</p>
            <pre className="p-4 bg-gray-900 text-gray-100 rounded-lg text-xs overflow-x-auto">
              {JSON.stringify(event.data, null, 2)}
            </pre>
          </div>
        </div>

        {/* Actions */}
        {event.status === 'failed' && (
          <div className="px-6 py-4 border-t bg-gray-50">
            <button
              onClick={async () => {
                setIsRetrying(true);
                await onRetry();
                setIsRetrying(false);
              }}
              disabled={isRetrying}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              {isRetrying ? 'Retrying...' : 'Retry delivery'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

### Merchant-Side Webhook Handler

```typescript
// Example merchant webhook handler
import express from 'express';
import crypto from 'crypto';

const app = express();

// Webhook endpoint
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['stripe-signature'] as string;
  const payload = req.body;

  // Verify signature
  try {
    const event = verifyWebhookSignature(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);

    // Handle specific event types
    switch (event.type) {
      case 'payment_intent.succeeded':
        handlePaymentSuccess(event.data.object);
        break;
      case 'payment_intent.failed':
        handlePaymentFailure(event.data.object);
        break;
      case 'charge.refunded':
        handleRefund(event.data.object);
        break;
    }

    res.json({ received: true });

  } catch (error) {
    console.error('Webhook verification failed:', error);
    res.status(400).json({ error: 'Invalid signature' });
  }
});

function verifyWebhookSignature(payload: Buffer, signature: string, secret: string) {
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const sig = parts.find(p => p.startsWith('v1='))?.slice(3);

  if (!timestamp || !sig) {
    throw new Error('Invalid signature format');
  }

  // Check timestamp is within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    throw new Error('Timestamp too old');
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload.toString()}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  if (sig !== expected) {
    throw new Error('Signature mismatch');
  }

  return JSON.parse(payload.toString());
}

async function handlePaymentSuccess(paymentIntent: any) {
  // Update order status
  await db.query(`
    UPDATE orders
    SET status = 'paid', paid_at = NOW()
    WHERE payment_intent_id = $1
  `, [paymentIntent.id]);

  // Send confirmation email
  await sendOrderConfirmationEmail(paymentIntent.metadata.customer_email);
}
```

---

## Deep Dive: Merchant Dashboard (5 minutes)

### Balance with Ledger Integration

```tsx
// frontend/routes/balance/index.tsx
import { useQuery } from '@tanstack/react-query';

interface BalanceResponse {
  available: number;
  pending: number;
  currency: string;
  ledger_summary: {
    total_receivable: number;
    total_payable: number;
    total_revenue: number;
  };
}

export function BalancePage() {
  const { data: balance } = useQuery({
    queryKey: ['balance'],
    queryFn: async () => {
      const res = await fetch('/api/v1/balance');
      return res.json() as Promise<BalanceResponse>;
    }
  });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Balance</h1>

      {/* Balance cards */}
      <div className="grid grid-cols-3 gap-6">
        <BalanceCard
          title="Available"
          amount={balance?.available ?? 0}
          currency={balance?.currency ?? 'usd'}
          variant="primary"
        />
        <BalanceCard
          title="Pending"
          amount={balance?.pending ?? 0}
          currency={balance?.currency ?? 'usd'}
        />
        <BalanceCard
          title="Total Volume"
          amount={balance?.ledger_summary.total_receivable ?? 0}
          currency={balance?.currency ?? 'usd'}
        />
      </div>

      {/* Ledger breakdown */}
      <section className="bg-white rounded-lg border p-6">
        <h2 className="text-lg font-medium mb-4">Ledger Summary</h2>
        <div className="space-y-3">
          <LedgerRow
            label="Funds Receivable"
            amount={balance?.ledger_summary.total_receivable ?? 0}
            type="debit"
          />
          <LedgerRow
            label="Merchant Payable"
            amount={balance?.ledger_summary.total_payable ?? 0}
            type="credit"
          />
          <LedgerRow
            label="Transaction Fees"
            amount={balance?.ledger_summary.total_revenue ?? 0}
            type="credit"
          />
        </div>
      </section>
    </div>
  );
}
```

### Backend Balance Endpoint

```typescript
// backend/src/routes/balance.ts
router.get('/balance', async (req, res) => {
  const merchantId = req.merchantId;

  // Get ledger balances
  const ledgerResult = await pool.query(`
    SELECT
      account,
      SUM(debit) - SUM(credit) as balance
    FROM ledger_entries
    WHERE account LIKE $1 OR account = 'funds_receivable'
    GROUP BY account
  `, [`merchant:${merchantId}:%`]);

  const ledgerMap = new Map(
    ledgerResult.rows.map(r => [r.account, parseInt(r.balance)])
  );

  // Calculate available (settled) vs pending
  const pendingResult = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) as pending
    FROM payment_intents
    WHERE merchant_id = $1
      AND status = 'succeeded'
      AND created_at > NOW() - INTERVAL '2 days'
  `, [merchantId]);

  const totalPayable = ledgerMap.get(`merchant:${merchantId}:payable`) || 0;
  const pending = parseInt(pendingResult.rows[0].pending);
  const available = totalPayable - pending;

  res.json({
    available: Math.abs(available),
    pending: pending,
    currency: 'usd',
    ledger_summary: {
      total_receivable: ledgerMap.get('funds_receivable') || 0,
      total_payable: Math.abs(totalPayable),
      total_revenue: 0 // Would come from revenue:transaction_fees account
    }
  });
});
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| **Shared types** | TypeScript definitions | OpenAPI/Swagger | Simpler, compile-time safety |
| **Payment confirmation** | Client-side Stripe.js | Server-side only | PCI scope reduction, 3DS support |
| **Webhook delivery** | Bull queue | Direct HTTP | Reliable retry, backoff, monitoring |
| **Ledger queries** | PostgreSQL SUM | Materialized views | Simplicity for current scale |
| **Real-time updates** | Polling | WebSocket | Simpler, sufficient for dashboard |

---

## Integration Points Summary

### Frontend to Backend

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/payment-intents` | POST | Create payment intent |
| `/api/v1/payment-intents/:id/confirm` | POST | Confirm and charge |
| `/api/v1/balance` | GET | Get merchant balance |
| `/api/v1/webhook-events` | GET | List webhook events |
| `/api/v1/webhook-events/:id/retry` | POST | Retry failed webhook |

### Backend to External

| Service | Integration | Purpose |
|---------|-------------|---------|
| Card Network | REST API | Authorization, capture |
| Webhook Endpoints | HTTP POST | Event delivery |
| Fraud ML Service | gRPC | Risk scoring |

---

## Future Enhancements

1. **GraphQL API**: Flexible queries for dashboard
2. **WebSocket real-time**: Live payment updates
3. **Multi-currency**: FX conversion at payment time
4. **Subscription billing**: Recurring payments
5. **Connect platform**: Multi-party payments

---

## Summary

"I've designed Stripe's full-stack payment system with:

1. **Shared TypeScript types** ensuring API contract consistency
2. **Two-phase payment flow** - intent creation on backend, confirmation via Stripe.js
3. **Idempotency middleware** preventing duplicate charges across retries
4. **Double-entry ledger** with balance invariant checking
5. **Webhook system** with Bull queue, exponential backoff, and signature verification
6. **Dashboard integration** showing real-time balance from ledger

The design ensures financial accuracy from frontend form submission to ledger entry, with proper error handling and audit trails at every step."
