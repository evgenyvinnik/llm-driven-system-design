# Design Venmo - Architecture

## System Overview

Venmo is a peer-to-peer payment platform with social features. Core challenges involve balance management, instant transfers, and social feed scalability.

**Learning Goals:**
- Build consistent wallet/balance systems
- Design real-time P2P transfer flows
- Implement social transaction feeds
- Handle multi-source funding

---

## Requirements

### Functional Requirements

1. **Send**: Transfer money to other users
2. **Request**: Ask others for payment
3. **Feed**: View social transaction activity
4. **Balance**: Manage Venmo wallet
5. **Cashout**: Transfer to bank account

### Non-Functional Requirements

- **Latency**: < 500ms for P2P transfers
- **Consistency**: Accurate balances always
- **Availability**: 99.99% for transfers
- **Scale**: 80M+ users, high volume on weekends

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│                 Mobile App │ Web App                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│               (Auth, Rate Limiting)                             │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Transfer Service│    │  Feed Service │    │ Wallet Service│
│               │    │               │    │               │
│ - Send/Request│    │ - Timeline    │    │ - Balance     │
│ - Split bills │    │ - Social graph│    │ - Funding     │
│ - History     │    │ - Visibility  │    │ - Cashout     │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │    Cassandra      │      Redis                │
│   - Wallets     │    - Feed items   │      - Balance cache      │
│   - Transfers   │    - Activity     │      - Sessions           │
│   - Users       │    - Social graph │      - Rate limits        │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Wallet & Balance Management

**Atomic Balance Updates:**
```javascript
async function transfer(senderId, receiverId, amount, note, visibility) {
  // Validate amount
  if (amount <= 0 || amount > 5000) {
    throw new Error('Invalid amount')
  }

  // Atomic transfer using database transaction
  const transfer = await db.transaction(async (tx) => {
    // Lock sender's wallet row to prevent race conditions
    const senderWallet = await tx.query(`
      SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE
    `, [senderId])

    // Check balance
    const available = await getAvailableBalance(tx, senderId, senderWallet.rows[0])
    if (available < amount) {
      throw new Error('Insufficient funds')
    }

    // Determine funding source (waterfall)
    const fundingPlan = await determineFunding(tx, senderId, amount, senderWallet.rows[0])

    // Debit sender
    await tx.query(`
      UPDATE wallets SET balance = balance - $2 WHERE user_id = $1
    `, [senderId, fundingPlan.fromBalance])

    // If funding from external source, create pending charge
    if (fundingPlan.fromExternal > 0) {
      await createExternalCharge(tx, senderId, fundingPlan.fromExternal, fundingPlan.source)
    }

    // Credit receiver
    await tx.query(`
      UPDATE wallets SET balance = balance + $2 WHERE user_id = $1
    `, [receiverId, amount])

    // Create transfer record
    const transferRecord = await tx.query(`
      INSERT INTO transfers (sender_id, receiver_id, amount, note, visibility, status)
      VALUES ($1, $2, $3, $4, $5, 'completed')
      RETURNING *
    `, [senderId, receiverId, amount, note, visibility])

    return transferRecord.rows[0]
  })

  // Update cached balances
  await invalidateBalanceCache(senderId)
  await invalidateBalanceCache(receiverId)

  // Publish to feed (async)
  await publishToFeed(transfer)

  // Send notifications
  await notifyTransfer(transfer)

  return transfer
}

async function determineFunding(tx, userId, amount, wallet) {
  let remaining = amount
  const plan = { fromBalance: 0, fromExternal: 0, source: null }

  // Priority 1: Use Venmo balance
  if (wallet.balance >= remaining) {
    plan.fromBalance = remaining
    return plan
  }

  plan.fromBalance = wallet.balance
  remaining -= wallet.balance

  // Priority 2: Use linked bank account (free)
  const bankAccount = await tx.query(`
    SELECT * FROM payment_methods
    WHERE user_id = $1 AND type = 'bank' AND is_default = true
  `, [userId])

  if (bankAccount.rows.length > 0) {
    plan.fromExternal = remaining
    plan.source = { type: 'bank', id: bankAccount.rows[0].id }
    return plan
  }

  // Priority 3: Use linked card (with fee)
  const card = await tx.query(`
    SELECT * FROM payment_methods
    WHERE user_id = $1 AND type = 'card' AND is_default = true
  `, [userId])

  if (card.rows.length > 0) {
    plan.fromExternal = remaining
    plan.source = { type: 'card', id: card.rows[0].id }
    return plan
  }

  throw new Error('No funding source available')
}
```

### 2. Social Feed

**Feed Generation:**
```javascript
// Write path: Fan-out on write
async function publishToFeed(transfer) {
  if (transfer.visibility === 'private') {
    // Only show to sender and receiver
    await addToFeed(transfer.sender_id, transfer)
    await addToFeed(transfer.receiver_id, transfer)
    return
  }

  // Get friends of both participants
  const friends = await getFriendsUnion(transfer.sender_id, transfer.receiver_id)

  // Fan out to all friends' feeds
  for (const friendId of friends) {
    await addToFeed(friendId, transfer)
  }
}

async function addToFeed(userId, transfer) {
  await cassandra.execute(`
    INSERT INTO feed_items (user_id, timestamp, transfer_id, sender_id, receiver_id, amount, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, Date.now(), transfer.id, transfer.sender_id, transfer.receiver_id,
      transfer.amount, transfer.note])
}

// Read path: Simple timeline query
async function getFeed(userId, limit = 20, before = null) {
  let query = `
    SELECT * FROM feed_items
    WHERE user_id = ?
  `
  const params = [userId]

  if (before) {
    query += ` AND timestamp < ?`
    params.push(before)
  }

  query += ` ORDER BY timestamp DESC LIMIT ?`
  params.push(limit)

  const result = await cassandra.execute(query, params)

  // Hydrate with user info
  return hydrateWithUsers(result.rows)
}
```

### 3. Payment Requests

**Request & Reminder Flow:**
```javascript
async function createRequest(requesterId, requesteeId, amount, note) {
  const request = await db.query(`
    INSERT INTO payment_requests (requester_id, requestee_id, amount, note, status)
    VALUES ($1, $2, $3, $4, 'pending')
    RETURNING *
  `, [requesterId, requesteeId, amount, note])

  // Notify requestee
  await pushNotification(requesteeId, {
    type: 'payment_request',
    title: `${requesterName} requested $${amount}`,
    body: note,
    data: { requestId: request.rows[0].id }
  })

  return request.rows[0]
}

async function payRequest(requestId, payerId) {
  const request = await db.query(`
    SELECT * FROM payment_requests WHERE id = $1 AND status = 'pending'
  `, [requestId])

  if (!request.rows.length) {
    throw new Error('Request not found or already paid')
  }

  const req = request.rows[0]

  // Verify payer is the requestee
  if (req.requestee_id !== payerId) {
    throw new Error('Unauthorized')
  }

  // Process as normal transfer
  const transfer = await transfer(
    payerId,
    req.requester_id,
    req.amount,
    req.note,
    'public'
  )

  // Mark request as paid
  await db.query(`
    UPDATE payment_requests SET status = 'paid', paid_at = NOW(), transfer_id = $2
    WHERE id = $1
  `, [requestId, transfer.id])

  return transfer
}

// Scheduled job: Send reminders
async function sendRequestReminders() {
  const pendingRequests = await db.query(`
    SELECT * FROM payment_requests
    WHERE status = 'pending'
    AND created_at < NOW() - INTERVAL '3 days'
    AND reminder_sent_at IS NULL
  `)

  for (const request of pendingRequests.rows) {
    await pushNotification(request.requestee_id, {
      type: 'request_reminder',
      title: `Reminder: ${requesterName} requested $${request.amount}`,
      body: 'Tap to pay or decline'
    })

    await db.query(`
      UPDATE payment_requests SET reminder_sent_at = NOW() WHERE id = $1
    `, [request.id])
  }
}
```

### 4. Instant Cashout

**Bank Transfer Options:**
```javascript
async function cashout(userId, amount, speed) {
  const wallet = await db.query(`
    SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE
  `, [userId])

  if (wallet.rows[0].balance < amount) {
    throw new Error('Insufficient balance')
  }

  const defaultBank = await db.query(`
    SELECT * FROM payment_methods
    WHERE user_id = $1 AND type = 'bank' AND is_default = true
  `, [userId])

  if (!defaultBank.rows.length) {
    throw new Error('No bank account linked')
  }

  let fee = 0
  let deliveryDate

  if (speed === 'instant') {
    // Instant transfer via debit card push
    fee = Math.min(Math.round(amount * 0.015), 1500) // 1.5%, max $15
    deliveryDate = new Date()

    // Process immediately
    await processInstantCashout(userId, amount, defaultBank.rows[0])
  } else {
    // Standard ACH (1-3 business days)
    fee = 0
    deliveryDate = getNextBusinessDay(3)

    // Queue for batch processing
    await queueACHCashout(userId, amount, defaultBank.rows[0])
  }

  // Debit balance
  await db.query(`
    UPDATE wallets SET balance = balance - $2 WHERE user_id = $1
  `, [userId, amount])

  // Record cashout
  const cashout = await db.query(`
    INSERT INTO cashouts (user_id, amount, fee, speed, status, estimated_arrival)
    VALUES ($1, $2, $3, $4, 'processing', $5)
    RETURNING *
  `, [userId, amount, fee, speed, deliveryDate])

  return cashout.rows[0]
}

async function processInstantCashout(userId, amount, bankAccount) {
  // Use debit card push-to-card for instant delivery
  const debitCard = await db.query(`
    SELECT * FROM payment_methods
    WHERE user_id = $1 AND type = 'debit_card' AND bank_id = $2
  `, [userId, bankAccount.id])

  if (debitCard.rows.length) {
    // Push to debit card (instant)
    await cardNetwork.pushToCard({
      cardToken: debitCard.rows[0].token,
      amount,
      reference: `venmo_cashout_${userId}`
    })
  } else {
    // RTP (Real-Time Payments) to bank
    await rtpNetwork.send({
      routingNumber: bankAccount.routing_number,
      accountNumber: bankAccount.account_number,
      amount,
      reference: `venmo_cashout_${userId}`
    })
  }
}
```

### 5. Bill Splitting

**Group Payment Splits:**
```javascript
async function createSplit(creatorId, totalAmount, participants, note) {
  // Calculate per-person amount
  const splitAmount = Math.floor(totalAmount / participants.length)
  const remainder = totalAmount - (splitAmount * participants.length)

  const split = await db.transaction(async (tx) => {
    // Create split record
    const split = await tx.query(`
      INSERT INTO splits (creator_id, total_amount, note, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING *
    `, [creatorId, totalAmount, note])

    // Create participant records
    for (let i = 0; i < participants.length; i++) {
      const userId = participants[i]
      // First person pays remainder
      const amount = i === 0 ? splitAmount + remainder : splitAmount

      await tx.query(`
        INSERT INTO split_participants (split_id, user_id, amount, status)
        VALUES ($1, $2, $3, $4)
      `, [split.rows[0].id, userId, amount, userId === creatorId ? 'paid' : 'pending'])
    }

    return split.rows[0]
  })

  // Send requests to all participants (except creator)
  for (const userId of participants) {
    if (userId !== creatorId) {
      await createRequest(creatorId, userId, splitAmount, `Split: ${note}`)
    }
  }

  return split
}

async function getSplitStatus(splitId) {
  const participants = await db.query(`
    SELECT sp.*, u.name, u.avatar_url
    FROM split_participants sp
    JOIN users u ON sp.user_id = u.id
    WHERE sp.split_id = $1
  `, [splitId])

  const total = participants.rows.length
  const paid = participants.rows.filter(p => p.status === 'paid').length

  return {
    participants: participants.rows,
    progress: `${paid}/${total} paid`,
    isComplete: paid === total
  }
}
```

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(100),
  avatar_url VARCHAR(500),
  pin_hash VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Wallets (one per user)
CREATE TABLE wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  balance INTEGER DEFAULT 0, -- In cents
  pending_balance INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Payment Methods
CREATE TABLE payment_methods (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  type VARCHAR(20) NOT NULL, -- 'bank', 'card', 'debit_card'
  is_default BOOLEAN DEFAULT FALSE,
  last4 VARCHAR(4),
  bank_name VARCHAR(100),
  routing_number VARCHAR(20),
  account_number_encrypted BYTEA,
  card_token VARCHAR(100),
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Transfers
CREATE TABLE transfers (
  id UUID PRIMARY KEY,
  sender_id UUID REFERENCES users(id),
  receiver_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  note TEXT,
  visibility VARCHAR(20) DEFAULT 'public', -- 'public', 'friends', 'private'
  status VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transfers_sender ON transfers(sender_id, created_at DESC);
CREATE INDEX idx_transfers_receiver ON transfers(receiver_id, created_at DESC);

-- Payment Requests
CREATE TABLE payment_requests (
  id UUID PRIMARY KEY,
  requester_id UUID REFERENCES users(id),
  requestee_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  note TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  transfer_id UUID REFERENCES transfers(id),
  reminder_sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Cashouts
CREATE TABLE cashouts (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  fee INTEGER DEFAULT 0,
  speed VARCHAR(20) NOT NULL, -- 'instant', 'standard'
  status VARCHAR(20) NOT NULL,
  estimated_arrival TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Bill Splits
CREATE TABLE splits (
  id UUID PRIMARY KEY,
  creator_id UUID REFERENCES users(id),
  total_amount INTEGER NOT NULL,
  note TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE split_participants (
  split_id UUID REFERENCES splits(id),
  user_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  paid_at TIMESTAMP,
  PRIMARY KEY (split_id, user_id)
);

-- Friendships
CREATE TABLE friendships (
  user_id UUID REFERENCES users(id),
  friend_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id)
);
```

---

## Key Design Decisions

### 1. Balance as Source of Truth

**Decision**: Use PostgreSQL balance column with row-level locking

**Rationale**:
- Strong consistency required
- Simple atomic updates
- FOR UPDATE prevents race conditions

### 2. Fan-Out on Write for Feed

**Decision**: Pre-compute feeds, don't query on read

**Rationale**:
- Fast read times
- Predictable performance
- Scales with write capacity

### 3. Funding Waterfall

**Decision**: Automatic source selection (balance → bank → card)

**Rationale**:
- Best UX (user doesn't choose each time)
- Minimizes fees (bank is free)
- Matches user expectation

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Balance storage | PostgreSQL | Ledger/Event sourcing | Simplicity, consistency |
| Feed architecture | Fan-out on write | Fan-in on read | Read performance |
| Transfer speed | Instant (in-app) | Batch processing | User experience |
| Funding | Automatic waterfall | User selects each time | UX simplicity |
