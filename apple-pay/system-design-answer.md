# Apple Pay - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design Apple Pay, a mobile payment system that uses tokenization and biometric authentication to enable contactless payments. The key challenges are secure tokenization so real card numbers never touch merchants, hardware-backed key storage in the Secure Element, and sub-500ms transaction completion for NFC payments.

The core technical challenges are integrating with card network Token Service Providers, generating one-time cryptograms that prevent replay attacks, and handling the secure provisioning of tokens to the device's Secure Element."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Provision**: Add credit/debit cards to wallet
- **Pay NFC**: Contactless payments at terminals
- **Pay In-App**: Payments within apps and websites
- **Manage**: Suspend, remove cards, view transactions
- **Multi-device**: Same card on multiple Apple devices

### Non-Functional Requirements
- **Latency**: < 500ms for NFC transaction
- **Security**: Card number never shared with merchant
- **Availability**: 99.99% for payment transactions
- **Privacy**: Apple cannot see what you buy

### Scale Estimates
- 500 million+ Apple Pay users
- Billions of transactions per year
- Support for all major card networks (Visa, Mastercard, Amex, Discover)
- Every NFC-capable Apple device

## High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                     iPhone/Apple Watch                     |
|  +-----------------+  +----------------+  +-------------+ |
|  |   Wallet App    |  | Secure Element |  |  NFC Radio  | |
|  |                 |  |                |  |             | |
|  | - Card list     |  | - Token store  |  | - Tap       | |
|  | - History       |  | - Crypto keys  |  | - Terminal  | |
|  +-----------------+  +----------------+  +-------------+ |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                   Apple Pay Servers                        |
|           (Provisioning, Routing, Never sees PAN)         |
+----------------------------------------------------------+
          |                    |                    |
          v                    v                    v
+------------------+  +------------------+  +------------------+
|  Card Networks   |  |   Token Vault    |  |  Issuing Banks   |
|                  |  |                  |  |                  |
| - Visa VTS       |  | - Token -> PAN   |  | - Authorize      |
| - MC MDES        |  | - Cryptogram     |  | - Settle         |
| - Amex           |  |   validation     |  |                  |
+------------------+  +------------------+  +------------------+
```

### Core Components
1. **Wallet App** - UI for card management, transaction history
2. **Secure Element** - Hardware chip storing tokens and cryptographic keys
3. **Apple Pay Servers** - Routes provisioning, never stores card numbers
4. **Token Service Provider (TSP)** - Network's tokenization service
5. **Payment Terminal** - Merchant's NFC reader

## Deep Dive: Card Provisioning (8 minutes)

When you add a card, it goes through a complex multi-party process to create a device-specific token.

### Provisioning Flow

```javascript
class ProvisioningService {
  async provisionCard(userId, deviceId, cardData) {
    // Step 1: Identify card network
    const network = this.identifyNetwork(cardData.pan)

    // Step 2: Encrypt PAN for network (Apple never sees it unencrypted after this)
    const encryptedPAN = await this.encryptForNetwork(
      cardData.pan,
      network.publicKey
    )

    // Step 3: Request token from network's TSP
    const tokenRequest = {
      encryptedPAN,
      expiry: cardData.expiry,
      cvv: cardData.cvv,  // Only for initial verification
      deviceId,
      deviceType: this.getDeviceType(deviceId),
      walletId: userId
    }

    const tokenResponse = await this.requestTokenFromTSP(network, tokenRequest)

    if (!tokenResponse.approved) {
      // Bank may require additional verification
      if (tokenResponse.requiresVerification) {
        return {
          status: 'verification_required',
          methods: tokenResponse.verificationMethods,  // SMS, Email, Bank app
          verificationId: tokenResponse.verificationId
        }
      }
      throw new Error(tokenResponse.declineReason)
    }

    // Step 4: Store token reference (actual token goes to Secure Element)
    await db.query(`
      INSERT INTO provisioned_cards
        (id, user_id, device_id, token_ref, network, last4, card_type, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
    `, [
      uuid(),
      userId,
      deviceId,
      tokenResponse.tokenRef,
      network.name,
      cardData.pan.slice(-4),
      tokenResponse.cardType
    ])

    // Step 5: Provision to Secure Element
    await this.provisionToSecureElement(deviceId, {
      token: tokenResponse.token,
      cryptogramKey: tokenResponse.cryptogramKey,
      tokenExpiry: tokenResponse.tokenExpiry
    })

    return {
      success: true,
      cardType: tokenResponse.cardType,
      network: network.name,
      last4: cardData.pan.slice(-4)
    }
  }
}
```

### Secure Element Provisioning

The Secure Element (SE) is a tamper-resistant chip that stores tokens and keys:

```javascript
async provisionToSecureElement(deviceId, tokenData) {
  // Establish encrypted channel to device's SE
  const session = await this.establishSecureChannel(deviceId)

  // The token and cryptogram key are encrypted end-to-end
  // Only the SE can decrypt them
  const encryptedPayload = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: session.iv },
    session.ephemeralKey,
    JSON.stringify({
      token: tokenData.token,
      cryptogramKey: tokenData.cryptogramKey,
      expiry: tokenData.tokenExpiry
    })
  )

  // Send to device via Apple Push
  await this.pushToDevice(deviceId, {
    type: 'provision_token',
    sessionId: session.id,
    encryptedPayload: encryptedPayload
  })

  // Wait for SE confirmation
  const confirmation = await this.waitForConfirmation(session.id)
  return confirmation.success
}
```

### Why Device-Specific Tokens?

Each device gets a unique token for the same card:
- **Revocation**: Losing your iPhone doesn't compromise your Watch
- **Attribution**: Bank knows which device made the transaction
- **Security**: Compromising one token doesn't affect others

## Deep Dive: NFC Payment Transaction (8 minutes)

When you tap your phone at a terminal, a complex dance happens in under 500ms.

### On-Device Flow

```javascript
class NFCPaymentHandler {
  // Triggered when phone is near NFC terminal
  async handlePayment(terminalData) {
    const { merchantId, amount, currency, unpredictableNumber } = terminalData

    // Step 1: Biometric authentication
    const authenticated = await this.requestBiometricAuth()
    if (!authenticated) {
      throw new Error('Authentication failed')
    }

    // Step 2: Get default card
    const card = await this.getDefaultCard()

    // Step 3: Generate cryptogram in Secure Element
    // This never leaves the hardware chip
    const cryptogram = await this.secureElement.generateCryptogram({
      tokenId: card.tokenId,
      amount,
      currency,
      merchantId,
      unpredictableNumber
    })

    // Step 4: Build EMV payment data
    const paymentData = {
      token: card.token,  // Device-specific token, NOT real PAN
      cryptogram: cryptogram.value,
      eci: '07',  // Electronic Commerce Indicator
      atc: cryptogram.atc  // Application Transaction Counter
    }

    // Step 5: Transmit via NFC
    await this.nfcRadio.transmit(paymentData)

    return paymentData
  }
}
```

### Cryptogram Generation (Secure Element)

The cryptogram is a one-time value that proves the transaction is legitimate:

```javascript
// This runs inside Secure Element hardware
class SecureElement {
  async generateCryptogram(params) {
    const { tokenId, amount, merchantId, unpredictableNumber } = params

    // Get the cryptogram key (never leaves SE)
    const key = await this.getKey(tokenId)

    // Increment Application Transaction Counter
    // This ensures each cryptogram is unique
    const atc = await this.incrementATC(tokenId)

    // Build cryptogram input
    const input = Buffer.concat([
      this.padAmount(amount),
      Buffer.from(merchantId),
      Buffer.from(unpredictableNumber, 'hex'),
      this.toBytes(atc, 2)
    ])

    // Generate MAC using 3DES or AES
    const cryptogram = await this.mac(key, input)

    return {
      value: cryptogram.slice(0, 8).toString('hex'),
      atc
    }
  }
}
```

### Server-Side Processing

```javascript
class TransactionService {
  async processNFCTransaction(terminalData) {
    const { token, cryptogram, atc, amount, merchantId } = terminalData

    // Step 1: Route to appropriate card network based on token prefix
    const network = this.identifyNetwork(token)

    // Step 2: Network validates cryptogram
    // This proves the token was used by legitimate device
    const cryptogramValid = await network.validateCryptogram({
      token,
      cryptogram,
      atc,
      amount,
      merchantId
    })

    if (!cryptogramValid) {
      return { approved: false, reason: 'Invalid cryptogram' }
    }

    // Step 3: Network's Token Vault maps token -> real PAN
    // Then routes to issuing bank for authorization
    const authResult = await network.authorize({
      token,  // Network translates to PAN internally
      amount,
      merchantId,
      cryptogramVerified: true
    })

    // Step 4: Return result
    // Merchant never saw the real card number
    return {
      approved: authResult.approved,
      authCode: authResult.authCode,
      network: network.name
    }
  }
}
```

### Why This Is Secure

1. **Tokenization**: Merchant receives a token, not real PAN
2. **Cryptogram**: One-time value that can't be replayed
3. **ATC**: Counter prevents using same cryptogram twice
4. **Secure Element**: Keys never leave hardware
5. **Biometric**: Requires Face ID or Touch ID

## Deep Dive: Token Lifecycle Management (5 minutes)

### Lost Device Handling

```javascript
class TokenLifecycleService {
  async handleDeviceLost(userId, deviceId) {
    // Get all tokens on lost device
    const tokens = await db.query(`
      SELECT * FROM provisioned_cards
      WHERE user_id = $1 AND device_id = $2 AND status = 'active'
    `, [userId, deviceId])

    for (const token of tokens.rows) {
      // Suspend token at network level
      await this.suspendToken(token.token_ref, token.network, 'device_lost')

      // Update local status
      await db.query(`
        UPDATE provisioned_cards
        SET status = 'suspended', suspended_at = NOW(), suspend_reason = 'device_lost'
        WHERE id = $1
      `, [token.id])
    }

    return { suspendedCount: tokens.rows.length }
  }

  async suspendToken(tokenRef, network, reason) {
    // Call network's token lifecycle API
    await this.networkClient[network].suspendToken({
      tokenRef,
      reason,
      timestamp: new Date().toISOString()
    })
  }

  async reactivateAfterRecovery(userId, deviceId) {
    const tokens = await db.query(`
      SELECT * FROM provisioned_cards
      WHERE user_id = $1 AND device_id = $2 AND status = 'suspended'
        AND suspend_reason = 'device_lost'
    `, [userId, deviceId])

    for (const token of tokens.rows) {
      // Reactivate at network
      await this.networkClient[token.network].resumeToken(token.token_ref)

      await db.query(`
        UPDATE provisioned_cards
        SET status = 'active', suspended_at = NULL, suspend_reason = NULL
        WHERE id = $1
      `, [token.id])
    }
  }
}
```

### Card Expiry/Replacement

When your physical card is replaced, the token can be updated:

```javascript
async handleCardUpdate(tokenRef, network, newExpiry) {
  // Network notifies us of card update
  await db.query(`
    UPDATE provisioned_cards
    SET card_expiry = $2, updated_at = NOW()
    WHERE token_ref = $1
  `, [tokenRef, newExpiry])

  // Token itself stays the same - just metadata update
  // No action needed on Secure Element
}
```

## Trade-offs and Alternatives (5 minutes)

### 1. Device-Specific Tokens vs Shared Tokens

**Chose: Device-specific tokens**
- Pro: Can revoke individual devices
- Pro: Bank knows which device transacted
- Pro: Compromise of one doesn't affect others
- Con: More tokens to manage
- Alternative: Shared cloud token (simpler but less secure)

### 2. Secure Element vs Software Keystore

**Chose: Hardware Secure Element**
- Pro: Keys protected from OS-level attacks
- Pro: Tamper-resistant
- Pro: Required for card network certification
- Con: Limited storage capacity
- Con: Hardware dependency
- Alternative: Software keychain (simpler but less secure)

### 3. Per-Transaction Cryptogram vs Static Token

**Chose: Dynamic cryptogram**
- Pro: Prevents replay attacks
- Pro: Each transaction is unique
- Con: More complex implementation
- Alternative: Static token with CVV (how card-on-file works, less secure)

### 4. Network-Specific TSPs vs Universal Token Format

**Chose: Network-specific TSPs**
- Pro: Each network controls their own security
- Pro: Compatibility with existing infrastructure
- Con: Integration complexity
- Alternative: Universal token format (simpler but requires industry agreement)

### Database Schema

```sql
-- Provisioned Cards
CREATE TABLE provisioned_cards (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  device_id UUID NOT NULL,
  token_ref VARCHAR(100) NOT NULL,  -- Reference to network's token
  network VARCHAR(20) NOT NULL,      -- visa, mastercard, amex
  last4 VARCHAR(4) NOT NULL,         -- For display
  card_type VARCHAR(20),             -- credit, debit
  status VARCHAR(20) DEFAULT 'active',
  suspended_at TIMESTAMP,
  suspend_reason VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Transactions
CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  token_ref VARCHAR(100) NOT NULL,
  merchant_name VARCHAR(200),
  merchant_category VARCHAR(10),
  amount DECIMAL NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(20) NOT NULL,
  auth_code VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

-- User Devices
CREATE TABLE user_devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  device_type VARCHAR(50),
  device_name VARCHAR(100),
  is_lost BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Closing Summary (1 minute)

"Apple Pay is built around three security principles:

1. **Tokenization** - Real card numbers never touch merchants or even Apple Pay servers. Device-specific tokens mean losing one device doesn't compromise others.

2. **Hardware security** - The Secure Element is a tamper-resistant chip where tokens and cryptographic keys are stored. Keys never leave this hardware.

3. **Dynamic cryptograms** - Each transaction generates a one-time cryptogram using the Application Transaction Counter. This prevents replay attacks and proves the token was used legitimately.

The key trade-off is security vs. simplicity. The multi-party dance between Apple, card networks, and banks is complex, but it ensures that even a complete compromise of Apple's servers would not expose any card numbers or enable fraudulent transactions."
