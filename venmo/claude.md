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

### 2. Feed Performance

**Problem**: Generating feeds for millions of users

**Solutions:**
- Fan-out on write (precompute feeds)
- Fan-in on read (query on demand)
- Hybrid (hot users fan-out, cold users fan-in)
- Time-windowed caching

### 3. Fraud Detection

**Challenge**: Detect account takeover and money laundering

**Solutions:**
- Velocity limits per user/device
- Unusual activity detection
- Social graph analysis
- Device fingerprinting

---

## Development Phases

### Phase 1: Core Transfers
- [ ] User wallets
- [ ] P2P transfer flow
- [ ] Transaction history
- [ ] Basic notifications

### Phase 2: Social Features
- [ ] Friend connections
- [ ] Social feed
- [ ] Privacy settings
- [ ] Comments/likes

### Phase 3: Funding Sources
- [ ] Bank account linking
- [ ] Card payments
- [ ] Funding waterfall
- [ ] Instant cashout

### Phase 4: Advanced Features
- [ ] Payment requests
- [ ] Bill splitting
- [ ] Recurring payments
- [ ] QR code payments

---

## Resources

- [PayPal/Venmo Engineering Blog](https://medium.com/paypal-tech)
- [Building a Payment System](https://newsletter.pragmaticengineer.com/p/designing-a-payment-system)
- [ACH Payment Processing](https://www.nacha.org/)
