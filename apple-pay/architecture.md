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
