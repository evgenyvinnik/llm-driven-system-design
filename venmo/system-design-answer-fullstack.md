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

**User Types:**
- User: id, username, displayName, avatarUrl

**Wallet Types:**
- Wallet: balance (cents), pendingBalance
- PaymentMethod: id, type (bank | card | debit_card), last4, bankName, isDefault, verified

**Transfer Types:**
- Visibility: public | friends | private
- TransferStatus: pending | completed | failed
- Transfer: id, sender (User), receiver (User), amount (cents), note, visibility, status, createdAt (ISO 8601)
- CreateTransferRequest: receiverId, amount, note, visibility, idempotencyKey (client-generated UUID)
- CreateTransferResponse: transfer, newBalance

**Payment Request Types:**
- RequestStatus: pending | paid | declined | cancelled
- PaymentRequest: id, requester (User), requestee (User), amount, note, status, createdAt
- CreatePaymentRequestBody: requesteeId, amount, note

**Feed Types:**
- FeedItem: extends Transfer with likeCount, commentCount, isLikedByMe
- FeedResponse: items (FeedItem[]), nextCursor

**Error Types:**
- ApiError: code, message, field (optional for validation errors)

### API Client Implementation

The frontend API client provides typed methods for all endpoints:

```
┌───────────────────────────────────────────────────────────────────┐
│                        API Client Methods                          │
├───────────────────────────────────────────────────────────────────┤
│  WALLET                                                            │
│  ├── getWallet() → Wallet                                         │
│  └── getPaymentMethods() → PaymentMethod[]                        │
│                                                                    │
│  TRANSFERS                                                         │
│  ├── createTransfer(data) → CreateTransferResponse                │
│  └── getTransactionHistory(cursor?) → FeedResponse                │
│                                                                    │
│  FEED                                                              │
│  ├── getFeed(cursor?) → FeedResponse                              │
│  └── likeTransaction(id) → void                                   │
│                                                                    │
│  REQUESTS                                                          │
│  ├── createPaymentRequest(data) → PaymentRequest                  │
│  ├── getReceivedRequests() → PaymentRequest[]                     │
│  └── payRequest(requestId) → CreateTransferResponse               │
│                                                                    │
│  USERS                                                             │
│  └── searchUsers(query) → User[]                                  │
└───────────────────────────────────────────────────────────────────┘
```

**Request Configuration:**
- Content-Type: application/json
- credentials: include (session cookie)
- Error responses throw ApiError with code, message, field

### Backend Route Implementation

**POST /api/transfers** - Create Transfer:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Transfer Route Handler                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. VALIDATION (Zod schema)                                         │
│     ├── receiverId: UUID                                            │
│     ├── amount: integer, 1-500000 ($0.01 to $5,000)                 │
│     ├── note: string, max 500 chars                                 │
│     ├── visibility: public | friends | private                      │
│     └── idempotencyKey: UUID                                        │
│                                                                      │
│  2. IDEMPOTENCY CHECK                                               │
│     ├── checkIdempotency(userId, key, 'transfer')                   │
│     ├── If existing: return cached response                         │
│     └── If new: proceed                                             │
│                                                                      │
│  3. PROCESS TRANSFER                                                │
│     └── transferService.createTransfer({...})                       │
│                                                                      │
│  4. BUILD RESPONSE                                                  │
│     └── { transfer: {...}, newBalance }                             │
│                                                                      │
│  5. STORE IDEMPOTENCY RESULT                                        │
│     └── storeIdempotencyResult(userId, key, 'transfer', response)   │
│                                                                      │
│  6. AUDIT LOG                                                       │
│     └── createAuditLog(TRANSFER_COMPLETED, details)                 │
│                                                                      │
│  7. RETURN 201 with CreateTransferResponse                          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: End-to-End Payment Flow (10 minutes)

### Sequence Diagram

```
User          Frontend            Backend              Postgres        Redis
 │  click Pay ──▶ mint idempotency key (crypto.randomUUID)
 │               POST /api/transfers ──▶
 │                                   check idempotency ─────────────────▶
 │                                   ◀── hit? return stored result, done
 │                                   BEGIN
 │                                     SELECT … FOR UPDATE (both wallets,
 │                                       ordered by user_id — no deadlock)
 │                                     determine funding source
 │                                     insert transfer + paired ledger rows
 │                                     write idempotency key
 │                                   COMMIT
 │                                   fan out to feed_items (after commit,
 │                                     failure logged, never rolled back)
 │  ◀── 201 with the transfer ───────
 │               invalidate balance cache ─────────────────────────────▶
```

Two orderings in that sequence carry the design: the idempotency key is written **inside** the transaction, so it cannot exist without a completed payment; and fan-out happens **after** commit, so a feed failure can never roll back money.

### Frontend Payment Flow Component

```
┌───────────────────────────────────────────────────────────────────┐
│                     Payment Flow UI States                         │
├───────────────────────────────────────────────────────────────────┤
│                                                                    │
│  STEP 1: RECIPIENT                                                │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Search bar → User search results → Select user              │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                           ↓                                        │
│  STEP 2: AMOUNT                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Recipient avatar/name | Amount input | Max = balance        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                           ↓                                        │
│  STEP 3: NOTE                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Note text input | Visibility selector (public/friends/private)│ │
│  └─────────────────────────────────────────────────────────────┘  │
│                           ↓                                        │
│  STEP 4: CONFIRM                                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Review: Recipient, Amount, Note | [Pay] button               │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                           ↓                                        │
│  STEP 5: PROCESSING                                               │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Loading spinner | Recipient avatar | Amount                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                      ↓           ↓                                 │
│  STEP 6a: SUCCESS            STEP 6b: ERROR                       │
│  ┌────────────────────────┐  ┌────────────────────────────────┐   │
│  │ Checkmark animation    │  │ Error message                   │   │
│  │ [Done] [Send Another]  │  │ [Retry] [Cancel]                │   │
│  └────────────────────────┘  └────────────────────────────────┘   │
│                                                                    │
└───────────────────────────────────────────────────────────────────┘
```

**Key Implementation Details:**
- Idempotency key generated at submission time (not earlier)
- Same key used for retries to prevent duplicates
- Balance updated from server response (newBalance)
- Error codes mapped to user-friendly messages

**Error Code Mappings:**
- INSUFFICIENT_FUNDS → "You don't have enough balance for this payment."
- RECIPIENT_NOT_FOUND → "The recipient account was not found."
- DAILY_LIMIT_EXCEEDED → "You've reached your daily transfer limit."
- ACCOUNT_FROZEN → "Your account is temporarily frozen. Please contact support."

### Backend Transfer Service

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Transfer Service Flow                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. VALIDATE                                                        │
│     ├── Amount: 1-500000 cents ($0.01 to $5,000)                    │
│     └── Cannot send to self                                         │
│                                                                      │
│  2. ACQUIRE CONNECTION & BEGIN                                      │
│     └── pool.connect() → BEGIN                                      │
│                                                                      │
│  3. LOCK SENDER WALLET                                              │
│     └── SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE         │
│                                                                      │
│  4. CHECK BALANCE                                                   │
│     ├── If currentBalance < amount:                                 │
│     │   └── Throw INSUFFICIENT_FUNDS                                │
│     └── (Production: funding waterfall for external sources)        │
│                                                                      │
│  5. VERIFY RECEIVER                                                 │
│     ├── SELECT from users WHERE id = receiverId                     │
│     └── If not found: throw RECIPIENT_NOT_FOUND                     │
│                                                                      │
│  6. UPDATE BALANCES                                                 │
│     ├── sender: balance = balance - amount                          │
│     └── receiver: balance = balance + amount                        │
│                                                                      │
│  7. INSERT TRANSFER RECORD                                          │
│     └── INSERT INTO transfers (...) RETURNING *                     │
│                                                                      │
│  8. COMMIT                                                          │
│                                                                      │
│  9. POST-COMMIT (async, don't block response)                       │
│     ├── invalidateBalanceCache(senderId)                            │
│     ├── invalidateBalanceCache(receiverId)                          │
│     ├── Queue: feed-fanout job                                      │
│     └── Queue: notification job (payment_received)                  │
│                                                                      │
│  10. RETURN                                                         │
│      └── { id, sender, receiver, amount, note, status, newBalance } │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Real-Time Updates with WebSocket (8 minutes)

### WebSocket Message Types

**Message Types:**
- payment_received: { transfer, newBalance }
- payment_request: { request }
- request_paid: { requestId, transfer }
- balance_updated: { balance, pendingBalance }
- feed_item: FeedItem

### Frontend WebSocket Client

```
┌─────────────────────────────────────────────────────────────────────┐
│                    WebSocket Client Architecture                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  CONNECTION                                                         │
│  ├── URL: wss://{host}/ws (or ws:// for local dev)                  │
│  ├── On open: reset reconnect attempts                              │
│  ├── On close: attempt reconnect                                    │
│  └── On error: log error                                            │
│                                                                      │
│  RECONNECTION STRATEGY                                              │
│  ├── Max attempts: 5                                                │
│  ├── Base delay: 1000ms                                             │
│  └── Exponential backoff: delay * 2^(attempt-1)                     │
│                                                                      │
│  MESSAGE HANDLERS                                                   │
│  ├── payment_received:                                              │
│  │   ├── walletStore.setBalance(newBalance)                         │
│  │   ├── walletStore.addTransaction(transfer)                       │
│  │   ├── feedStore.prependItem({...transfer, likes: 0})             │
│  │   └── showToast("Payment Received: {sender} sent {amount}")      │
│  │                                                                   │
│  ├── payment_request:                                               │
│  │   ├── requestStore.addReceivedRequest(request)                   │
│  │   └── showToast("Request: {requester} requested {amount}")       │
│  │                                                                   │
│  ├── balance_updated:                                               │
│  │   ├── walletStore.setBalance(balance)                            │
│  │   └── walletStore.setPendingBalance(pendingBalance)              │
│  │                                                                   │
│  └── feed_item:                                                     │
│      └── feedStore.prependItem(item)                                │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Backend WebSocket Handler

```
┌─────────────────────────────────────────────────────────────────────┐
│                    WebSocket Server Architecture                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  UPGRADE HANDLING                                                   │
│  ├── Parse session cookie from request headers                      │
│  ├── verifySession(sessionId) → userId                              │
│  ├── If valid: handleUpgrade → emit 'connection'                    │
│  └── If invalid: socket.destroy()                                   │
│                                                                      │
│  CONNECTION TRACKING                                                │
│  ├── Map<userId, Set<WebSocket>>                                    │
│  │   (one user can have multiple connections - multiple devices)    │
│  ├── On connect: add to map                                         │
│  └── On disconnect: remove from map, cleanup empty sets             │
│                                                                      │
│  SEND TO USER                                                       │
│  ├── Get all connections for userId                                 │
│  ├── For each connection with OPEN state:                           │
│  │   └── ws.send(JSON.stringify(message))                           │
│  └── Handles multi-device delivery                                  │
│                                                                      │
│  NOTIFICATION FUNCTIONS (called after transfer/request)             │
│  ├── notifyPaymentReceived(receiverId, transfer, newBalance)        │
│  │   └── sendToUser(receiverId, { type: 'payment_received', ... })  │
│  │                                                                   │
│  └── notifyPaymentRequest(requesteeId, request)                     │
│      └── sendToUser(requesteeId, { type: 'payment_request', ... })  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Error Handling Across the Stack (5 minutes)

### Error Code Definitions

**Validation Errors:**
- INVALID_AMOUNT: Amount must be between $0.01 and $5,000
- INVALID_RECIPIENT: Cannot send money to yourself
- MISSING_FIELD: Required field is missing

**Business Logic Errors:**
- INSUFFICIENT_FUNDS: Not enough balance for this payment
- DAILY_LIMIT_EXCEEDED: Daily transfer limit reached
- RECIPIENT_NOT_FOUND: Recipient account not found
- ACCOUNT_FROZEN: Account temporarily frozen
- PAYMENT_METHOD_INVALID: Payment method is no longer valid

**System Errors:**
- DATABASE_ERROR: Service temporarily unavailable
- EXTERNAL_SERVICE_ERROR: Bank connection unavailable
- RATE_LIMITED: Too many requests, please slow down

### Backend Error Middleware

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Error Handler Middleware                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. LOG ALL ERRORS                                                  │
│     └── logger.error({ message, stack, requestId, path, userId })   │
│                                                                      │
│  2. HANDLE BY TYPE                                                  │
│                                                                      │
│     ApiError (known business errors):                               │
│     └── Return err.statusCode with { code, message, field }         │
│                                                                      │
│     ZodError (validation failures):                                 │
│     └── Return 400 with { code: VALIDATION_ERROR, errors: [...] }   │
│                                                                      │
│     PostgreSQL 23505 (unique violation):                            │
│     └── Return 409 with { code: DUPLICATE_ENTRY, message }          │
│                                                                      │
│     Unknown errors:                                                 │
│     └── Return 500 with { code: INTERNAL_ERROR, message: generic }  │
│         (Don't leak internal details)                               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Frontend Error Display

```
┌───────────────────────────────────────────────────────────────────┐
│                     Error Display Component                        │
├───────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ [!] Error Title (based on code)                             │  │
│  │     Error message from API                                   │  │
│  │                                                              │  │
│  │     [Try again] (shown for retryable errors)           [X]  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  RETRYABLE CODES:                                                 │
│  ├── DATABASE_ERROR                                               │
│  ├── EXTERNAL_SERVICE_ERROR                                       │
│  └── RATE_LIMITED                                                 │
│                                                                    │
│  TITLE MAPPINGS:                                                  │
│  ├── INSUFFICIENT_FUNDS → "Not Enough Balance"                   │
│  ├── RECIPIENT_NOT_FOUND → "User Not Found"                      │
│  ├── DAILY_LIMIT_EXCEEDED → "Limit Reached"                      │
│  └── EXTERNAL_SERVICE_ERROR → "Connection Issue"                 │
│                                                                    │
└───────────────────────────────────────────────────────────────────┘
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
