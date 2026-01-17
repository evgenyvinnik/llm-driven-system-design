# Design DoorDash - Food Delivery Platform

## Overview

A simplified DoorDash-like platform demonstrating real-time order tracking, restaurant aggregation, delivery optimization, and three-sided marketplace dynamics. This educational project focuses on building a food delivery system with real-time logistics.

## Key Features

### 1. Restaurant Marketplace
- Restaurant onboarding
- Menu management
- Operating hours and availability
- Order preparation time estimates

### 2. Order Management
- Cart with restaurant items
- Order placement and payment
- Real-time status updates
- Order history

### 3. Delivery Assignment
- Dasher availability tracking
- Order-to-driver matching
- Route optimization
- ETA calculation

### 4. Real-Time Tracking
- Live driver location
- Order status progression
- Push notifications
- ETA updates

### 5. Rating & Reviews
- Restaurant ratings
- Driver ratings
- Order issue reporting

## Implementation Status

- [ ] Initial architecture design
- [ ] Restaurant and menu management
- [ ] Order workflow
- [ ] Delivery assignment algorithm
- [ ] Real-time location tracking
- [ ] ETA calculation
- [ ] Rating system
- [ ] Local multi-instance testing
- [ ] Documentation

## Key Technical Challenges

1. **Three-Sided Marketplace**: Balancing customers, restaurants, and drivers
2. **Delivery Matching**: Optimal order-to-driver assignment
3. **Real-Time Tracking**: Location updates at scale
4. **ETA Accuracy**: Predicting delivery time with many variables
5. **Peak Hour Handling**: Managing surge in orders

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## Order State Machine

```
PLACED → CONFIRMED → PREPARING → READY_FOR_PICKUP → PICKED_UP → DELIVERED
  │         │           │              │                │           │
  └→ CANCELLED ←────────┴──────────────┴────────────────┘           │
                                                                     │
                                                              COMPLETED
```
