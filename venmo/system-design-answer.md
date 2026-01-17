# Design Venmo - System Design Interview Answer

## Introduction (2 minutes)

"Thank you for having me. Today I'll design Venmo, a peer-to-peer payment platform with social features. Venmo is interesting because it combines:

1. Financial accuracy requirements like any payment system
2. Real-time social feeds showing transaction activity
3. Multi-source funding where payments can draw from balance, bank, or card
4. Instant transfers between users

The unique challenge is balancing financial consistency with social scalability.

Let me clarify the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our core product:

1. **Send Money**: Transfer funds to another user instantly
2. **Request Money**: Ask another user to pay you
3. **Social Feed**: See friend's transactions (with privacy controls)
4. **Wallet Balance**: Maintain a Venmo balance, funded by transfers or cashout
5. **Cashout**: Transfer balance to bank account (instant or standard)

I'll focus on the wallet/balance system and social feed since those are the most technically interesting."

### Non-Functional Requirements

"Key constraints:

- **Transfer Latency**: Under 500ms for P2P transfers (user to user)
- **Balance Consistency**: Balances must always be accurate - no negative balances, no double-spends
- **Availability**: 99.99% for transfers
- **Scale**: 80+ million users with high volume on weekends (restaurant bills, rent)

The consistency requirement is absolute. Unlike a social network where eventual consistency is fine, financial balances must be immediately consistent."

---

## High-Level Design (10 minutes)

### Architecture Overview

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

### Service Responsibilities

**Transfer Service**: Handles the core money movement - sending, requesting, bill splitting. Coordinates with Wallet Service for balance checks.

**Feed Service**: Manages the social transaction feed. Uses fan-out-on-write for fast reads.

**Wallet Service**: Manages balances, linked payment methods, and cashout. This is the financial source of truth."

---

## Deep Dive: Wallet & Balance Management (12 minutes)

### The Core Challenge

"The fundamental challenge is preventing race conditions that could lead to:
- Negative balances (spending more than you have)
- Double-spends (same funds used twice)
- Lost funds (money disappears during transfer)

We need atomic operations with proper locking."

### Transfer Flow

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

    // Check if sufficient funds available
    const available = await getAvailableBalance(tx, senderId, senderWallet.rows[0])
    if (available < amount) {
      throw new Error('Insufficient funds')
    }

    // Determine funding source (waterfall logic)
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

  // Invalidate balance caches
  await invalidateBalanceCache(senderId)
  await invalidateBalanceCache(receiverId)

  // Publish to feed (async)
  await publishToFeed(transfer)

  // Send notifications
  await notifyTransfer(transfer)

  return transfer
}
```

Key points:
- `SELECT FOR UPDATE` locks the sender's wallet row
- All balance changes happen in one transaction
- Cache invalidation after commit
- Feed and notifications are async (can tolerate delay)"

### Funding Waterfall

"When a user sends money, where does it come from?

```javascript
async function determineFunding(tx, userId, amount, wallet) {
  let remaining = amount
  const plan = { fromBalance: 0, fromExternal: 0, source: null }

  // Priority 1: Use Venmo balance (free)
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

This waterfall gives the best UX - users don't have to think about funding, we automatically pick the cheapest option."

---

## Deep Dive: Social Feed (10 minutes)

### Fan-Out on Write

"Venmo's feed shows transactions from friends. We use fan-out-on-write: when a transfer happens, we pre-compute who should see it.

```javascript
async function publishToFeed(transfer) {
  if (transfer.visibility === 'private') {
    // Only sender and receiver see it
    await addToFeed(transfer.sender_id, transfer)
    await addToFeed(transfer.receiver_id, transfer)
    return
  }

  // Get friends of both sender and receiver
  const friends = await getFriendsUnion(transfer.sender_id, transfer.receiver_id)

  // Fan out to all friends' feeds
  for (const friendId of friends) {
    await addToFeed(friendId, transfer)
  }
}

async function addToFeed(userId, transfer) {
  await cassandra.execute(`
    INSERT INTO feed_items
    (user_id, timestamp, transfer_id, sender_id, receiver_id, amount, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, Date.now(), transfer.id, transfer.sender_id,
      transfer.receiver_id, transfer.amount, transfer.note])
}
```"

### Why Fan-Out on Write?

"The alternative is fan-in on read: when viewing feed, query all friends' transactions and merge.

Fan-out on write is better for Venmo because:
- Reads are frequent (opening app), writes are less frequent
- Feed reads need to be fast (< 100ms)
- Users have reasonable friend counts (not millions)

The tradeoff is storage (duplicate data) and write amplification, but storage is cheap and writes can be async."

### Reading the Feed

```javascript
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

  // Hydrate with user details
  return hydrateWithUsers(result.rows)
}
```

Cassandra is perfect here:
- Time-series access pattern (latest items first)
- High write throughput for fan-out
- Easy horizontal scaling"

---

## Deep Dive: Payment Requests (5 minutes)

### Request Flow

```javascript
async function createRequest(requesterId, requesteeId, amount, note) {
  const request = await db.query(`
    INSERT INTO payment_requests (requester_id, requestee_id, amount, note, status)
    VALUES ($1, $2, $3, $4, 'pending')
    RETURNING *
  `, [requesterId, requesteeId, amount, note])

  // Send push notification
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

  // Verify payer is the requestee
  if (request.rows[0].requestee_id !== payerId) {
    throw new Error('Unauthorized')
  }

  // Process as normal transfer
  const transferResult = await transfer(
    payerId,
    request.rows[0].requester_id,
    request.rows[0].amount,
    request.rows[0].note,
    'public'
  )

  // Mark request as paid
  await db.query(`
    UPDATE payment_requests
    SET status = 'paid', paid_at = NOW(), transfer_id = $2
    WHERE id = $1
  `, [requestId, transferResult.id])

  return transferResult
}
```

Requests are just a wrapper around transfers with pending state and notifications."

---

## Deep Dive: Instant Cashout (5 minutes)

### Cashout Options

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
    // Instant via debit card push (1.5%, max $15)
    fee = Math.min(Math.round(amount * 0.015), 1500)
    deliveryDate = new Date()

    await processInstantCashout(userId, amount, defaultBank.rows[0])
  } else {
    // Standard ACH (free, 1-3 business days)
    fee = 0
    deliveryDate = getNextBusinessDay(3)

    await queueACHCashout(userId, amount, defaultBank.rows[0])
  }

  // Debit balance
  await db.query(`
    UPDATE wallets SET balance = balance - $2 WHERE user_id = $1
  `, [userId, amount])

  return { amount, fee, estimatedArrival: deliveryDate }
}
```

Instant cashout uses the debit card rails (push-to-card) or Real-Time Payments (RTP) for true real-time delivery. Standard uses ACH batch processing."

---

## Deep Dive: Bill Splitting (3 minutes)

```javascript
async function createSplit(creatorId, totalAmount, participants, note) {
  const splitAmount = Math.floor(totalAmount / participants.length)
  const remainder = totalAmount - (splitAmount * participants.length)

  const split = await db.transaction(async (tx) => {
    const split = await tx.query(`
      INSERT INTO splits (creator_id, total_amount, note, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING *
    `, [creatorId, totalAmount, note])

    for (let i = 0; i < participants.length; i++) {
      const userId = participants[i]
      const amount = i === 0 ? splitAmount + remainder : splitAmount

      await tx.query(`
        INSERT INTO split_participants (split_id, user_id, amount, status)
        VALUES ($1, $2, $3, $4)
      `, [split.rows[0].id, userId, amount, userId === creatorId ? 'paid' : 'pending'])
    }

    return split.rows[0]
  })

  // Send requests to all participants except creator
  for (const userId of participants.filter(id => id !== creatorId)) {
    await createRequest(creatorId, userId, splitAmount, `Split: ${note}`)
  }

  return split
}
```

Bill splits are just multiple payment requests bundled together with tracking."

---

## Trade-offs and Alternatives (2 minutes)

"Key decisions:

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Balance Storage | PostgreSQL + locking | Event sourcing | Simplicity, strong consistency |
| Feed Architecture | Fan-out on write | Fan-in on read | Read performance, reasonable friend counts |
| Transfer Speed | Instant in-app | Batch | User experience |
| Funding | Automatic waterfall | User selects each time | UX simplicity |

Things I'd explore with more time:
- Fraud detection for account takeover
- Dispute handling for unauthorized transfers
- QR code payments for in-person
- Recurring payments (rent, subscriptions)"

---

## Summary

"To summarize, I've designed Venmo with:

1. **Atomic balance transfers** using PostgreSQL transactions with row-level locking
2. **Funding waterfall** that automatically picks the best source (balance > bank > card)
3. **Fan-out-on-write social feed** stored in Cassandra for fast reads
4. **Payment requests** with notifications and reminders
5. **Instant and standard cashout** via push-to-card and ACH

The design prioritizes financial consistency while delivering the social, real-time experience users expect.

What would you like me to elaborate on?"
