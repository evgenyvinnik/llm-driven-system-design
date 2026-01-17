# Design Venmo - P2P Payment Platform

## Overview

A simplified Venmo-like platform demonstrating peer-to-peer payments, social feeds, and instant money transfers. This educational project focuses on building a social payment network with balance management and multi-source funding.

## Key Features

### 1. P2P Payments
- Send money to friends
- Request payments
- Split bills
- Instant transfers

### 2. Social Feed
- Public/private transactions
- Comments and likes
- Friend activity
- Transaction notes

### 3. Wallet Management
- Venmo balance
- Bank account linking
- Debit card linking
- Instant cashout

### 4. Payment Methods
- Balance priority
- Bank transfer (ACH)
- Card payments
- Automatic funding

### 5. Security
- PIN verification
- Biometric auth
- Fraud detection
- Transaction limits

## Implementation Status

- [ ] Initial architecture design
- [ ] User wallet system
- [ ] P2P transfer flow
- [ ] Social feed
- [ ] Bank linking
- [ ] Instant cashout
- [ ] Bill splitting
- [ ] Documentation

## Key Technical Challenges

1. **Balance Consistency**: Accurate wallet balances across concurrent transfers
2. **Social Feed**: Real-time feed updates for millions of users
3. **Instant Transfers**: Sub-second P2P payments
4. **Funding Waterfall**: Automatic source selection for payments
5. **Fraud Prevention**: Detecting account takeover and money laundering

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
