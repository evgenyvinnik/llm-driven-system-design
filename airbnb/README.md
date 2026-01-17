# Design Airbnb - Two-Sided Marketplace

## Overview

A simplified Airbnb-like platform demonstrating two-sided marketplace dynamics, availability calendars, search ranking, and trust & safety systems. This educational project focuses on building a property rental marketplace with complex booking workflows.

## Key Features

### 1. Property Listings
- Host property management
- Photos and descriptions
- Amenities and house rules
- Pricing and availability

### 2. Search & Discovery
- Location-based search
- Date availability filtering
- Price range filtering
- Ranking algorithm

### 3. Booking System
- Availability calendar
- Instant book vs request-to-book
- Payment processing
- Cancellation policies

### 4. Trust & Safety
- Identity verification
- Reviews (two-way)
- Host/guest ratings
- Fraud detection

### 5. Messaging
- Host-guest communication
- Pre-booking inquiries
- Booking-related messages

## Implementation Status

- [ ] Initial architecture design
- [ ] Property listing management
- [ ] Availability calendar system
- [ ] Location-based search
- [ ] Booking workflow
- [ ] Review system
- [ ] Messaging system
- [ ] Local multi-instance testing
- [ ] Documentation

## Key Technical Challenges

1. **Availability Calendar**: Efficiently storing and querying date ranges
2. **Search Ranking**: Balancing relevance, price, and host quality
3. **Double-Booking Prevention**: Concurrent booking attempts
4. **Two-Sided Reviews**: Revealing after both parties submit
5. **Geographic Search**: Searching within radius efficiently

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
