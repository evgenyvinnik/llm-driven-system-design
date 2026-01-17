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
│                    Apple Pay Servers                            │
│         (Token provisioning, Transaction routing)               │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Card Networks │    │  Token Vault  │    │   Issuing     │
│               │    │               │    │   Banks       │
│ - Visa        │    │ - Token mgmt  │    │               │
│ - Mastercard  │    │ - Cryptograms │    │ - Auth        │
│ - Amex        │    │               │    │ - Settle      │
└───────────────┘    └───────────────┘    └───────────────┘
```

---

## Core Components

### 1. Card Provisioning

**Token Generation Flow:**
```javascript
class ProvisioningService {
  async provisionCard(userId, deviceId, cardData) {
    // Validate card with network
    const cardNetwork = this.identifyNetwork(cardData.pan)

    // Request token from network's Token Service Provider (TSP)
    const tokenRequest = {
      pan: await this.encryptForNetwork(cardData.pan, cardNetwork),
      expiry: cardData.expiry,
      deviceId,
      deviceType: 'iphone',
      walletId: this.getWalletId(userId)
    }

    const tokenResponse = await this.requestToken(cardNetwork, tokenRequest)

    // Store token reference (not the actual token - that's in Secure Element)
    await db.query(`
      INSERT INTO provisioned_cards
        (id, user_id, device_id, token_ref, network, last4, card_type, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
    `, [
      uuid(),
      userId,
      deviceId,
      tokenResponse.tokenRef,
      cardNetwork,
      cardData.pan.slice(-4),
      tokenResponse.cardType
    ])

    // Provision token to Secure Element on device
    await this.provisionToSecureElement(deviceId, {
      token: tokenResponse.token,
      cryptogramKey: tokenResponse.cryptogramKey,
      network: cardNetwork
    })

    return {
      success: true,
      last4: cardData.pan.slice(-4),
      cardType: tokenResponse.cardType,
      network: cardNetwork
    }
  }

  async provisionToSecureElement(deviceId, tokenData) {
    // Establish secure channel to device's Secure Element
    const session = await this.establishSecureChannel(deviceId)

    // Send token data encrypted for Secure Element
    const encryptedPayload = await this.encryptForSE(
      tokenData,
      session.ephemeralKey
    )

    await this.pushToDevice(deviceId, {
      type: 'provision_token',
      sessionId: session.id,
      payload: encryptedPayload
    })
  }
}
```

### 2. NFC Payment

**Contactless Transaction:**
```javascript
class NFCPaymentHandler {
  // Runs on device when near payment terminal
  async handlePayment(merchantData) {
    const { amount, currency, merchantId, merchantName } = merchantData

    // Request biometric auth
    const authenticated = await this.requestBiometricAuth()
    if (!authenticated) {
      throw new Error('Authentication failed')
    }

    // Get default card from Wallet
    const card = await this.getDefaultCard()

    // Generate payment cryptogram in Secure Element
    const cryptogram = await this.secureElement.generateCryptogram({
      tokenId: card.tokenId,
      amount,
      currency,
      merchantId,
      transactionId: uuid(),
      unpredictableNumber: merchantData.unpredictableNumber
    })

    // Build EMV payment data
    const paymentData = {
      token: card.token, // Device-specific token, not real PAN
      cryptogram: cryptogram.value,
      eci: '07', // Electronic Commerce Indicator
      applicationExpiryDate: card.expiryDate,
      applicationInterchangeProfile: '1900',
      applicationTransactionCounter: cryptogram.atc
    }

    // Transmit via NFC
    await this.nfcRadio.transmit(paymentData)

    // Log transaction locally
    await this.logTransaction({
      merchantName,
      amount,
      currency,
      timestamp: Date.now(),
      status: 'pending'
    })

    return paymentData
  }
}

// Secure Element operations (hardware)
class SecureElement {
  async generateCryptogram(params) {
    // This runs in secure hardware
    const { tokenId, amount, merchantId, unpredictableNumber } = params

    // Get token's cryptogram key (never leaves SE)
    const key = await this.getKey(tokenId)

    // Increment Application Transaction Counter
    const atc = await this.incrementATC(tokenId)

    // Build cryptogram input
    const input = Buffer.concat([
      Buffer.from(amount.toString().padStart(12, '0')),
      Buffer.from(merchantId),
      Buffer.from(unpredictableNumber, 'hex'),
      Buffer.from(atc.toString(16).padStart(4, '0'), 'hex')
    ])

    // Generate cryptogram using 3DES or AES
    const cryptogram = await this.mac(key, input)

    return {
      value: cryptogram.slice(0, 8).toString('hex'), // First 8 bytes
      atc
    }
  }
}
```

### 3. In-App Payment

**Apple Pay JS Integration:**
```javascript
class InAppPaymentService {
  async processPayment(merchantId, paymentRequest) {
    const { amount, currency, items } = paymentRequest

    // Create payment session
    const session = await ApplePaySession.create(3, {
      countryCode: 'US',
      currencyCode: currency,
      merchantCapabilities: ['supports3DS'],
      supportedNetworks: ['visa', 'masterCard', 'amex'],
      total: {
        label: 'Total',
        amount: amount.toString()
      },
      lineItems: items
    })

    return new Promise((resolve, reject) => {
      session.onpaymentauthorized = async (event) => {
        const payment = event.payment

        // Payment token is encrypted for merchant
        const token = payment.token

        // Send to server for processing
        try {
          const result = await this.processWithServer(merchantId, token)

          if (result.success) {
            session.completePayment(ApplePaySession.STATUS_SUCCESS)
            resolve(result)
          } else {
            session.completePayment(ApplePaySession.STATUS_FAILURE)
            reject(new Error(result.error))
          }
        } catch (error) {
          session.completePayment(ApplePaySession.STATUS_FAILURE)
          reject(error)
        }
      }

      session.begin()
    })
  }

  async processWithServer(merchantId, paymentToken) {
    // Decrypt payment token with merchant's private key
    const decrypted = await this.decryptPaymentToken(
      paymentToken,
      merchantId
    )

    // Extract payment data
    const { token, cryptogram, eci, transactionId } = decrypted

    // Process with payment processor
    const result = await this.paymentProcessor.authorize({
      token,
      cryptogram,
      eci,
      amount: paymentToken.paymentData.amount,
      currency: paymentToken.paymentData.currency,
      merchantId
    })

    return result
  }
}
```

### 4. Transaction Processing

**Server-Side Processing:**
```javascript
class TransactionService {
  async processNFCTransaction(terminalData) {
    const { token, cryptogram, amount, merchantId, terminalId } = terminalData

    // Look up token
    const tokenInfo = await this.tokenVault.lookup(token)
    if (!tokenInfo) {
      return { approved: false, reason: 'Invalid token' }
    }

    // Validate cryptogram with network
    const cryptogramValid = await this.validateCryptogram(
      tokenInfo.network,
      token,
      cryptogram,
      {
        amount,
        merchantId,
        transactionId: terminalData.transactionId
      }
    )

    if (!cryptogramValid) {
      return { approved: false, reason: 'Cryptogram validation failed' }
    }

    // Get real PAN from token vault (only network has this)
    // Route authorization to issuing bank
    const authResult = await this.routeToIssuer(tokenInfo, {
      amount,
      merchantId,
      terminalId,
      cryptogramVerified: true
    })

    // Log transaction
    await db.query(`
      INSERT INTO transactions
        (id, token_ref, merchant_id, amount, currency, status, auth_code)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      uuid(),
      tokenInfo.tokenRef,
      merchantId,
      amount,
      terminalData.currency,
      authResult.approved ? 'approved' : 'declined',
      authResult.authCode
    ])

    return authResult
  }

  async validateCryptogram(network, token, cryptogram, context) {
    // Send to network's cryptogram validation service
    const response = await this.networkClient[network].validateCryptogram({
      token,
      cryptogram,
      ...context
    })

    return response.valid
  }
}
```

### 5. Token Lifecycle

**Token Management:**
```javascript
class TokenLifecycleService {
  async suspendToken(userId, cardId, reason) {
    const card = await this.getCard(userId, cardId)

    // Notify network to suspend token
    await this.networkClient[card.network].suspendToken(card.tokenRef, reason)

    // Update local state
    await db.query(`
      UPDATE provisioned_cards
      SET status = 'suspended', suspended_at = NOW(), suspend_reason = $3
      WHERE id = $1 AND user_id = $2
    `, [cardId, userId, reason])

    // Notify device to disable token in Secure Element
    await this.pushToDevice(card.deviceId, {
      type: 'token_status_change',
      tokenRef: card.tokenRef,
      newStatus: 'suspended'
    })
  }

  async handleDeviceLost(userId, deviceId) {
    // Suspend all tokens on lost device
    const cards = await db.query(`
      SELECT * FROM provisioned_cards
      WHERE user_id = $1 AND device_id = $2 AND status = 'active'
    `, [userId, deviceId])

    for (const card of cards.rows) {
      await this.suspendToken(userId, card.id, 'device_lost')
    }

    return { suspendedCount: cards.rows.length }
  }

  async refreshToken(userId, cardId) {
    const card = await this.getCard(userId, cardId)

    // Request new token from network
    const newToken = await this.networkClient[card.network].refreshToken(
      card.tokenRef
    )

    // Update Secure Element with new token
    await this.provisionToSecureElement(card.deviceId, {
      token: newToken.token,
      cryptogramKey: newToken.cryptogramKey,
      replaces: card.tokenRef
    })

    // Update reference
    await db.query(`
      UPDATE provisioned_cards
      SET token_ref = $3, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
    `, [cardId, userId, newToken.tokenRef])
  }
}
```

---

## Database Schema

```sql
-- Provisioned Cards
CREATE TABLE provisioned_cards (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  device_id UUID NOT NULL,
  token_ref VARCHAR(100) NOT NULL, -- Reference to token (actual token in SE)
  network VARCHAR(20) NOT NULL, -- visa, mastercard, amex
  last4 VARCHAR(4) NOT NULL,
  card_type VARCHAR(20), -- credit, debit
  card_art_url VARCHAR(500),
  status VARCHAR(20) DEFAULT 'active',
  suspended_at TIMESTAMP,
  suspend_reason VARCHAR(100),
  provisioned_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cards_user ON provisioned_cards(user_id);
CREATE INDEX idx_cards_device ON provisioned_cards(device_id);

-- Transactions
CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  token_ref VARCHAR(100) NOT NULL,
  merchant_id VARCHAR(100),
  merchant_name VARCHAR(200),
  terminal_id VARCHAR(100),
  amount DECIMAL NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(20) NOT NULL,
  auth_code VARCHAR(20),
  decline_reason VARCHAR(100),
  transaction_type VARCHAR(20), -- nfc, in_app, web
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transactions_token ON transactions(token_ref, created_at DESC);

-- Merchants
CREATE TABLE merchants (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  category_code VARCHAR(4),
  public_key BYTEA, -- For encrypting payment tokens
  webhook_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Device-Specific Tokens

**Decision**: Each device gets unique token for same card

**Rationale**:
- Losing one device doesn't compromise others
- Easy per-device revocation
- Network knows which device transacted

### 2. Secure Element Storage

**Decision**: Store tokens and keys in hardware SE

**Rationale**:
- Keys never leave secure hardware
- Protected from OS-level attacks
- Tamper-resistant

### 3. Dynamic Cryptograms

**Decision**: One-time cryptogram per transaction

**Rationale**:
- Token alone is useless without cryptogram
- Prevents replay attacks
- Verifiable by network

---

## Capacity Planning and Traffic Estimates

This section provides realistic traffic estimates for a local development simulation, scaled down from production but maintaining realistic ratios.

### Local Development Scale

| Metric | Local Dev Value | Production Equivalent |
|--------|-----------------|----------------------|
| DAU (Daily Active Users) | 100 simulated users | 50M users |
| MAU (Monthly Active Users) | 500 simulated users | 500M users |
| Provisioned cards | 200 cards | 1B cards |
| Transactions/day | 500 | 500M |

### Request Rate Estimates

**Provisioning Service:**
- Peak RPS: 2 requests/second (local) = 10K RPS production
- Payload size: ~2KB (encrypted card data + device attestation)
- Burst capacity: 5 RPS for 30 seconds

**Transaction Processing:**
- Peak RPS: 5 requests/second (local) = 20K RPS production
- NFC payload: ~500 bytes (EMV data + cryptogram)
- In-app payload: ~2KB (encrypted payment token)
- P99 latency target: 300ms for NFC, 500ms for in-app

**Token Lifecycle:**
- Peak RPS: 0.5 requests/second (local)
- Mostly bursty during "lost device" scenarios

### Component Sizing (Local Development)

**PostgreSQL:**
- Single instance, no sharding needed at local scale
- Tables sized for ~10K rows each (cards, transactions)
- Connection pool: 10 connections sufficient

**Valkey/Redis Cache:**
- Memory: 256MB sufficient
- Keys: ~1K active session keys + ~500 token lookup cache entries
- Eviction policy: `allkeys-lru`

**RabbitMQ (optional async processing):**
- Single queue for transaction notifications
- Message throughput: 10 messages/second peak
- Message size: ~1KB (transaction events)

### Sharding Strategy (Production Reference)

For production scale, transactions would shard by:
- **Primary key**: `token_ref` hash (distributes load across token usage)
- **Time-based partitioning**: Monthly partitions for transactions table
- **Shard count**: 16 shards handles 500M daily transactions

```sql
-- Example: Hash-based routing for local simulation
CREATE OR REPLACE FUNCTION get_shard_id(token_ref VARCHAR)
RETURNS INTEGER AS $$
BEGIN
  -- For local dev: always returns 0 (single shard)
  -- Production: RETURN abs(hashtext(token_ref)) % 16;
  RETURN 0;
END;
$$ LANGUAGE plpgsql;
```

---

## Consistency and Idempotency Semantics

Payment systems require careful consistency guarantees. This section defines the semantics for each write operation.

### Transaction Consistency Model

| Operation | Consistency Level | Rationale |
|-----------|------------------|-----------|
| Card provisioning | Strong (serializable) | Must prevent duplicate tokens |
| Transaction authorization | Strong (serializable) | Financial accuracy |
| Transaction history reads | Eventual (read-your-writes) | Performance acceptable |
| Token status updates | Strong | Security-critical |

### Idempotency Implementation

All mutation endpoints require idempotency keys to handle network retries safely.

```javascript
class IdempotencyService {
  constructor(redis) {
    this.redis = redis
    this.TTL_SECONDS = 86400 // 24 hours
  }

  async executeOnce(idempotencyKey, operation) {
    const cacheKey = `idempotency:${idempotencyKey}`

    // Check for existing result
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      const parsed = JSON.parse(cached)
      if (parsed.status === 'completed') {
        return { replayed: true, result: parsed.result }
      }
      if (parsed.status === 'in_progress') {
        throw new Error('Request already in progress')
      }
    }

    // Mark as in-progress with short TTL (prevents concurrent execution)
    const lockAcquired = await this.redis.set(
      cacheKey,
      JSON.stringify({ status: 'in_progress', startedAt: Date.now() }),
      'NX',
      'EX',
      60 // 60 second lock for operation
    )

    if (!lockAcquired) {
      throw new Error('Request already in progress')
    }

    try {
      const result = await operation()

      // Store completed result
      await this.redis.set(
        cacheKey,
        JSON.stringify({ status: 'completed', result, completedAt: Date.now() }),
        'EX',
        this.TTL_SECONDS
      )

      return { replayed: false, result }
    } catch (error) {
      // Clear in-progress state on failure (allow retry)
      await this.redis.del(cacheKey)
      throw error
    }
  }
}
```

### Replay Handling

**Transaction Authorization Replays:**
```javascript
class TransactionService {
  async processTransaction(idempotencyKey, transactionData) {
    return this.idempotency.executeOnce(idempotencyKey, async () => {
      // Check if transaction already exists by terminal+reference
      const existing = await db.query(`
        SELECT * FROM transactions
        WHERE terminal_id = $1 AND terminal_reference = $2
      `, [transactionData.terminalId, transactionData.terminalReference])

      if (existing.rows.length > 0) {
        // Return existing result (terminal retry scenario)
        return existing.rows[0]
      }

      // Process new transaction with serializable isolation
      return db.transaction('SERIALIZABLE', async (tx) => {
        // Validate token is still active
        const card = await tx.query(`
          SELECT * FROM provisioned_cards
          WHERE token_ref = $1 AND status = 'active'
          FOR UPDATE
        `, [transactionData.tokenRef])

        if (card.rows.length === 0) {
          throw new Error('Token not active')
        }

        // Insert transaction
        const result = await tx.query(`
          INSERT INTO transactions (id, token_ref, terminal_id, terminal_reference, amount, currency, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'pending')
          RETURNING *
        `, [uuid(), transactionData.tokenRef, transactionData.terminalId,
            transactionData.terminalReference, transactionData.amount, transactionData.currency])

        return result.rows[0]
      })
    })
  }
}
```

### Conflict Resolution

**Token Provisioning Conflicts:**
- Same card on same device: Reject (card already provisioned)
- Same card on different device: Allow (per-device tokens)
- Concurrent provisioning attempts: First-write-wins via database unique constraint

```sql
-- Prevent duplicate card+device combinations
ALTER TABLE provisioned_cards
ADD CONSTRAINT unique_card_device UNIQUE (user_id, device_id, last4, network);
```

**Token Status Conflicts:**
- Suspend vs. active payment: Suspend takes precedence (security)
- Multiple suspend requests: Idempotent (no-op if already suspended)
- Reactivate during payment: Queue reactivation until payment completes

### Application Transaction Counter (ATC)

The ATC in the Secure Element provides natural replay protection for NFC payments:

```javascript
class CryptogramValidator {
  async validateCryptogram(tokenRef, cryptogram, claimedATC) {
    // Get last known ATC for this token
    const lastATC = await this.redis.get(`atc:${tokenRef}`)

    if (lastATC && claimedATC <= parseInt(lastATC)) {
      // Replay attack detected - ATC must always increase
      return { valid: false, reason: 'ATC_REPLAY' }
    }

    // Validate cryptogram with network...
    const networkResult = await this.validateWithNetwork(tokenRef, cryptogram)

    if (networkResult.valid) {
      // Update ATC watermark
      await this.redis.set(`atc:${tokenRef}`, claimedATC.toString())
    }

    return networkResult
  }
}
```

---

## Caching and Edge Strategy

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Request Flow                              │
└─────────────────────────────────────────────────────────────────┘

   Client Request
         │
         ▼
┌─────────────────┐    Cache Miss    ┌─────────────────┐
│   Edge Cache    │ ───────────────► │   Application   │
│   (CDN Layer)   │                  │     Server      │
│                 │ ◄─────────────── │                 │
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

### Caching Strategy by Data Type

| Data Type | Pattern | TTL | Invalidation |
|-----------|---------|-----|--------------|
| Token lookup (active) | Cache-aside | 5 minutes | On status change |
| Token lookup (suspended) | No cache | - | - |
| User's card list | Cache-aside | 2 minutes | On add/remove |
| Transaction history | Cache-aside | 30 seconds | On new transaction |
| Card art images | CDN/Write-through | 24 hours | On card update |
| Merchant info | Cache-aside | 1 hour | Manual refresh |
| ATC watermarks | Write-through | No expiry | On transaction |

### Cache-Aside Implementation

```javascript
class TokenCacheService {
  constructor(redis, db) {
    this.redis = redis
    this.db = db
    this.TOKEN_TTL = 300 // 5 minutes
  }

  async getActiveToken(tokenRef) {
    const cacheKey = `token:${tokenRef}`

    // Try cache first
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      const token = JSON.parse(cached)
      // Don't return cached suspended tokens
      if (token.status !== 'active') {
        await this.redis.del(cacheKey)
        return null
      }
      return token
    }

    // Cache miss - fetch from database
    const result = await this.db.query(`
      SELECT token_ref, network, status, device_id, user_id
      FROM provisioned_cards
      WHERE token_ref = $1 AND status = 'active'
    `, [tokenRef])

    if (result.rows.length === 0) {
      return null
    }

    const token = result.rows[0]

    // Populate cache
    await this.redis.set(
      cacheKey,
      JSON.stringify(token),
      'EX',
      this.TOKEN_TTL
    )

    return token
  }

  async invalidateToken(tokenRef) {
    await this.redis.del(`token:${tokenRef}`)
  }
}
```

### Write-Through for Critical Data

ATC watermarks use write-through to ensure durability:

```javascript
class ATCService {
  async updateATC(tokenRef, newATC) {
    const cacheKey = `atc:${tokenRef}`

    // Write to both cache and database atomically
    await this.db.transaction(async (tx) => {
      await tx.query(`
        INSERT INTO token_atc (token_ref, last_atc, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (token_ref)
        DO UPDATE SET last_atc = $2, updated_at = NOW()
        WHERE token_atc.last_atc < $2
      `, [tokenRef, newATC])

      // Update cache after successful DB write
      await this.redis.set(cacheKey, newATC.toString())
    })
  }

  async getATC(tokenRef) {
    const cacheKey = `atc:${tokenRef}`

    // Check cache
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return parseInt(cached)
    }

    // Fallback to database
    const result = await this.db.query(
      'SELECT last_atc FROM token_atc WHERE token_ref = $1',
      [tokenRef]
    )

    const atc = result.rows[0]?.last_atc || 0

    // Warm cache
    await this.redis.set(cacheKey, atc.toString())

    return atc
  }
}
```

### Cache Invalidation Rules

```javascript
class CacheInvalidationService {
  constructor(redis) {
    this.redis = redis
  }

  // Called when token status changes
  async onTokenStatusChange(tokenRef, userId) {
    await Promise.all([
      this.redis.del(`token:${tokenRef}`),
      this.redis.del(`user_cards:${userId}`)
    ])
  }

  // Called when new card is provisioned
  async onCardProvisioned(userId) {
    await this.redis.del(`user_cards:${userId}`)
  }

  // Called when transaction is processed
  async onTransactionProcessed(tokenRef, userId) {
    await this.redis.del(`tx_history:${userId}`)
    // Token cache stays valid - status unchanged
  }

  // Batch invalidation for lost device
  async onDeviceLost(userId, deviceId) {
    // Get all affected token refs
    const tokens = await this.db.query(
      'SELECT token_ref FROM provisioned_cards WHERE device_id = $1',
      [deviceId]
    )

    const pipeline = this.redis.pipeline()
    for (const token of tokens.rows) {
      pipeline.del(`token:${token.token_ref}`)
    }
    pipeline.del(`user_cards:${userId}`)

    await pipeline.exec()
  }
}
```

### Local Development Cache Configuration

```javascript
// config/cache.js
module.exports = {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: 3,
    retryDelayMs: 100
  },
  ttl: {
    token: 300,        // 5 minutes
    userCards: 120,    // 2 minutes
    txHistory: 30,     // 30 seconds
    merchantInfo: 3600 // 1 hour
  },
  // For local dev, cache is optional - graceful degradation
  fallbackOnError: true
}
```

### CDN/Edge Strategy (Production Reference)

For local development, we skip CDN, but document the production pattern:

```javascript
// Static asset URLs with cache headers
class CardArtService {
  getCardArtUrl(cardArtId) {
    // Local dev: serve from local storage
    if (process.env.NODE_ENV === 'development') {
      return `/static/card-art/${cardArtId}.png`
    }

    // Production: CDN URL with cache busting
    return `https://cdn.applepay.example.com/card-art/${cardArtId}.png?v=${this.getVersion(cardArtId)}`
  }

  // Cache headers for card art responses
  getCardArtHeaders() {
    return {
      'Cache-Control': 'public, max-age=86400', // 24 hours
      'CDN-Cache-Control': 'max-age=604800',    // 7 days at edge
      'Vary': 'Accept-Encoding'
    }
  }
}
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Token storage | Secure Element | Software keychain | Security |
| Token scope | Per-device | Shared across devices | Revocation |
| Auth method | Biometric + SE | PIN only | Security + UX |
| Cryptogram | Network-specific | Universal | Compatibility |
| Token cache | Cache-aside with 5min TTL | No cache | Latency vs freshness |
| ATC storage | Write-through | Cache-aside | Durability critical |
| Idempotency | Redis with 24h TTL | Database only | Performance |
| Transaction consistency | Serializable | Read-committed | Financial accuracy |
