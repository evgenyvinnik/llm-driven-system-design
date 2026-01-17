# Design Venmo - Development with Claude

## Project Context

Building a peer-to-peer payment platform to understand wallet systems, social feeds, and instant money transfers.

**Key Learning Goals:**
- Build consistent wallet balance systems
- Design real-time P2P transfer flows
- Implement social transaction feeds
- Handle multi-source funding waterfall

---

## Key Challenges to Explore

### 1. Balance Consistency

**Challenge**: Prevent negative balances and double-spends

**Approaches:**
- Row-level locking (SELECT FOR UPDATE)
- Optimistic locking with version numbers
- Serializable transactions
- Event sourcing with projections

**Implemented**: Row-level locking with PostgreSQL transactions. The `transfer.js` service uses `SELECT FOR UPDATE` to lock wallet rows during transfers.

### 2. Feed Performance

**Problem**: Generating feeds for millions of users

**Solutions:**
- Fan-out on write (precompute feeds)
- Fan-in on read (query on demand)
- Hybrid (hot users fan-out, cold users fan-in)
- Time-windowed caching

**Implemented**: Fan-out on write. When a transaction occurs, feed items are inserted for the sender, receiver, and all their friends.

### 3. Fraud Detection

**Challenge**: Detect account takeover and money laundering

**Solutions:**
- Velocity limits per user/device
- Unusual activity detection
- Social graph analysis
- Device fingerprinting

**Status**: Not yet implemented - future enhancement.

---

## Development Phases

### Phase 1: Core Transfers - COMPLETED
- [x] User wallets
- [x] P2P transfer flow
- [x] Transaction history
- [x] Basic notifications (in-app)

### Phase 2: Social Features - IN PROGRESS
- [x] Friend connections
- [x] Social feed
- [x] Privacy settings (public/friends/private)
- [x] Comments/likes

### Phase 3: Funding Sources - COMPLETED
- [x] Bank account linking (simulated)
- [x] Card payments (simulated)
- [x] Funding waterfall
- [x] Instant/standard cashout

### Phase 4: Advanced Features - PARTIAL
- [x] Payment requests
- [ ] Bill splitting
- [ ] Recurring payments
- [ ] QR code payments

---

## Implementation Notes

### Transfer Service (`backend/src/services/transfer.js`)
- Uses PostgreSQL transactions with `SELECT FOR UPDATE` locking
- Implements funding waterfall: Balance -> Bank -> Card
- Fan-out to social feed after commit
- Balance cache invalidation via Redis

### Feed System
- Fan-out on write to `feed_items` table
- Visibility filtering: public, friends, private
- Hydrated with user data on read

### Authentication
- Session-based auth stored in Redis
- 24-hour session TTL
- Simple role-based access (user/admin)

---

## Resources

- [PayPal/Venmo Engineering Blog](https://medium.com/paypal-tech)
- [Building a Payment System](https://newsletter.pragmaticengineer.com/p/designing-a-payment-system)
- [ACH Payment Processing](https://www.nacha.org/)
