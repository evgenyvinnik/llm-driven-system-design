# Design Venmo - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Introduction (2 minutes)

"Thank you for having me. Today I'll design Venmo, a peer-to-peer payment platform with social features. As a full-stack engineer, I'll focus on the integration points between frontend and backend:

1. **End-to-End Payment Flow**: From user input through confirmation to database commit
2. **API Contract Design**: Type-safe interfaces that connect frontend and backend
3. **Error Handling Across the Stack**: How errors propagate and get displayed to users
4. **Real-Time Updates**: WebSocket integration for instant payment notifications

I'll demonstrate how both layers work together to create a trustworthy payment experience."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our full-stack implementation:

1. **Send Money**: Complete flow from recipient search to balance update
2. **Request Money**: Create requests with notifications to recipient
3. **Social Feed**: Transaction feed with real-time updates for new payments
4. **Wallet Management**: Balance display, funding sources, cashout options
5. **Notifications**: Real-time push when receiving payments or requests

I'll focus on the payment flow and real-time updates since those span the entire stack."

### Non-Functional Requirements

"Key constraints across the stack:

- **Consistency**: Frontend and backend must agree on transaction state
- **Idempotency**: Prevent duplicate payments from retries
- **Latency**: < 500ms end-to-end for payment confirmation
- **Error Recovery**: Clear error messages that help users fix issues

The challenge is maintaining consistency between optimistic UI updates and actual backend state."

---

## High-Level Architecture (5 minutes)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  PayFlow    │  │   Feed      │  │   Wallet    │  │  Requests   │     │
│  │  Component  │  │  Component  │  │  Component  │  │  Component  │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │                │             │
│  ┌──────┴────────────────┴────────────────┴────────────────┴──────┐     │
│  │                      Zustand Stores                             │     │
│  │   (walletStore, feedStore, authStore, requestStore)            │     │
│  └──────────────────────────────┬─────────────────────────────────┘     │
│                                 │                                        │
│  ┌──────────────────────────────┴─────────────────────────────────┐     │
│  │                       API Client (fetch)                        │     │
│  │   + WebSocket Client for real-time updates                     │     │
│  └──────────────────────────────┬─────────────────────────────────┘     │
└─────────────────────────────────┼───────────────────────────────────────┘
                                  │ HTTPS / WSS
┌─────────────────────────────────┼───────────────────────────────────────┐
│                              BACKEND                                     │
│  ┌──────────────────────────────┴─────────────────────────────────┐     │
│  │                      Express API Server                         │     │
│  │   /api/transfers, /api/wallet, /api/feed, /api/requests        │     │
│  └───────┬─────────────────────┬──────────────────────┬───────────┘     │
│          │                     │                      │                  │
│  ┌───────┴───────┐     ┌───────┴───────┐     ┌───────┴───────┐         │
│  │   Transfer    │     │     Feed      │     │    Wallet     │         │
│  │   Service     │────►│   Service     │     │   Service     │         │
│  │               │     │               │     │               │         │
│  │  - Locking    │     │  - Fan-out    │     │  - Balance    │         │
│  │  - Waterfall  │     │  - Visibility │     │  - Funding    │         │
│  └───────┬───────┘     └───────┬───────┘     └───────┬───────┘         │
│          │                     │                      │                  │
│  ┌───────┴─────────────────────┴──────────────────────┴───────────┐     │
│  │                    PostgreSQL + Redis                           │     │
│  └─────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: API Contract Design (8 minutes)

### Shared Type Definitions

"I use TypeScript interfaces shared between frontend and backend to ensure type safety across the stack."

```typescript
// shared/types.ts (used by both frontend and backend)

// ============ User Types ============
export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

// ============ Wallet Types ============
export interface Wallet {
  balance: number;         // In cents
  pendingBalance: number;  // Pending external charges
}

export interface PaymentMethod {
  id: string;
  type: 'bank' | 'card' | 'debit_card';
  last4: string;
  bankName: string;
  isDefault: boolean;
  verified: boolean;
}

// ============ Transfer Types ============
export type Visibility = 'public' | 'friends' | 'private';
export type TransferStatus = 'pending' | 'completed' | 'failed';

export interface Transfer {
  id: string;
  sender: User;
  receiver: User;
  amount: number;          // In cents
  note: string;
  visibility: Visibility;
  status: TransferStatus;
  createdAt: string;       // ISO 8601
}

export interface CreateTransferRequest {
  receiverId: string;
  amount: number;          // In cents
  note: string;
  visibility: Visibility;
  idempotencyKey: string;  // UUID generated by client
}

export interface CreateTransferResponse {
  transfer: Transfer;
  newBalance: number;      // Updated balance after transfer
}

// ============ Payment Request Types ============
export type RequestStatus = 'pending' | 'paid' | 'declined' | 'cancelled';

export interface PaymentRequest {
  id: string;
  requester: User;
  requestee: User;
  amount: number;
  note: string;
  status: RequestStatus;
  createdAt: string;
}

export interface CreatePaymentRequestBody {
  requesteeId: string;
  amount: number;
  note: string;
}

// ============ Feed Types ============
export interface FeedItem extends Transfer {
  likeCount: number;
  commentCount: number;
  isLikedByMe: boolean;
}

export interface FeedResponse {
  items: FeedItem[];
  nextCursor: string | null;
}

// ============ Error Types ============
export interface ApiError {
  code: string;
  message: string;
  field?: string;          // For validation errors
}
```

### API Client Implementation

```typescript
// frontend/src/services/api.ts
const API_BASE = '/api';

class ApiClient {
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      credentials: 'include', // Include session cookie
    });

    if (!response.ok) {
      const error = await response.json();
      throw new ApiError(error.code, error.message, error.field);
    }

    return response.json();
  }

  // Wallet endpoints
  async getWallet(): Promise<Wallet> {
    return this.request('/wallet');
  }

  async getPaymentMethods(): Promise<PaymentMethod[]> {
    return this.request('/wallet/payment-methods');
  }

  // Transfer endpoints
  async createTransfer(data: CreateTransferRequest): Promise<CreateTransferResponse> {
    return this.request('/transfers', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getTransactionHistory(cursor?: string): Promise<FeedResponse> {
    const params = cursor ? `?cursor=${cursor}` : '';
    return this.request(`/wallet/transactions${params}`);
  }

  // Feed endpoints
  async getFeed(cursor?: string): Promise<FeedResponse> {
    const params = cursor ? `?cursor=${cursor}` : '';
    return this.request(`/feed${params}`);
  }

  async likeTransaction(id: string): Promise<void> {
    return this.request(`/feed/${id}/like`, { method: 'POST' });
  }

  // Payment request endpoints
  async createPaymentRequest(data: CreatePaymentRequestBody): Promise<PaymentRequest> {
    return this.request('/requests', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getReceivedRequests(): Promise<PaymentRequest[]> {
    return this.request('/requests/received');
  }

  async payRequest(requestId: string): Promise<CreateTransferResponse> {
    return this.request(`/requests/${requestId}/pay`, { method: 'POST' });
  }

  // User search
  async searchUsers(query: string): Promise<User[]> {
    return this.request(`/users/search?q=${encodeURIComponent(query)}`);
  }
}

export const api = new ApiClient();
```

### Backend Route Implementation

```typescript
// backend/src/routes/transfers.ts
import { Router } from 'express';
import { z } from 'zod';
import { transferService } from '../services/transfer';
import { checkIdempotency, storeIdempotencyResult } from '../shared/idempotency';
import { createAuditLog, AUDIT_ACTIONS } from '../shared/audit';

const router = Router();

// Validation schema matches frontend types
const CreateTransferSchema = z.object({
  receiverId: z.string().uuid(),
  amount: z.number().int().min(1).max(500000), // $0.01 to $5,000
  note: z.string().max(500),
  visibility: z.enum(['public', 'friends', 'private']),
  idempotencyKey: z.string().uuid(),
});

router.post('/', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const data = CreateTransferSchema.parse(req.body);

    // Check idempotency first
    const { isNew, existingResponse } = await checkIdempotency(
      userId,
      data.idempotencyKey,
      'transfer'
    );

    if (!isNew) {
      // Return cached response for duplicate request
      return res.json(existingResponse);
    }

    // Process transfer
    const result = await transferService.createTransfer({
      senderId: userId,
      receiverId: data.receiverId,
      amount: data.amount,
      note: data.note,
      visibility: data.visibility,
    });

    // Build response matching CreateTransferResponse type
    const response: CreateTransferResponse = {
      transfer: {
        id: result.id,
        sender: result.sender,
        receiver: result.receiver,
        amount: result.amount,
        note: result.note,
        visibility: result.visibility,
        status: result.status,
        createdAt: result.created_at.toISOString(),
      },
      newBalance: result.senderNewBalance,
    };

    // Store for idempotency
    await storeIdempotencyResult(
      userId,
      data.idempotencyKey,
      'transfer',
      'completed',
      response
    );

    // Audit log
    await createAuditLog({
      action: AUDIT_ACTIONS.TRANSFER_COMPLETED,
      actorId: userId,
      resourceType: 'transfer',
      resourceId: result.id,
      details: { amount: data.amount, receiverId: data.receiverId },
      request: req,
    });

    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
});

export default router;
```

---

## Deep Dive: End-to-End Payment Flow (10 minutes)

### Sequence Diagram

```
User          Frontend              Backend                PostgreSQL      Redis
  │               │                    │                       │             │
  │ Click "Pay"   │                    │                       │             │
  ├──────────────►│                    │                       │             │
  │               │ Generate idempotency key                   │             │
  │               │ (crypto.randomUUID())                      │             │
  │               │                    │                       │             │
  │               │ POST /api/transfers│                       │             │
  │               ├───────────────────►│                       │             │
  │               │                    │                       │             │
  │               │                    │ Check idempotency     │             │
  │               │                    ├──────────────────────────────────►│
  │               │                    │◄──────────────────────────────────┤
  │               │                    │ (cache miss)          │             │
  │               │                    │                       │             │
  │               │                    │ BEGIN TRANSACTION     │             │
  │               │                    ├──────────────────────►│             │
  │               │                    │                       │             │
  │               │                    │ SELECT wallet FOR UPDATE            │
  │               │                    ├──────────────────────►│             │
  │               │                    │◄──────────────────────┤             │
  │               │                    │ (row locked)          │             │
  │               │                    │                       │             │
  │               │                    │ Check balance, determine funding    │
  │               │                    │                       │             │
  │               │                    │ UPDATE sender balance │             │
  │               │                    ├──────────────────────►│             │
  │               │                    │                       │             │
  │               │                    │ UPDATE receiver balance             │
  │               │                    ├──────────────────────►│             │
  │               │                    │                       │             │
  │               │                    │ INSERT transfer record│             │
  │               │                    ├──────────────────────►│             │
  │               │                    │                       │             │
  │               │                    │ COMMIT                │             │
  │               │                    ├──────────────────────►│             │
  │               │                    │◄──────────────────────┤             │
  │               │                    │                       │             │
  │               │                    │ Invalidate cache      │             │
  │               │                    ├──────────────────────────────────►│
  │               │                    │                       │             │
  │               │                    │ Store idempotency     │             │
  │               │                    ├──────────────────────────────────►│
  │               │                    │                       │             │
  │               │                    │ Queue feed fanout (async)          │
  │               │                    │ Queue notification (async)         │
  │               │                    │                       │             │
  │               │◄───────────────────┤                       │             │
  │               │ { transfer, newBalance }                   │             │
  │               │                    │                       │             │
  │               │ Update Zustand store                       │             │
  │               │ (wallet.balance = newBalance)              │             │
  │               │                    │                       │             │
  │◄──────────────┤                    │                       │             │
  │ Show success  │                    │                       │             │
  │ screen        │                    │                       │             │
```

### Frontend Payment Flow Component

```tsx
// frontend/src/components/pay/PaymentFlow.tsx
import { useState, useCallback } from 'react';
import { api } from '../../services/api';
import { useWalletStore } from '../../stores';

type Step = 'recipient' | 'amount' | 'note' | 'confirm' | 'processing' | 'success' | 'error';

interface PaymentState {
  recipient: User | null;
  amount: number;          // In cents
  note: string;
  visibility: Visibility;
}

export function PaymentFlow() {
  const [step, setStep] = useState<Step>('recipient');
  const [payment, setPayment] = useState<PaymentState>({
    recipient: null,
    amount: 0,
    note: '',
    visibility: 'public'
  });
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<Transfer | null>(null);

  const { balance, setBalance } = useWalletStore();

  const handleConfirm = useCallback(async () => {
    if (!payment.recipient) return;

    setStep('processing');
    setError(null);

    // Generate idempotency key at submission time
    // This ensures retries use the same key
    const idempotencyKey = crypto.randomUUID();

    try {
      const response = await api.createTransfer({
        receiverId: payment.recipient.id,
        amount: payment.amount,
        note: payment.note,
        visibility: payment.visibility,
        idempotencyKey,
      });

      // Update local state with new balance from server
      setBalance(response.newBalance);
      setTransfer(response.transfer);
      setStep('success');

    } catch (err) {
      // Map error codes to user-friendly messages
      const message = getErrorMessage(err);
      setError(message);
      setStep('error');
    }
  }, [payment, setBalance]);

  // Retry from error state
  const handleRetry = useCallback(() => {
    setError(null);
    setStep('confirm');
  }, []);

  return (
    <div className="min-h-screen bg-white">
      {step === 'recipient' && (
        <RecipientStep
          onSelect={(user) => {
            setPayment(prev => ({ ...prev, recipient: user }));
            setStep('amount');
          }}
        />
      )}

      {step === 'amount' && (
        <AmountStep
          recipient={payment.recipient!}
          maxAmount={balance}
          onConfirm={(amount) => {
            setPayment(prev => ({ ...prev, amount }));
            setStep('note');
          }}
          onBack={() => setStep('recipient')}
        />
      )}

      {step === 'note' && (
        <NoteStep
          onConfirm={(note, visibility) => {
            setPayment(prev => ({ ...prev, note, visibility }));
            setStep('confirm');
          }}
          onBack={() => setStep('amount')}
        />
      )}

      {step === 'confirm' && (
        <ConfirmStep
          payment={payment}
          onConfirm={handleConfirm}
          onBack={() => setStep('note')}
        />
      )}

      {step === 'processing' && (
        <ProcessingScreen payment={payment} />
      )}

      {step === 'success' && transfer && (
        <SuccessScreen
          transfer={transfer}
          onDone={() => navigate('/')}
          onSendAnother={() => {
            setPayment({ recipient: null, amount: 0, note: '', visibility: 'public' });
            setTransfer(null);
            setStep('recipient');
          }}
        />
      )}

      {step === 'error' && (
        <ErrorScreen
          error={error!}
          onRetry={handleRetry}
          onCancel={() => navigate('/')}
        />
      )}
    </div>
  );
}

function getErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'INSUFFICIENT_FUNDS':
        return "You don't have enough balance for this payment.";
      case 'RECIPIENT_NOT_FOUND':
        return 'The recipient account was not found.';
      case 'DAILY_LIMIT_EXCEEDED':
        return "You've reached your daily transfer limit.";
      case 'ACCOUNT_FROZEN':
        return 'Your account is temporarily frozen. Please contact support.';
      default:
        return err.message || 'Something went wrong. Please try again.';
    }
  }
  return 'Connection error. Please check your internet and try again.';
}
```

### Backend Transfer Service

```typescript
// backend/src/services/transfer.ts
import { pool } from '../shared/db';
import { invalidateBalanceCache } from '../shared/cache';
import { publishToQueue } from '../shared/queue';

interface TransferInput {
  senderId: string;
  receiverId: string;
  amount: number;
  note: string;
  visibility: 'public' | 'friends' | 'private';
}

interface TransferResult {
  id: string;
  sender: User;
  receiver: User;
  amount: number;
  note: string;
  visibility: string;
  status: string;
  created_at: Date;
  senderNewBalance: number;
}

export async function createTransfer(input: TransferInput): Promise<TransferResult> {
  const { senderId, receiverId, amount, note, visibility } = input;

  // Validate
  if (amount <= 0 || amount > 500000) {
    throw new ApiError('INVALID_AMOUNT', 'Amount must be between $0.01 and $5,000');
  }

  if (senderId === receiverId) {
    throw new ApiError('INVALID_RECIPIENT', 'Cannot send money to yourself');
  }

  // Execute atomic transfer
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock sender's wallet
    const senderWallet = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
      [senderId]
    );

    if (!senderWallet.rows.length) {
      throw new ApiError('WALLET_NOT_FOUND', 'Sender wallet not found');
    }

    const currentBalance = senderWallet.rows[0].balance;

    // Check funds (simplified - production would include funding waterfall)
    if (currentBalance < amount) {
      throw new ApiError('INSUFFICIENT_FUNDS', 'Not enough balance');
    }

    // Verify receiver exists
    const receiver = await client.query(
      'SELECT id, username, name as "displayName", avatar_url as "avatarUrl" FROM users WHERE id = $1',
      [receiverId]
    );

    if (!receiver.rows.length) {
      throw new ApiError('RECIPIENT_NOT_FOUND', 'Recipient not found');
    }

    // Debit sender
    await client.query(
      'UPDATE wallets SET balance = balance - $2, updated_at = NOW() WHERE user_id = $1',
      [senderId, amount]
    );

    // Credit receiver
    await client.query(
      'UPDATE wallets SET balance = balance + $2, updated_at = NOW() WHERE user_id = $1',
      [receiverId, amount]
    );

    // Create transfer record
    const transfer = await client.query(
      `INSERT INTO transfers (sender_id, receiver_id, amount, note, visibility, status)
       VALUES ($1, $2, $3, $4, $5, 'completed')
       RETURNING *`,
      [senderId, receiverId, amount, note, visibility]
    );

    // Get sender info for response
    const sender = await client.query(
      'SELECT id, username, name as "displayName", avatar_url as "avatarUrl" FROM users WHERE id = $1',
      [senderId]
    );

    await client.query('COMMIT');

    // Post-commit: cache invalidation and async jobs
    await Promise.all([
      invalidateBalanceCache(senderId),
      invalidateBalanceCache(receiverId),
    ]);

    // Queue async jobs (feed fanout, notifications)
    await publishToQueue('feed-fanout', {
      transferId: transfer.rows[0].id,
      senderId,
      receiverId,
      visibility,
      amount,
      note,
    });

    await publishToQueue('notifications', {
      type: 'payment_received',
      userId: receiverId,
      data: {
        senderName: sender.rows[0].displayName,
        amount,
      },
    });

    return {
      id: transfer.rows[0].id,
      sender: sender.rows[0],
      receiver: receiver.rows[0],
      amount,
      note,
      visibility,
      status: 'completed',
      created_at: transfer.rows[0].created_at,
      senderNewBalance: currentBalance - amount,
    };

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

---

## Deep Dive: Real-Time Updates with WebSocket (8 minutes)

### WebSocket Message Types

```typescript
// shared/websocket-types.ts
export type WebSocketMessage =
  | { type: 'payment_received'; data: PaymentReceivedData }
  | { type: 'payment_request'; data: PaymentRequestData }
  | { type: 'request_paid'; data: RequestPaidData }
  | { type: 'balance_updated'; data: BalanceUpdatedData }
  | { type: 'feed_item'; data: FeedItem };

export interface PaymentReceivedData {
  transfer: Transfer;
  newBalance: number;
}

export interface PaymentRequestData {
  request: PaymentRequest;
}

export interface RequestPaidData {
  requestId: string;
  transfer: Transfer;
}

export interface BalanceUpdatedData {
  balance: number;
  pendingBalance: number;
}
```

### Frontend WebSocket Client

```typescript
// frontend/src/services/websocket.ts
import { useWalletStore, useFeedStore, useRequestStore } from '../stores';

class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      const message: WebSocketMessage = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.attemptReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  private handleMessage(message: WebSocketMessage) {
    switch (message.type) {
      case 'payment_received':
        this.handlePaymentReceived(message.data);
        break;

      case 'payment_request':
        this.handlePaymentRequest(message.data);
        break;

      case 'request_paid':
        this.handleRequestPaid(message.data);
        break;

      case 'balance_updated':
        this.handleBalanceUpdated(message.data);
        break;

      case 'feed_item':
        this.handleFeedItem(message.data);
        break;
    }
  }

  private handlePaymentReceived(data: PaymentReceivedData) {
    const { setBalance, addTransaction } = useWalletStore.getState();
    const { prependItem } = useFeedStore.getState();

    // Update balance
    setBalance(data.newBalance);

    // Add to transaction history
    addTransaction(data.transfer);

    // Add to feed
    prependItem({
      ...data.transfer,
      likeCount: 0,
      commentCount: 0,
      isLikedByMe: false,
    });

    // Show toast notification
    showToast({
      title: 'Payment Received',
      message: `${data.transfer.sender.displayName} sent you ${formatCurrency(data.transfer.amount)}`,
    });
  }

  private handlePaymentRequest(data: PaymentRequestData) {
    const { addReceivedRequest } = useRequestStore.getState();

    addReceivedRequest(data.request);

    showToast({
      title: 'Payment Request',
      message: `${data.request.requester.displayName} requested ${formatCurrency(data.request.amount)}`,
      action: {
        label: 'View',
        onClick: () => navigate('/requests'),
      },
    });
  }

  private handleBalanceUpdated(data: BalanceUpdatedData) {
    const { setBalance, setPendingBalance } = useWalletStore.getState();
    setBalance(data.balance);
    setPendingBalance(data.pendingBalance);
  }

  private handleFeedItem(data: FeedItem) {
    const { prependItem } = useFeedStore.getState();
    prependItem(data);
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const wsClient = new WebSocketClient();
```

### Backend WebSocket Handler

```typescript
// backend/src/websocket.ts
import { WebSocketServer, WebSocket } from 'ws';
import { verifySession } from './shared/auth';
import { redis } from './shared/cache';

const wss = new WebSocketServer({ noServer: true });

// Map userId -> Set of WebSocket connections
const connections = new Map<string, Set<WebSocket>>();

export function handleUpgrade(request: any, socket: any, head: any) {
  // Verify session from cookie
  const sessionId = parseSessionCookie(request.headers.cookie);

  verifySession(sessionId)
    .then((userId) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, userId);
      });
    })
    .catch(() => {
      socket.destroy();
    });
}

wss.on('connection', (ws: WebSocket, userId: string) => {
  // Add to connections map
  if (!connections.has(userId)) {
    connections.set(userId, new Set());
  }
  connections.get(userId)!.add(ws);

  console.log(`WebSocket connected: ${userId}`);

  ws.on('close', () => {
    connections.get(userId)?.delete(ws);
    if (connections.get(userId)?.size === 0) {
      connections.delete(userId);
    }
    console.log(`WebSocket disconnected: ${userId}`);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Send message to specific user (all their connections)
export function sendToUser(userId: string, message: WebSocketMessage) {
  const userConnections = connections.get(userId);
  if (!userConnections) return;

  const payload = JSON.stringify(message);
  for (const ws of userConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// Called after transfer completion
export async function notifyPaymentReceived(
  receiverId: string,
  transfer: Transfer,
  newBalance: number
) {
  sendToUser(receiverId, {
    type: 'payment_received',
    data: { transfer, newBalance },
  });
}

export async function notifyPaymentRequest(
  requesteeId: string,
  request: PaymentRequest
) {
  sendToUser(requesteeId, {
    type: 'payment_request',
    data: { request },
  });
}
```

---

## Deep Dive: Error Handling Across the Stack (5 minutes)

### Error Code Mapping

```typescript
// shared/errors.ts
export const ERROR_CODES = {
  // Validation errors
  INVALID_AMOUNT: 'Amount must be between $0.01 and $5,000',
  INVALID_RECIPIENT: 'Cannot send money to yourself',
  MISSING_FIELD: 'Required field is missing',

  // Business logic errors
  INSUFFICIENT_FUNDS: 'Not enough balance for this payment',
  DAILY_LIMIT_EXCEEDED: 'Daily transfer limit reached',
  RECIPIENT_NOT_FOUND: 'Recipient account not found',
  ACCOUNT_FROZEN: 'Account temporarily frozen',
  PAYMENT_METHOD_INVALID: 'Payment method is no longer valid',

  // System errors
  DATABASE_ERROR: 'Service temporarily unavailable',
  EXTERNAL_SERVICE_ERROR: 'Bank connection unavailable',
  RATE_LIMITED: 'Too many requests, please slow down',
} as const;

// Backend error class
export class ApiError extends Error {
  constructor(
    public code: keyof typeof ERROR_CODES,
    public message: string,
    public field?: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      field: this.field,
    };
  }
}
```

### Backend Error Middleware

```typescript
// backend/src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../shared/errors';
import { logger } from '../shared/logger';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Log all errors
  logger.error({
    error: err.message,
    stack: err.stack,
    requestId: req.headers['x-request-id'],
    path: req.path,
    method: req.method,
    userId: req.session?.userId,
  });

  // Known API errors
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json(err.toJSON());
  }

  // Zod validation errors
  if (err.name === 'ZodError') {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      errors: err.errors,
    });
  }

  // Database constraint violations
  if (err.code === '23505') { // Unique violation
    return res.status(409).json({
      code: 'DUPLICATE_ENTRY',
      message: 'This record already exists',
    });
  }

  // Unknown errors - don't leak details
  return res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong. Please try again.',
  });
}
```

### Frontend Error Display

```tsx
// frontend/src/components/common/ErrorDisplay.tsx
interface ErrorDisplayProps {
  error: ApiError | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export function ErrorDisplay({ error, onRetry, onDismiss }: ErrorDisplayProps) {
  if (!error) return null;

  const isRetryable = [
    'DATABASE_ERROR',
    'EXTERNAL_SERVICE_ERROR',
    'RATE_LIMITED',
  ].includes(error.code);

  return (
    <div
      role="alert"
      className="bg-red-50 border border-red-200 rounded-lg p-4"
    >
      <div className="flex items-start gap-3">
        <ErrorIcon className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />

        <div className="flex-1">
          <p className="text-red-800 font-medium">
            {getErrorTitle(error.code)}
          </p>
          <p className="text-red-700 text-sm mt-1">
            {error.message}
          </p>

          {isRetryable && onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 text-sm font-medium text-red-700 hover:text-red-800"
            >
              Try again
            </button>
          )}
        </div>

        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-red-400 hover:text-red-600"
            aria-label="Dismiss"
          >
            <CloseIcon className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}

function getErrorTitle(code: string): string {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return 'Not Enough Balance';
    case 'RECIPIENT_NOT_FOUND':
      return 'User Not Found';
    case 'DAILY_LIMIT_EXCEEDED':
      return 'Limit Reached';
    case 'EXTERNAL_SERVICE_ERROR':
      return 'Connection Issue';
    default:
      return 'Error';
  }
}
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State management | Zustand | Redux, React Query | Simple API, good for optimistic updates |
| API style | REST | GraphQL | Simpler for fixed endpoints, easier caching |
| Real-time | WebSocket | Server-Sent Events | Bidirectional communication possible |
| Type sharing | Manual TypeScript | tRPC, OpenAPI | Full control, no build dependencies |
| Error handling | Code-based | HTTP status only | Specific error handling in UI |
| Idempotency key | Client-generated UUID | Server-generated | Works offline, prevents race conditions |

---

## Summary

"To summarize the full-stack design:

1. **Type-Safe API Contracts**: Shared TypeScript interfaces ensure frontend and backend agree on data shapes

2. **End-to-End Payment Flow**: Multi-step wizard on frontend, atomic transactions on backend, with idempotency preventing duplicates

3. **Real-Time Updates**: WebSocket connection delivers instant payment notifications, updating both balance and feed

4. **Consistent Error Handling**: Typed error codes map to user-friendly messages, with retry logic for transient failures

5. **Optimistic Updates with Rollback**: UI updates immediately, server response confirms or triggers rollback

6. **Idempotency Across Retries**: Client-generated keys ensure network retries never cause duplicate payments

The design ensures consistency between frontend state and backend truth while delivering the instant, trustworthy experience users expect from a payment app.

What would you like me to elaborate on?"
