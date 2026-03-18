# Design Apple Pay - Architecture

## System Overview

Apple Pay is a mobile payment system using tokenization and biometric authentication. Core challenges involve secure tokenization, NFC transactions, and network integration.

**Learning Goals:**
- Build payment tokenization systems
- Design hardware-backed security
- Implement NFC payment protocols
- Handle multi-network integration

---

## Requirements

### Functional Requirements

1. **Provision**: Add cards to wallet
2. **Pay**: NFC and in-app payments
3. **Authenticate**: Biometric verification
4. **Track**: Transaction history
5. **Manage**: Card lifecycle

### Non-Functional Requirements

- **Security**: Hardware-backed token storage
- **Latency**: < 500ms for NFC payment
- **Availability**: 99.99% for transactions
- **Privacy**: Card number never shared with merchant

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     iPhone/Apple Watch                          │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Wallet App   │  │ Secure Element│  │   NFC Radio   │       │
│  │               │  │               │  │               │       │
│  │ - Cards       │  │ - Token store │  │ - Contactless │       │
│  │ - History     │  │ - Crypto ops  │  │ - Reader comm │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│        (TLS termination, rate limiting, auth routing)           │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Provisioning  │    │  Transaction  │    │  Token        │
│ Service       │    │  Service      │    │  Lifecycle    │
│               │    │               │    │  Service      │
│ - Card add    │    │ - NFC pay     │    │               │
│ - Network TSP │    │ - In-app pay  │    │ - Suspend     │
│ - SE provisn  │    │ - Cryptogram  │    │ - Reactivate  │
│               │    │ - Auth route  │    │ - Refresh     │
└───────────────┘    └───────────────┘    │ - Lost device │
         │                    │            └───────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │   Redis/Valkey    │   External Networks       │
│   - Cards       │   - Sessions      │   - Visa TSP              │
│   - Transactions│   - Token cache   │   - Mastercard TSP        │
│   - Audit logs  │   - ATC watermark │   - Amex TSP              │
│   - Merchants   │   - Rate limits   │   - Issuing banks         │
│   - ATC table   │   - Idempotency   │                           │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Card Provisioning

When a user adds a card to Apple Pay, the provisioning flow:

1. **Card validation**: Identify the card network (Visa/Mastercard/Amex) from the PAN prefix (BIN range)
2. **Network TSP request**: Send encrypted PAN to the network's Token Service Provider, which returns a device-specific token (DPAN) and cryptographic key material
3. **Store token reference**: The server stores only the `token_ref` (reference ID), `last4`, `network`, and `card_type`. The actual token and cryptographic keys are stored in the device's Secure Element
4. **Secure Element provisioning**: Token data is sent to the device's SE through an encrypted channel, establishing a secure session with ephemeral keys

Each device gets a unique token for the same physical card. Losing one device does not compromise tokens on other devices. Per-device revocation is immediate.

### 2. NFC Payment Flow

The NFC payment completes in under 500ms:

1. Device detects payment terminal via NFC
2. Terminal sends merchant data (amount, currency, merchant ID, unpredictable number)
3. Device requests biometric authentication (Face ID / Touch ID)
4. Secure Element generates a one-time cryptogram using the token's key and transaction data
5. Device transmits EMV payment data via NFC: the device-specific token (not the real PAN), the cryptogram, ECI (Electronic Commerce Indicator), and Application Transaction Counter (ATC)
6. Terminal forwards to acquirer, then to card network
7. Network validates the cryptogram with its TSP, de-tokenizes to the real PAN, and routes authorization to the issuing bank
8. Authorization response flows back through the chain

The cryptogram is a MAC computed over the amount, merchant ID, unpredictable number, and ATC using 3DES or AES with a key that never leaves the Secure Element. The ATC increments monotonically, providing natural replay protection -- any reused cryptogram with a stale ATC is rejected.

### 3. In-App Payment

For in-app purchases, the merchant's app presents a payment sheet. The flow:

1. Merchant creates a payment session with supported networks and total amount
2. User authenticates with biometric
3. Device generates a payment token encrypted with the merchant's public key
4. Merchant's server decrypts the token, extracts the DPAN and cryptogram
5. Merchant sends authorization request to their payment processor
6. Processor routes through the network for de-tokenization and bank authorization

The merchant never sees the real card number -- they receive only the device-specific token, which is useless without the per-transaction cryptogram.

### 4. Token Lifecycle Management

Tokens require active management:

- **Suspend**: When a user reports a card lost/stolen, all tokens for that card are suspended across all devices. The network and SE are notified.
- **Reactivate**: After verification (e.g., bank confirms card is found), tokens are reactivated.
- **Refresh**: Tokens have expiration dates. Before expiry, the system requests new token material from the network and provisions it to the SE.
- **Lost device**: All tokens on the lost device are suspended immediately. Other devices' tokens remain active. This is the key advantage of per-device tokenization.
- **Card update**: When the physical card is reissued (new expiry, new PAN), the network pushes token updates to all provisioned devices.

### 5. Transaction Processing (Server-Side)

The server-side transaction service:

1. Looks up the token in the vault to identify the card and user
2. Validates the cryptogram with the card network's TSP
3. Verifies the ATC is strictly greater than the last known value (replay prevention)
4. Routes the authorization to the issuing bank via the card network
5. Logs the transaction with audit trail
6. Updates the ATC watermark in both Redis (fast reads) and PostgreSQL (durability)

---

## Database Schema

```sql
-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Devices table (simulates iPhone/Apple Watch)
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(255) NOT NULL,
  device_type VARCHAR(50) NOT NULL, -- iphone, apple_watch, ipad
  secure_element_id VARCHAR(100) UNIQUE NOT NULL, -- Simulated SE identifier
  status VARCHAR(20) DEFAULT 'active',
  last_active_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_devices_user ON devices(user_id);

-- Provisioned Cards (tokens)
CREATE TABLE IF NOT EXISTS provisioned_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_ref VARCHAR(100) UNIQUE NOT NULL, -- Reference to token
  token_dpan VARCHAR(16) NOT NULL, -- Device PAN (tokenized)
  network VARCHAR(20) NOT NULL, -- visa, mastercard, amex
  last4 VARCHAR(4) NOT NULL,
  card_type VARCHAR(20), -- credit, debit
  card_holder_name VARCHAR(255),
  expiry_month INTEGER NOT NULL,
  expiry_year INTEGER NOT NULL,
  card_art_url VARCHAR(500),
  is_default BOOLEAN DEFAULT false,
  status VARCHAR(20) DEFAULT 'active',
  suspended_at TIMESTAMP,
  suspend_reason VARCHAR(100),
  provisioned_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cards_user ON provisioned_cards(user_id);
CREATE INDEX idx_cards_device ON provisioned_cards(device_id);
CREATE INDEX idx_cards_token_ref ON provisioned_cards(token_ref);

-- Merchants
CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  category_code VARCHAR(4),
  merchant_id VARCHAR(50) UNIQUE NOT NULL,
  public_key TEXT, -- For encrypting payment tokens
  webhook_url VARCHAR(500),
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Transactions
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES provisioned_cards(id),
  merchant_id UUID REFERENCES merchants(id),
  token_ref VARCHAR(100) NOT NULL,
  cryptogram VARCHAR(100),
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  status VARCHAR(20) NOT NULL, -- pending, approved, declined, refunded
  auth_code VARCHAR(20),
  decline_reason VARCHAR(100),
  transaction_type VARCHAR(20) NOT NULL, -- nfc, in_app, web
  merchant_name VARCHAR(200),
  merchant_category VARCHAR(100),
  location VARCHAR(200),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transactions_card ON transactions(card_id, created_at DESC);
CREATE INDEX idx_transactions_token ON transactions(token_ref, created_at DESC);
CREATE INDEX idx_transactions_merchant ON transactions(merchant_id);

-- Biometric Auth Sessions (simulated)
CREATE TABLE IF NOT EXISTS biometric_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  auth_type VARCHAR(20) NOT NULL, -- face_id, touch_id, passcode
  status VARCHAR(20) NOT NULL, -- pending, verified, failed
  challenge VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  verified_at TIMESTAMP,
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '5 minutes'
);

CREATE INDEX idx_biometric_user ON biometric_sessions(user_id);

-- Audit Logs (PCI-DSS compliance)
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email VARCHAR(255),
  action VARCHAR(100) NOT NULL, -- 'payment.approved', 'card.suspended'
  resource_type VARCHAR(50) NOT NULL, -- 'transaction', 'card', 'user'
  resource_id VARCHAR(100),
  result VARCHAR(20) NOT NULL, -- 'success', 'failure', 'error'
  ip_address VARCHAR(45),
  user_agent TEXT,
  session_id VARCHAR(100),
  request_id VARCHAR(100), -- Correlation with application logs
  metadata JSONB DEFAULT '{}', -- Additional context (redacted)
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_result ON audit_logs(result, created_at DESC);

-- Token ATC (Application Transaction Counter)
-- Write-through caching: updated in both Redis and PostgreSQL
CREATE TABLE IF NOT EXISTS token_atc (
  token_ref VARCHAR(100) PRIMARY KEY,
  last_atc INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_token_atc_updated ON token_atc(updated_at DESC);
```

### Schema Design Rationale

**Device table**: Simulates the hardware inventory. The `secure_element_id` is unique per device, modeling the real SE that stores cryptographic keys. Device status enables lost-device flows.

**Provisioned cards with token_ref**: The server never stores the actual DPAN cryptographic material -- only a reference (`token_ref`) used to communicate with the card network's TSP. The real token lives in the Secure Element. `token_dpan` is stored for display purposes (the tokenized PAN, not the real PAN).

**Audit logs with ON DELETE SET NULL**: Audit records survive user deletion. `metadata` is JSONB for flexible context but is automatically redacted of sensitive data (PAN, CVV) before storage.

**ATC table with write-through**: The ATC is critical for replay prevention. Write-through ensures both Redis (for fast reads during payment validation) and PostgreSQL (for durability across restarts) are always in sync.

---

## API Design

### Authentication

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/register` | Register user account |
| POST | `/api/auth/login` | Login, create session |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/auth/me` | Current user profile |
| POST | `/api/auth/devices` | Register device |

### Cards

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/cards` | List provisioned cards |
| POST | `/api/cards` | Provision new card |
| GET | `/api/cards/:id` | Card details |
| POST | `/api/cards/:id/suspend` | Suspend card token |
| POST | `/api/cards/:id/reactivate` | Reactivate suspended token |
| DELETE | `/api/cards/:id` | Remove card from wallet |
| POST | `/api/cards/:id/default` | Set as default payment card |

### Payments

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/payments/pay` | Process NFC or in-app payment |
| GET | `/api/payments/transactions` | Transaction history |
| GET | `/api/payments/transactions/:id` | Transaction details |
| POST | `/api/payments/biometric` | Initiate biometric auth session |
| POST | `/api/payments/biometric/verify` | Verify biometric challenge |

### Merchants

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/merchants` | List merchants |
| GET | `/api/merchants/:id` | Merchant details with transactions |
| POST | `/api/merchants/:id/refund` | Process refund |

---

## Key Design Decisions

### 1. Device-Specific Tokens

**Decision**: Each device gets a unique token for the same physical card, rather than sharing one token across devices.

**Why it works**: When a user loses their iPhone, only that device's token is suspended. Their Apple Watch continues to work. The card network knows exactly which device transacted, enabling per-device fraud analysis. Revocation is instant and targeted.

**Why shared tokens fail**: A single shared token means losing any device compromises all devices. Suspending the token disables payments everywhere. The user must re-provision all devices after finding the lost one. This is unacceptable UX for a payment system where availability directly impacts daily life.

**Trade-off**: More tokens to manage per card (one per device). The provisioning service must handle token-per-device creation, and the lifecycle service must track which devices have which tokens. Storage cost is negligible (a few KB per token reference).

### 2. Hardware Secure Element Storage

**Decision**: Store tokens and cryptographic keys in the device's hardware Secure Element, not in software.

**Why it works**: Keys in the SE cannot be extracted even with root access to the OS. Cryptogram generation happens in tamper-resistant hardware. This is the foundation of Apple Pay's security model -- the SE is a separate chip with its own processor and encrypted memory.

**Why software storage fails**: Software keystores can be compromised by OS-level exploits, jailbreaks, or malware. A compromised cryptographic key allows an attacker to generate valid payment cryptograms indefinitely. For a payment system handling billions of dollars, this risk is unacceptable.

**Trade-off**: SE operations are slower than software crypto (~50ms vs ~1ms). We mitigate this with pre-generated cryptograms: the SE generates the next cryptogram before the user taps, so NFC payment feels instant.

### 3. Dynamic One-Time Cryptograms

**Decision**: Generate a unique cryptogram for every transaction rather than reusing static credentials.

**Why it works**: Even if an attacker intercepts the NFC communication, they capture a token + cryptogram pair that is valid for only one transaction. The cryptogram is bound to the specific amount, merchant, and an unpredictable number from the terminal. Replaying it fails because the ATC has advanced.

**Why static credentials fail**: Static card credentials (PAN + expiry + CVV) can be reused for any transaction once captured. This is why card skimming works with magnetic stripe cards. Dynamic cryptograms make each transaction cryptographically unique.

**Trade-off**: Requires the card network to validate every cryptogram, adding a network round-trip (~20ms) to the authorization flow. For the NFC use case (< 500ms budget), this is acceptable. The ATC watermark in Redis provides sub-millisecond replay detection locally.

---

## Consistency and Idempotency

### Consistency Model

| Operation | Consistency Level | Rationale |
|-----------|------------------|-----------|
| Card provisioning | Strong (serializable) | Must prevent duplicate tokens |
| Transaction authorization | Strong (serializable) | Financial accuracy |
| Transaction history reads | Eventual (read-your-writes) | Performance acceptable |
| Token status updates | Strong | Security-critical |

### Idempotency Implementation

All mutation endpoints require an `Idempotency-Key` header. The flow:

1. Client provides unique `Idempotency-Key`
2. Middleware checks Redis for existing result
3. Found + completed: return cached response (`X-Idempotency-Replayed: true`)
4. Found + in-progress: return 409 Conflict
5. Not found: acquire Redis lock (60s TTL), execute operation, cache result for 24 hours
6. On failure: release lock, allowing retry

**Protected endpoints:**
- `POST /api/payments/pay` -- prevents double-charging
- `POST /api/cards` -- prevents duplicate card provisioning
- `POST /api/merchants/:id/refund` -- prevents double-refunds
- All card state mutations (suspend, reactivate, remove)

### Conflict Resolution

- **Same card on same device**: Reject (unique constraint on user_id + device_id + last4 + network)
- **Same card on different device**: Allow (per-device tokens by design)
- **Concurrent provisioning**: First-write-wins via database unique constraint
- **Suspend vs. active payment**: Suspend takes precedence (security)
- **Multiple suspend requests**: Idempotent (no-op if already suspended)

### Application Transaction Counter (ATC)

The ATC in the Secure Element provides natural replay protection:

- Each transaction increments the ATC monotonically
- The server stores the last known ATC per token (Redis + PostgreSQL write-through)
- If a claimed ATC is less than or equal to the stored value, the transaction is rejected as a replay
- ATC gaps are allowed (the SE may have been used for failed transactions locally)

---

## Caching Strategy

### Cache Architecture

```
   Client Request
         │
         ▼
┌─────────────────┐    Cache Miss    ┌─────────────────┐
│   Edge Cache    │ ───────────────▶ │   Application   │
│   (CDN Layer)   │                  │     Server      │
│                 │ ◀─────────────── │                 │
│ Static assets   │    Cache Fill    │                 │
│ Card art images │                  │                 │
└─────────────────┘                  └────────┬────────┘
                                              │
                                              ▼
                                     ┌─────────────────┐
                                     │  Valkey/Redis   │
                                     │  (L2 Cache)     │
                                     │                 │
                                     │ - Token lookups │
                                     │ - Sessions      │
                                     │ - ATC watermarks│
                                     │ - Rate limits   │
                                     └────────┬────────┘
                                              │ Cache Miss
                                              ▼
                                     ┌─────────────────┐
                                     │   PostgreSQL    │
                                     │  (Source of     │
                                     │   Truth)        │
                                     └─────────────────┘
```

### Caching by Data Type

| Data Type | Pattern | TTL | Invalidation |
|-----------|---------|-----|--------------|
| Active token lookup | Cache-aside | 5 min | On status change |
| Suspended token | No cache | - | - |
| User's card list | Cache-aside | 2 min | On add/remove |
| Transaction history | Cache-aside | 30 sec | On new transaction |
| Card art images | CDN/write-through | 24 hours | On card update |
| ATC watermarks | Write-through | No expiry | On every transaction |

**Critical rule**: Suspended tokens are never cached. A cached "active" status for a suspended token could allow a fraudulent payment to proceed.

---

## Security and Auth

### Authentication Flow

Session-based authentication with express-session backed by Redis. Cookies are `httpOnly` to prevent XSS access. Sessions enable immediate revocation on security events.

### Biometric Simulation

The system simulates the biometric authentication flow:
1. Client requests a biometric challenge
2. Server generates a challenge token with 5-minute expiry
3. Client "verifies" biometric (simulated) and returns signed challenge
4. Server validates the challenge and marks the session as authenticated

In production, this happens entirely on-device in the Secure Element with Face ID / Touch ID.

### PCI-DSS Considerations

- **Cardholder data**: The server never stores full PANs. Only `last4` and `token_ref` are persisted. The real PAN exists only at the card network's TSP.
- **Audit trail**: All card access and payment operations are logged to `audit_logs` with IP, user agent, and request correlation.
- **Sensitive data redaction**: Logs automatically mask any PAN, CVV, or token data that might appear in error messages or request bodies.

---

## Observability

### Prometheus Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `http_request_duration_seconds` | Histogram | API latency (p50/p95/p99) |
| `payment_transactions_total` | Counter | Transactions by status, type, network |
| `payment_duration_seconds` | Histogram | End-to-end payment latency |
| `circuit_breaker_state` | Gauge | Network health (0=closed, 1=half-open, 2=open) |
| `idempotency_cache_operations_total` | Counter | Cache hit/miss rates |
| `card_provisioning_total` | Counter | Provisioning by network, result |

### SLI/SLO Targets

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| NFC payment latency (p99) | < 500ms | > 500ms for 2 min |
| Transaction approval rate | > 95% | < 90% for 5 min |
| API availability | 99.99% | < 99.9% for 5 min |
| Idempotency cache hit rate (retries) | > 99% | < 95% for 10 min |

### Structured Logging

JSON-formatted logs via Pino with request correlation. Sensitive data redaction prevents PAN, CVV, or token material from appearing in log output. Separate audit logger for compliance-grade event tracking.

---

## Failure Handling

### Circuit Breaker for Payment Networks

Each card network has an independent circuit breaker:

| Network | Timeout | Error Threshold | Reset Timeout |
|---------|---------|-----------------|---------------|
| Visa | 10s | 50% errors | 30s |
| Mastercard | 10s | 50% errors | 30s |
| Amex | 10s | 50% errors | 30s |

When a circuit opens, the system returns a graceful decline:

```
{ approved: false, network: "visa", responseCode: "CB", declineReason: "Network temporarily unavailable" }
```

This prevents cascading failures: without circuit breakers, requests to a failing network queue up, exhaust connection pools, and bring down the entire system. With circuit breakers, only the affected network's transactions fail fast while other networks continue normally.

### Health Checks

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `/health/live` | Liveness probe | Process is running |
| `/health/ready` | Readiness probe | PostgreSQL + Redis connectivity |
| `/health` or `/health/deep` | Detailed status | Component latency, circuit breaker state |

---

## Scalability Considerations

### What Breaks First

1. **Transaction write volume**: Flash sales (e.g., iPhone launch day) spike payment volume 10-100x. Solution: horizontal scaling of stateless transaction service instances, sharding by `token_ref` hash.

2. **ATC validation reads**: Every transaction reads the ATC watermark. Solution: Redis as primary read path with write-through to PostgreSQL for durability.

3. **Token vault lookups**: Token validation on every payment. Solution: cache-aside with 5-minute TTL for active tokens.

### Sharding Strategy

At production scale (500M daily transactions):
- **Primary shard key**: `token_ref` hash (distributes across token usage patterns)
- **Time-based partitioning**: Monthly partitions for `transactions` table
- **Shard count**: 16 shards handles 500M daily transactions
- Audit logs partitioned by month with 7-year retention

### Horizontal Scaling Path

- **API servers**: Stateless; scale behind load balancer
- **PostgreSQL**: Shard by token_ref; read replicas for transaction history queries
- **Redis**: Redis Cluster with 16+ shards
- **Network integration**: Connection pooling to each TSP; independent scaling per network

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Token storage | Secure Element | Software keychain | Hardware tamper resistance |
| Token scope | Per-device | Shared across devices | Targeted revocation |
| Auth method | Biometric + SE | PIN only | Security + UX |
| Cryptogram | Dynamic (one-time) | Static credentials | Replay protection |
| Token cache | Cache-aside, 5 min TTL | No cache | Latency vs freshness |
| ATC storage | Write-through Redis+PG | Cache-aside | Durability critical for replay prevention |
| Idempotency | Redis with 24h TTL | Database only | Performance for high-frequency payment retries |
| Transaction consistency | Serializable | Read-committed | Financial accuracy required |

---

## Frontend Architecture

This section documents the React frontend implementation: component hierarchy, state management, routing, data fetching, and key UI patterns.

### Component Hierarchy

```
__root.tsx (RootComponent)
└── Outlet ─── child route content
    ├── index.tsx (Wallet) ─── card carousel, card management
    │   ├── CreditCard ─── visual card rendering (network logo, last4, status)
    │   └── AddCardForm ─── card provisioning form with test card buttons
    ├── pay.tsx (PayPage) ─── payment flow
    │   ├── CreditCard ─── selected card display
    │   └── BiometricModal ─── Face ID / Touch ID simulation
    ├── transactions.tsx ─── transaction history with filtering
    │   └── TransactionItem ─── individual transaction row
    ├── merchant.tsx ─── merchant terminal simulation
    ├── login.tsx ─── email/password login
    └── Layout ─── shared layout wrapper (header, navigation tabs)
```

The application uses a `Layout` component that provides a consistent header with the page title and a bottom tab bar for navigation between Wallet, Pay, Transactions, and Merchant views. This mimics the iOS tab bar navigation pattern used in the real Apple Wallet app.

### Zustand Stores

The stores are all defined in a single file (`frontend/src/stores/index.ts`) and organized by domain:

**`authStore`** -- Manages user session and device registration. Uses `zustand/middleware/persist` to save the `sessionId` to localStorage for session recovery across page reloads. Unlike the cookie-based auth used by Apple Music and Apple TV, this project uses an explicit `X-Session-Id` header, which the API service attaches to every request. Actions include `login`, `register`, `logout`, `loadUser` (session recovery), `loadDevices`, and `registerDevice`. Device management is critical because each card is provisioned to a specific device.

**`walletStore`** -- Manages the user's provisioned payment cards. Holds `cards` array and `selectedCard`. Actions include `loadCards`, `addCard` (provisions a new card to a device), `suspendCard`, `reactivateCard`, `removeCard`, `setDefaultCard`, and `selectCard`. Most mutation actions call the API and then call `loadCards()` to refresh the full card list from the server, ensuring consistency after operations that change card status.

**`transactionStore`** -- Manages transaction history with pagination. Holds `transactions` array, `total` count, and loading state. The `loadTransactions` action accepts optional filter parameters (`limit`, `offset`, `card_id`, `status`) for paginated and filtered transaction queries.

**`paymentStore`** -- Manages the biometric authentication and payment processing flow. Holds `biometricSession` (the current authentication session ID), `isAuthenticating`, and `isProcessing` flags. Actions include `initiateBiometric` (starts a biometric challenge), `simulateBiometric` (simulates successful biometric verification for demo purposes), `processPayment` (sends the payment to the backend), and `clearBiometricSession`. The biometric session ID is stored in `sessionStorage` (not localStorage) so it expires when the browser tab closes, matching the transient nature of a real biometric authentication.

### Routing

Uses TanStack Router with file-based routing. The route structure is flat (no nested dynamic routes) since the app is wallet-centric rather than content-centric. The root route (`__root.tsx`) attempts to load the user from the stored session on mount via `authStore.loadUser()`.

### Data Fetching

API calls go through `services/api.ts`, which exports a single `api` object with methods grouped by resource (Auth, Devices, Cards, Payments, Merchants). The `request` helper function automatically attaches two custom headers from browser storage:
- `X-Session-Id` from localStorage -- identifies the authenticated user session
- `X-Biometric-Session` from sessionStorage -- proves the user completed biometric authentication for the current tab session

This header-based approach (as opposed to httpOnly cookies) is used because the real Apple Pay system uses device-specific authentication tokens rather than browser cookies.

### Key UI Pattern: Payment Flow

The payment flow is the core user interaction, simulating the Apple Pay in-app purchase experience. It orchestrates four stores and a modal dialog across multiple async steps.

**Payment flow sequence:**
1. **Card selection** -- The `PayPage` loads all active cards via `walletStore.loadCards()`. The default card is pre-selected. If the user has multiple cards, a dropdown allows switching.
2. **Merchant selection** -- Available merchants are fetched from the backend on mount. The user selects who they are paying.
3. **Amount entry** -- A large currency input with quick-select buttons ($5, $10, $25, $50, $100). Test amounts trigger specific scenarios ($666.66 = insufficient funds, $999.99 = declined, >$10,000 = limit exceeded).
4. **Biometric authentication** -- Clicking "Pay with Apple Pay" initiates the biometric flow:
   a. `paymentStore.initiateBiometric(deviceId, 'face_id')` creates a biometric session on the server
   b. The `BiometricModal` opens, showing a Face ID scanning animation (SVG with CSS animation)
   c. The user clicks "Simulate Success" (since real biometrics are not available in a browser)
   d. `paymentStore.simulateBiometric(sessionId)` verifies the biometric session on the server
   e. The session ID is stored in `sessionStorage` so subsequent API calls include it in the `X-Biometric-Session` header
5. **Payment processing** -- After biometric success, `paymentStore.processPayment` sends the card ID, amount, currency, merchant ID, and transaction type to `/api/payments/pay`. The backend validates the biometric session, generates a cryptogram, checks the ATC, and processes the payment.
6. **Result display** -- Success shows the auth code; failure shows the decline reason. Transaction history is refreshed to include the new transaction.

**BiometricModal component:**
The modal simulates three authentication types: Face ID (SVG face with scanning animation), Touch ID (fingerprint icon), and passcode (asterisks). It follows a two-phase interaction: first showing the authentication prompt with a "Simulate Success" button, then briefly showing a green checkmark before calling the `onSuccess` callback. The 1-second delay on success provides visual feedback that authentication was verified.

**CreditCard component:**
Renders a styled card display showing the network logo (Visa/Mastercard/Amex), last 4 digits, card type (credit/debit), holder name, and status. Suspended cards display a visual indicator. The component is used in both the Wallet page (card carousel) and the Pay page (selected card display).

**AddCardForm component:**
Provides a card provisioning form with PAN input (auto-formatted with spaces every 4 digits), expiry month/year dropdowns, CVV input, and holder name. Includes "test card" buttons that pre-fill valid test numbers for Visa (4111...), Mastercard (5555...), and Amex (3782...) to streamline demo usage.

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, written for readers who may not have encountered these patterns before.

### Role-Based Access Control (RBAC)

**What it is:** RBAC is a method of restricting system access based on the roles assigned to individual users. Instead of granting permissions directly to each user, you assign users to roles, and roles carry predefined sets of permissions. When the system needs to decide whether a user can perform an action, it checks the user's role against the required permission.

**How it works in this project:** Users have a `role` column (`'user'` or `'admin'`). Regular users can provision cards, make payments, and view their own transaction history. Admin access would enable user management, merchant onboarding, and system-wide transaction monitoring. The audit log records the role of the user performing each action for compliance tracing.

**Why it matters at scale:** In a payment system, access control is not just a convenience feature -- it is a regulatory requirement. PCI-DSS mandates that access to cardholder data be restricted on a need-to-know basis. RBAC provides the auditable structure to prove that only authorized personnel can access sensitive operations (e.g., viewing transaction details, suspending cards across users, modifying merchant configurations).

### Redis Cache-Aside

**What it is:** Cache-aside (also called "lazy loading") is a caching strategy where the application checks a cache before querying the primary database. If the data is in the cache (a "hit"), the cached value is returned immediately. If not (a "miss"), the application queries the database, stores the result in the cache with a TTL, and returns it.

**How it works in this project:** The caching strategy is documented in the Caching Strategy section above. Token lookups are cached for 5 minutes with a critical exception: suspended tokens are never cached. The ATC watermark uses a different pattern -- write-through caching rather than cache-aside -- because both Redis (for fast reads) and PostgreSQL (for durability) must always reflect the current ATC value. Transaction history is cached for 30 seconds. The user's card list is cached for 2 minutes with invalidation on add/remove operations.

**Why it matters at scale:** Every NFC payment requires a token lookup to validate the DPAN and check the card's status. At 500M daily transactions, that is ~5,800 lookups per second. Without caching, this would saturate the database's connection pool. Redis serves these lookups in sub-millisecond time. The "never cache suspended tokens" rule is critical for security: if a suspended token were served from cache, a stolen device could complete fraudulent transactions during the cache TTL window.

### Circuit Breaker (Opossum)

**What it is:** A circuit breaker is a stability pattern that prevents an application from repeatedly trying to execute an operation that is likely to fail. It works like an electrical circuit breaker: when failures exceed a threshold, the circuit "opens" and subsequent calls fail immediately without attempting the operation. After a timeout period, the circuit enters "half-open" state where test requests are allowed through. If they succeed, normal operation resumes.

The three states are:
- **Closed** (normal): requests pass through. If the failure rate exceeds the threshold, the circuit opens.
- **Open** (failing fast): all requests immediately return a fallback response without contacting the downstream service.
- **Half-open** (testing): a limited number of requests are allowed through to test recovery.

**How it works in this project (`backend/src/shared/circuit-breaker.ts`):** Each card network (Visa, Mastercard, Amex) has an independent circuit breaker with 10s timeout, 50% error threshold, and 30s reset. When a network's circuit opens, transactions for that network fail with a graceful decline (`responseCode: "CB"`, `declineReason: "Network temporarily unavailable"`). Transactions on other networks continue normally. Circuit state is exposed via the `/health` endpoint and as a Prometheus gauge metric.

**Why it matters at scale:** Payment networks occasionally experience outages. Without circuit breakers, if the Visa network goes down, every Visa transaction hangs for 10 seconds (the timeout), consuming a connection and a thread. Under load, all connections are consumed waiting for the dead network, and Mastercard and Amex transactions also start failing -- not because those networks are down, but because the application has no resources left to process them. This is cascading failure. The per-network circuit breaker isolates the blast radius: only Visa transactions fail fast, while other networks continue operating normally.

### Structured Logging (Pino)

**What it is:** Structured logging means emitting log entries as machine-parseable JSON objects instead of free-form text strings. Each log entry contains a consistent set of fields that log aggregation systems can index and search.

**How it works in this project (`backend/src/shared/logger.ts`):** Pino outputs JSON with `requestId` correlation, service context, and user identification. A critical addition for a payment system is automatic sensitive data redaction: the logger filters out PAN (card numbers), CVV, and token material from any log output. This prevents cardholder data from appearing in log files, which would be a PCI-DSS violation. Audit events (payment approved, card suspended, login attempt) are logged to a separate audit channel backed by the `audit_logs` database table.

**Why it matters at scale:** Payment systems have strict compliance requirements. PCI-DSS requires that all access to cardholder data be logged, but also requires that cardholder data not be stored in log files. Structured logging with automatic redaction satisfies both requirements: the audit log records who accessed what and when, while the redaction middleware ensures that no PAN or CVV appears in application logs. During incident investigation, the `requestId` correlation traces a payment through the entire chain (biometric auth, token lookup, ATC check, network authorization) across log entries.

### Prometheus Metrics

**What it is:** Prometheus is a time-series monitoring system that scrapes metrics from application endpoints at regular intervals and stores them for querying and alerting.

**How it works in this project (`backend/src/shared/metrics.ts`):** Key metrics include: `http_request_duration_seconds` (histogram for API latency), `payment_transactions_total` (counter by status, type, and network), `payment_duration_seconds` (histogram for end-to-end payment latency), `circuit_breaker_state` (gauge per network: 0=closed, 1=half-open, 2=open), `idempotency_cache_operations_total` (counter for cache hit/miss), and `card_provisioning_total` (counter by network and result). The SLO targets -- NFC payment p99 < 500ms, transaction approval rate > 95%, API availability 99.99% -- are only enforceable because these metrics exist.

**Why it matters at scale:** A payment system that processes 500M daily transactions must detect problems in seconds, not minutes. If the Visa circuit breaker opens, the `circuit_breaker_state{network="visa"}` gauge changes from 0 to 2, and an alert fires within the next Prometheus scrape interval (15 seconds). If payment latency p99 exceeds 500ms, the team investigates before the SLO is breached. Without metrics, the first signal of a problem is merchants calling to report that their customers' payments are failing.

### Rate Limiting

**What it is:** Rate limiting restricts how many requests a client can make within a given time window. When exceeded, the server responds with HTTP 429 (Too Many Requests) and a `Retry-After` header.

**How it works in this project:** Rate limits protect the payment API from abuse. Critical endpoints like `/api/payments/pay` and `/api/cards` have strict per-user limits to prevent automated attacks. Login attempts are rate-limited per IP to prevent brute-force password attacks. Redis backs the rate limit store for consistency across server instances.

**Why it matters at scale:** Payment systems are high-value targets for attackers. A brute-force attack testing stolen card numbers by attempting small transactions can be detected and blocked by rate limiting the payment endpoint. Without rate limiting, an attacker could test thousands of stolen card numbers per minute, each generating a real authorization attempt to the card network. Rate limiting caps the damage to a handful of attempts before the attacker is blocked.

### Idempotency

**What it is:** An idempotent operation produces the same result whether executed once or multiple times. For APIs, this means that retrying a request (due to network timeout, client retry, or double-click) does not cause duplicate side effects.

**How it works in this project (`backend/src/shared/idempotency.ts`):** All mutation endpoints require an `Idempotency-Key` header. The middleware checks Redis for a cached response. Found + completed: return cached response. Found + in-progress: return 409 Conflict. Not found: acquire lock, execute, cache result for 24 hours. Protected endpoints include payment processing (prevents double-charging), card provisioning (prevents duplicate tokens), refunds (prevents double-refunds), and card state mutations (suspend, reactivate, remove).

**Why it matters at scale:** In a payment system, idempotency is not a nice-to-have -- it is essential for financial correctness. Consider: a user taps their phone at a terminal, the NFC payment completes, but the response is lost due to a network glitch. The terminal retries the payment. Without idempotency, the user is charged twice. With idempotency, the retry returns the cached result from the first successful payment, and the user is charged once. The ATC (Application Transaction Counter) provides a second layer of replay protection at the protocol level: each cryptogram includes a monotonically increasing counter, so even without the idempotency middleware, the network rejects cryptograms with stale ATC values.

### Health Checks

**What it is:** Health checks are HTTP endpoints consumed by infrastructure systems (load balancers, Kubernetes) to determine whether an application instance can serve traffic.

**How it works in this project (`backend/src/shared/health.ts`):** Three tiers: `GET /health/live` returns 200 if the process is running (liveness probe). `GET /health/ready` checks PostgreSQL and Redis connectivity, returning 503 if either is unreachable (readiness probe). `GET /health` (or `/health/deep`) performs a detailed check including component latency measurements (PostgreSQL query time, Redis ping time) and circuit breaker state for all payment networks. The deep check returns a structured response showing which components are healthy and which are degraded.

**Why it matters at scale:** A payment system with 99.99% availability target (< 4.3 minutes downtime per month) cannot afford to route traffic to broken instances. Health checks enable automatic remediation: if a server loses its Redis connection (which stores idempotency keys and ATC watermarks), the readiness check fails, the load balancer stops sending traffic, and users are seamlessly redirected to healthy instances. The deep health check additionally detects degraded states -- for example, if the Visa circuit breaker is open, the system is technically "running" but unable to process Visa transactions. The monitoring system uses this information to page the on-call engineer before the SLO is breached.

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation.

### Local Architecture

```
┌─────────────────┐         ┌─────────────────┐
│   React + Vite  │────────▶│  Express API    │
│   :5173         │  HTTP   │  :3000          │
│                 │◀────────│                 │
│ - Wallet (cards)│         │ - Auth + Devices│
│ - Pay Screen    │         │ - Card CRUD     │
│ - Transactions  │         │ - Payment Proc  │
│ - Merchant View │         │ - Merchants     │
│ - Login         │         │ - Biometric sim │
└─────────────────┘         └────────┬─────────┘
                                     │
              ┌──────────────────────┴──────────────────────┐
              ▼                                             ▼
     ┌─────────────────┐                           ┌─────────────────┐
     │   PostgreSQL    │                           │  Valkey/Redis   │
     │   :5432         │                           │  :6379          │
     │                 │                           │                 │
     │ - All tables    │                           │ - Sessions      │
     │ - Audit logs    │                           │ - Idempotency   │
     │ - Token ATC     │                           │ - ATC cache     │
     └─────────────────┘                           └─────────────────┘
```

### Production Patterns Actually Implemented

**1. Prometheus Metrics** (`backend/src/shared/metrics.ts`)

Full `/metrics` endpoint with HTTP request duration histogram, payment transaction counters (by status, type, network), payment duration histogram, circuit breaker state gauge, idempotency cache counters, and card provisioning counters. Includes Node.js default metrics.

**2. Structured Logging with Pino** (`backend/src/shared/logger.ts`)

JSON-formatted request logging with `requestId` correlation. Sensitive data redaction prevents PAN/CVV/token material from appearing in logs. Child loggers with service context.

**3. Idempotency Middleware** (`backend/src/shared/idempotency.ts`)

`Idempotency-Key` header support with Redis-backed response caching. 24-hour TTL. Concurrent duplicate detection via Redis NX lock. Protects payment, provisioning, and refund endpoints.

**4. Circuit Breaker (Opossum)** (`backend/src/shared/circuit-breaker.ts`)

Per-network circuit breakers (Visa, Mastercard, Amex) using the `opossum` library. Configured with 10s timeout, 50% error threshold, 30s reset. Graceful decline fallback when circuit is open. State exposed via health checks and Prometheus metrics.

**5. Audit Logging** (`backend/src/shared/audit.ts`)

Database-backed audit trail for all financial and security operations. Logs authentication events, card operations (provision, suspend, reactivate, remove), payment transactions, refunds, device operations, and biometric authentication. Metadata is redacted before storage.

**6. Enhanced Health Checks** (`backend/src/shared/health.ts`)

Three-tier health checks: `/health/live` (liveness), `/health/ready` (DB + Redis connectivity), `/health/deep` (detailed component status with latency and circuit breaker state).

**7. Simulated Tokenization** (`backend/src/services/tokenization.ts`)

Simulates the Token Service Provider interaction: generates fake DPANs, token references, and cryptographic material. In production, this would call Visa/Mastercard/Amex TSP APIs.

**8. Simulated Biometric Auth** (`backend/src/services/biometric.ts`)

Challenge-response flow simulating Face ID / Touch ID verification. Creates a biometric session with 5-minute TTL.

**9. Input Validation (Zod)** (`backend/src/routes/*.ts`)

Request body validation using Zod schemas for card provisioning, payment processing, and merchant operations.

### What Was Simplified or Substituted

| Production Component | Local Substitute | Rationale |
|----------------------|------------------|-----------|
| Visa/Mastercard/Amex TSP | Simulated token generation | No real network access |
| Hardware Secure Element | Software simulation | No physical SE available |
| NFC radio communication | HTTP POST simulating tap | No NFC hardware |
| Face ID / Touch ID | Challenge-response simulation | No biometric hardware |
| HSM (Hardware Security Module) | Node.js crypto | No HSM available locally |
| CDN for card art | No CDN | Direct PostgreSQL URLs |
| Multi-region deployment | Single PostgreSQL | One machine |
| Message queue | Synchronous processing | No Kafka needed locally |

### What Was Omitted

- **Real card network integration** -- no actual TSP calls to Visa/Mastercard/Amex
- **Hardware Secure Element** -- token storage and cryptogram generation simulated in software
- **NFC communication** -- payments submitted via HTTP API, not NFC radio
- **Real biometric authentication** -- Face ID/Touch ID simulated with challenge-response
- **FairPlay / hardware attestation** -- no device integrity verification
- **Receipt/notification delivery** -- no push notifications after payment
- **Card art rendering** -- no real card issuer artwork
- **PCI-DSS compliant infrastructure** -- no network segmentation, encryption at rest, or HSM
- **Kubernetes / auto-scaling** -- runs as single-process Express server
- **Multi-network routing intelligence** -- all networks treated identically in simulation
