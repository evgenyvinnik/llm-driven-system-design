# Payment System - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Problem Statement

Design a payment processing system that:
- Processes credit card, debit card, and bank transfer transactions
- Provides a merchant dashboard for viewing transactions and analytics
- Handles refunds with proper accounting
- Detects fraud in real-time

This answer covers the end-to-end architecture, emphasizing integration between frontend and backend components.

## Requirements Clarification

### Functional Requirements
1. **Payment Processing**: Authorize, capture, void, and refund payments via API
2. **Merchant Dashboard**: View transactions, analytics, and configure webhooks
3. **Idempotent API**: Retry-safe operations preventing double-charges
4. **Real-time Fraud Detection**: Risk scoring with immediate feedback
5. **Webhook Delivery**: Reliable event notifications to merchants

### Non-Functional Requirements
1. **Consistency**: Strong consistency for ledger operations
2. **Latency**: Authorization < 2s, dashboard loads < 2s
3. **Availability**: 99.99% for payment API, 99.9% for dashboard
4. **Security**: PCI-DSS compliance, encrypted data at rest and in transit

### Scale Estimates
- 50M transactions/day = 600 TPS average, 2,000 TPS peak
- 10,000 active merchants using dashboard
- Read-heavy dashboard: 50:1 read:write ratio

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Browser (React Dashboard)                                │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Views: Login │ Transactions │ Analytics │ Webhooks │ Settings        │  │
│  │  State: Zustand stores for transactions, auth, filters                │  │
│  └───────────────────────────────┬───────────────────────────────────────┘  │
│  ┌───────────────────────────────┴───────────────────────────────────────┐  │
│  │  API Service: fetch wrapper with auth, retry, error handling          │  │
│  └───────────────────────────────┬───────────────────────────────────────┘  │
└──────────────────────────────────┼──────────────────────────────────────────┘
                                   │ REST API (JSON)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Express API Server                                    │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Middleware: cors, session, apiKeyAuth, rateLimit, errorHandler       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐ │
│  │  auth.ts        │  │  payments.ts    │  │  webhooks.ts                │ │
│  │  - login        │  │  - create       │  │  - register endpoint        │ │
│  │  - logout       │  │  - capture      │  │  - list deliveries          │ │
│  │  - me           │  │  - refund       │  │  - test webhook             │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────────┘ │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Services: FraudService, LedgerService, WebhookService                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────┐
        ▼                         ▼                     ▼
┌───────────────┐        ┌───────────────┐     ┌───────────────┐
│  PostgreSQL   │        │    Valkey     │     │   RabbitMQ    │
│  Transactions │        │  Idempotency  │     │   Webhooks    │
│  Ledger       │        │  Rate limits  │     │   Settlement  │
│  Merchants    │        │  Sessions     │     │               │
└───────────────┘        └───────────────┘     └───────────────┘
```

## Data Model

### Database Schema

The schema includes three core tables:

**Merchants Table** - Payment system customers with dashboard access:
- id (UUID, primary key)
- name, email (unique), password_hash for dashboard login
- api_key_hash for API authentication
- webhook_url, webhook_secret for event delivery
- default_currency, status, created_at

**Transactions Table** - Payment records with idempotency:
- id (UUID, primary key)
- merchant_id (foreign key to merchants)
- idempotency_key (unique per merchant)
- amount (BIGINT, in cents), currency (3-char code)
- captured_amount, refunded_amount (partial captures/refunds)
- status: pending, authorized, captured, refunded, failed
- fraud_score (INTEGER 0-100), fraud_flags (JSONB array)
- processor_ref, metadata, timestamps

**Ledger Entries Table** - Double-entry accounting:
- id (UUID, primary key)
- transaction_id (foreign key)
- entry_type: debit or credit
- account_type: merchant_pending, merchant_settled, etc.
- amount, currency, created_at

Indexes on (merchant_id, created_at DESC) for efficient dashboard queries.

### Shared TypeScript Interfaces

Types used by both frontend and backend include:

- **Merchant**: id, name, email, default_currency, webhook_url
- **Transaction**: All payment fields including status, fraud_score, fraud_flags
- **TransactionFilters**: status, currency, dateRange, amountRange, search
- **PaymentRequest**: amount, currency, payment_method_id, capture flag, metadata
- **PaymentResponse**: transaction object, fraud_score, optional warnings

## Deep Dive: API Design

### RESTful Endpoints

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API Endpoint Structure                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Authentication (Session-based for dashboard):                               │
│  ├── POST   /api/auth/login         ──▶ Login with email/password           │
│  ├── POST   /api/auth/logout        ──▶ Destroy session                     │
│  └── GET    /api/auth/me            ──▶ Get current merchant                │
│                                                                              │
│  Payments (API key auth via Idempotency-Key header):                        │
│  ├── POST   /v1/payments            ──▶ Create payment                      │
│  ├── POST   /v1/payments/:id/capture──▶ Capture authorized payment          │
│  ├── POST   /v1/payments/:id/refund ──▶ Refund captured payment             │
│  ├── GET    /v1/payments/:id        ──▶ Get payment details                 │
│  └── GET    /v1/payments            ──▶ List payments (paginated)           │
│                                                                              │
│  Webhooks:                                                                   │
│  ├── PUT    /api/webhooks/endpoint  ──▶ Update webhook URL                  │
│  ├── GET    /api/webhooks/deliveries──▶ List delivery attempts              │
│  └── POST   /api/webhooks/test      ──▶ Send test webhook                   │
│                                                                              │
│  Analytics:                                                                  │
│  ├── GET    /api/analytics/revenue  ──▶ Revenue by day/week/month           │
│  └── GET    /api/analytics/summary  ──▶ Dashboard summary stats             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Payment Creation Flow

The payment creation endpoint handles idempotency and fraud scoring:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        POST /v1/payments Flow                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Request ──▶ Extract merchant from API key                                  │
│          ──▶ Extract Idempotency-Key header                                 │
│          ──▶ Parse amount, currency, payment_method_id, capture flag        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 1: Check Idempotency Cache                                    │    │
│  │  Cache key: idempotency:{merchantId}:{idempotencyKey}               │    │
│  │  If cached ──▶ Return cached response (prevents double-charge)      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                         │                                                    │
│                         ▼ (not cached)                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 2: Acquire Distributed Lock                                   │    │
│  │  Lock key: lock:idempotency:{merchantId}:{idempotencyKey}           │    │
│  │  SET NX EX 30 (30-second expiry)                                    │    │
│  │  If lock fails ──▶ Return 409 "Request in progress"                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                         │                                                    │
│                         ▼ (lock acquired)                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 3: Fraud Evaluation                                           │    │
│  │  fraudService.evaluate({amount, currency, ip, merchant_id})         │    │
│  │  Returns score 0-100 and risk flags                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                         │                                                    │
│                         ▼                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 4: Database Transaction                                       │    │
│  │  INSERT transaction with status = capture ? 'captured' : 'authorized'│    │
│  │  If capture: Create ledger entries via ledgerService                │    │
│  │  RETURNING full transaction record                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                         │                                                    │
│                         ▼                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 5: Cache Response                                             │    │
│  │  SETEX cache key with 86400s TTL (24 hours)                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                         │                                                    │
│                         ▼                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 6: Queue Webhook                                              │    │
│  │  Publish to RabbitMQ: webhook.delivery queue                        │    │
│  │  Event type: payment.captured or payment.authorized                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                         │                                                    │
│                         ▼                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 7: Release Lock and Respond                                   │    │
│  │  DEL lock key (in finally block)                                    │    │
│  │  Return 201 with {transaction, fraud_score}                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

"The idempotency flow is critical for payment systems. Network issues can cause duplicate requests - without idempotency, customers get charged twice. The distributed lock prevents race conditions when the same request arrives on multiple servers simultaneously."

## Deep Dive: Transaction Dashboard (Full Stack Flow)

### Frontend: Transaction List Component

The dashboard displays transactions with filters and pagination:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Transaction List UI Structure                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  TransactionFilters                                                   │  │
│  │  ├── Status dropdown (All, Authorized, Captured, Refunded, Failed)   │  │
│  │  ├── Date range picker                                                │  │
│  │  └── Search input (debounced)                                         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Table Header (sticky)                                                │  │
│  │  │ Transaction ID │ Amount │ Status │ Customer │ Date │               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Table Body (scrollable)                                              │  │
│  │  ├── TransactionRow (clickable, navigates to details)                │  │
│  │  ├── TransactionRow                                                   │  │
│  │  ├── TransactionRow                                                   │  │
│  │  └── ... (loading skeleton when fetching)                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Pagination                                                           │  │
│  │  Page 1 of 42  │  [<] [1] [2] [3] ... [42] [>]                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  State Management (Zustand):                                                 │
│  ├── transactions: Transaction[]                                            │
│  ├── totalCount: number                                                     │
│  ├── page, pageSize: pagination state                                       │
│  ├── filters: TransactionFilters                                            │
│  ├── isLoading: boolean                                                     │
│  └── Actions: setFilters, setPage, fetchTransactions                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend: List Transactions with Filters

The API endpoint supports filtering and pagination:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     GET /v1/payments Query Building                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Query Parameters:                                                           │
│  ├── status       ──▶ Filter by transaction status                         │
│  ├── search       ──▶ Search ID or processor_ref (ILIKE %search%)          │
│  ├── start_date   ──▶ Filter created_at >= date                            │
│  ├── end_date     ──▶ Filter created_at <= date                            │
│  ├── page         ──▶ Page number (default 1)                              │
│  └── limit        ──▶ Page size (default 25)                               │
│                                                                              │
│  Query Construction:                                                         │
│  1. Base query: SELECT FROM transactions WHERE merchant_id = :merchantId    │
│  2. Apply filters conditionally (status, search, date range)                │
│  3. ORDER BY created_at DESC                                                │
│  4. LIMIT :limit OFFSET (:page - 1) * :limit                                │
│                                                                              │
│  Parallel count query for pagination:                                        │
│  SELECT count(*) FROM transactions WHERE merchant_id = :merchantId          │
│                                                                              │
│  Response: { data: Transaction[], total, page, limit }                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Refund Flow (Full Stack)

### Frontend: Refund Modal

The refund dialog supports full and partial refunds:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Refund Dialog Layout                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Dialog Header                                                        │  │
│  │  "Refund Transaction"                                                 │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Refund Type Selection                                                │  │
│  │  ( ) Full refund ($150.00)                                           │  │
│  │  ( ) Partial refund                                                   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Amount Input (shown when partial selected)                           │  │
│  │  Max refundable: $150.00                                              │  │
│  │  [ $ ][ 75.00                    ]                                    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Error Display (red background when error occurs)                     │  │
│  │  "Refund amount exceeds available balance"                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Dialog Footer                                                        │  │
│  │  [ Cancel ]                              [ Process Refund ]           │  │
│  │  (outline)                               (primary, shows spinner)     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Component State:                                                            │
│  ├── amount: number (initialized to max refundable)                         │
│  ├── isFullRefund: boolean (default true)                                   │
│  ├── isProcessing: boolean                                                  │
│  └── error: string | null                                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend: Refund Endpoint

The refund endpoint validates and processes the refund:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    POST /v1/payments/:id/refund Flow                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Verify Ownership                                                         │
│     SELECT FROM transactions WHERE id = :id AND merchant_id = :merchantId   │
│     If not found ──▶ 404 "Transaction not found"                            │
│                                                                              │
│  2. Validate Status                                                          │
│     If status != 'captured' ──▶ 400 "Transaction cannot be refunded"        │
│                                                                              │
│  3. Calculate Refund Amount                                                  │
│     refundAmount = request.amount || (amount - refunded_amount)             │
│     maxRefundable = amount - refunded_amount                                │
│     If refundAmount > maxRefundable ──▶ 400 "Exceeds available"             │
│                                                                              │
│  4. Database Transaction:                                                    │
│     ├── UPDATE transactions SET                                             │
│     │   refunded_amount = refunded_amount + :refundAmount                   │
│     │   status = (refunded_amount >= amount) ? 'refunded' : 'captured'      │
│     │   updated_at = NOW()                                                  │
│     │                                                                        │
│     ├── ledgerService.recordRefund(tx, transaction, refundAmount)           │
│     │   (Creates credit/debit entries for refund accounting)                │
│     │                                                                        │
│     └── INSERT INTO audit_log (entity_type, entity_id, action, changes)     │
│                                                                              │
│  5. Queue Webhook                                                            │
│     Publish 'refund.created' event to RabbitMQ                              │
│                                                                              │
│  6. Return updated transaction                                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Fraud Score Display

### Frontend: Risk Assessment Component

The fraud score display uses a gauge visualization:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Fraud Score Display Layout                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Score Gauge (SVG arc)                                                │  │
│  │                                                                       │  │
│  │      ┌─────────────────────────┐                                     │  │
│  │      │     ( ══════ )          │  Score: 45                          │  │
│  │      │         45              │  [ Medium Risk ] (yellow badge)     │  │
│  │      └─────────────────────────┘                                     │  │
│  │                                                                       │  │
│  │  Arc colors by score:                                                │  │
│  │  ├── 0-29   ──▶ Green  (#22c55e) "Low Risk"                          │  │
│  │  ├── 30-69  ──▶ Yellow (#eab308) "Medium Risk"                       │  │
│  │  └── 70-100 ──▶ Red    (#ef4444) "High Risk"                         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Risk Factors (when flags.length > 0)                                │  │
│  │                                                                       │  │
│  │  Risk Factors:                                                        │  │
│  │  ├── ⚠️ High transaction velocity                                    │  │
│  │  ├── ⚠️ Amount significantly above average                           │  │
│  │  └── ⚠️ New geographic location                                      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend: Fraud Service

The fraud evaluation service checks multiple signals:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Fraud Evaluation Algorithm                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Input: { amount, currency, payment_method_id, ip, merchant_id }            │
│  Output: { score: 0-100, flags: string[] }                                  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Check 1: Velocity (transactions per hour)                            │  │
│  │  Key: velocity:{payment_method_id}                                    │  │
│  │  Count recent transactions in sorted set                              │  │
│  │  ├── > 10 transactions ──▶ +30 points, "High transaction velocity"   │  │
│  │  └── > 5 transactions  ──▶ +15 points, "Elevated velocity"           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Check 2: Amount Anomaly                                              │  │
│  │  Compare to average amount for this payment method                    │  │
│  │  If amount > 3x average ──▶ +20 points, "Amount above average"       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Check 3: Geographic Location                                         │  │
│  │  Compare IP location to previous transaction locations                │  │
│  │  If new location ──▶ +15 points, "New geographic location"           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Track this transaction:                                                     │
│  ZADD velocity:{payment_method_id} {timestamp} {timestamp}                  │
│  EXPIRE velocity:{payment_method_id} 3600                                   │
│                                                                              │
│  Return: { score: min(total, 100), flags }                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Session Management

### Backend: Session Configuration

Sessions are stored in Valkey/Redis for scalability:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Session Architecture                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Session Store: RedisStore (connect-redis)                                   │
│  ├── client: Valkey connection                                              │
│  ├── prefix: "sess:"                                                        │
│  └── ttl: 24 hours                                                          │
│                                                                              │
│  Cookie Configuration:                                                       │
│  ├── maxAge: 24 hours                                                       │
│  ├── httpOnly: true (prevents XSS access)                                   │
│  ├── secure: true in production (HTTPS only)                                │
│  └── sameSite: 'lax' (CSRF protection)                                      │
│                                                                              │
│  Session Data:                                                               │
│  ├── merchantId: string (UUID)                                              │
│  ├── email: string                                                          │
│  └── role: 'merchant' | 'admin'                                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Auth State

The auth store manages login state and session checking:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Auth Store (Zustand)                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  State:                                                                      │
│  ├── merchant: Merchant | null                                              │
│  ├── isAuthenticated: boolean                                               │
│  └── isLoading: boolean (true on initial load)                              │
│                                                                              │
│  Actions:                                                                    │
│  ├── checkAuth()    ──▶ GET /api/auth/me                                    │
│  │   ├── Success: Set merchant, isAuthenticated = true                      │
│  │   └── Failure: Clear state, isAuthenticated = false                      │
│  │                                                                           │
│  ├── login(email, password) ──▶ POST /api/auth/login                        │
│  │   └── Set merchant and isAuthenticated on success                        │
│  │                                                                           │
│  └── logout() ──▶ POST /api/auth/logout                                     │
│      └── Clear merchant and isAuthenticated                                 │
│                                                                              │
│  App Bootstrap:                                                              │
│  1. Root layout calls checkAuth() on mount                                  │
│  2. Shows loading spinner while isLoading = true                            │
│  3. Redirects to /login if not authenticated                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Optimistic Updates

### Refund with Rollback

Optimistic updates provide instant feedback with rollback on failure:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Optimistic Refund Flow                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  User clicks "Refund"                                                        │
│         │                                                                    │
│         ▼                                                                    │
│  1. Save Original State                                                      │
│     originalTransaction = selectedTransaction                               │
│     originalList = [...transactions]                                        │
│         │                                                                    │
│         ▼                                                                    │
│  2. Optimistic Update (immediate UI feedback)                                │
│     selectedTransaction.status = 'refunding' (temporary state)              │
│     UI shows processing indicator                                           │
│         │                                                                    │
│         ▼                                                                    │
│  3. API Call                                                                 │
│     await api.refundTransaction(id, amount)                                 │
│         │                                                                    │
│    ┌────┴────┐                                                              │
│    ▼         ▼                                                              │
│  Success   Failure                                                          │
│    │         │                                                              │
│    ▼         ▼                                                              │
│  Apply     Rollback                                                         │
│  actual    selectedTransaction = originalTransaction                        │
│  result    transactions = originalList                                      │
│            throw error (show toast)                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Webhook Configuration Flow

### Frontend: Webhook Settings

The webhook settings page allows merchants to configure and test webhooks:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Webhook Settings Layout                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Card: Webhook Endpoint                                               │  │
│  │                                                                       │  │
│  │  URL:                                                                 │  │
│  │  [ https://your-site.com/webhooks                              ]     │  │
│  │                                                                       │  │
│  │  [ Save ]  [ Send Test ]                                             │  │
│  │  (primary)  (outline, shows "Testing..." during request)            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Card: Recent Deliveries                                              │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │  │
│  │  │ Event: payment.captured     Status: 200 OK      12:34 PM       │ │  │
│  │  │ Event: refund.created       Status: 200 OK      12:30 PM       │ │  │
│  │  │ Event: payment.captured     Status: 500 Error   12:25 PM       │ │  │
│  │  │ (shows retry count and next retry time for failures)           │ │  │
│  │  └─────────────────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend: Webhook Test Endpoint

The test endpoint sends a signed test webhook:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     POST /api/webhooks/test Flow                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Get merchant webhook configuration                                       │
│     SELECT webhook_url, webhook_secret FROM merchants WHERE id = :id        │
│     If no webhook_url ──▶ 400 "No webhook URL configured"                   │
│                                                                              │
│  2. Build test payload                                                       │
│     {                                                                        │
│       id: "test_{timestamp}",                                               │
│       type: "test",                                                         │
│       created_at: ISO timestamp,                                            │
│       data: { message: "This is a test webhook" }                           │
│     }                                                                        │
│                                                                              │
│  3. Generate signature                                                       │
│     HMAC-SHA256(JSON.stringify(payload), webhook_secret)                    │
│     Header: X-Webhook-Signature: sha256={signature}                         │
│                                                                              │
│  4. Send request with 10s timeout                                            │
│     POST to webhook_url with payload and signature                          │
│                                                                              │
│  5. Return result                                                            │
│     {                                                                        │
│       success: boolean (response.ok),                                       │
│       status_code: number,                                                  │
│       response_time_ms: number,                                             │
│       error?: string (if request failed)                                    │
│     }                                                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Session + API key auth | Familiar patterns for both | Two auth systems to maintain |
| Zustand for state | Simple, less boilerplate | No server cache like React Query |
| Optimistic updates | Instant UI feedback | Rollback complexity |
| PostgreSQL sessions | Simpler than Redis | Slower, but acceptable |
| Valkey for idempotency | Fast, TTL built-in | Additional infrastructure |
| RabbitMQ for webhooks | Reliable, DLQ support | More complex than direct HTTP |

## Scalability Path

### Current: Single Server

```
┌──────────┐     ┌──────────────────┐     ┌──────────────────────────────┐
│ Browser  │────▶│ Express (Node.js)│────▶│ PostgreSQL + Valkey          │
└──────────┘     └──────────────────┘     └──────────────────────────────┘
```

### Future: Scaled

```
┌──────────┐     ┌─────┐     ┌──────────────┐     ┌──────────────────────┐
│ Browser  │────▶│ CDN │────▶│Load Balancer │────▶│ Express (5 nodes)    │
└──────────┘     └─────┘     └──────────────┘     └──────────┬───────────┘
                                                             │
                                                             ▼
                                                  ┌──────────────────────┐
                                                  │   Valkey Cluster     │
                                                  └──────────┬───────────┘
                                                             │
                                                             ▼
                                                  ┌──────────────────────┐
                                                  │ PostgreSQL Primary   │
                                                  │ + Read Replicas      │
                                                  └──────────────────────┘
```

1. **Stateless API servers**: Sessions in Valkey enable horizontal scaling
2. **Read replicas**: Route dashboard queries to replicas
3. **CDN**: Cache static assets and potentially API responses
4. **Connection pooling**: PgBouncer for high connection counts

## Future Enhancements

1. **Real-time Updates**: WebSocket for live transaction feed
2. **Export Features**: CSV/PDF export for transaction reports
3. **Multi-Currency Analytics**: Currency conversion in charts
4. **Advanced Fraud Rules**: Custom rule builder in dashboard
5. **Mobile App**: React Native for transaction monitoring
