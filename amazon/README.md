# Design Amazon - E-Commerce Platform

## Overview

A simplified Amazon-like platform demonstrating product catalog management, inventory systems, recommendation engines, and order fulfillment. This educational project focuses on building a scalable e-commerce system with complex product search and ordering workflows.

## Key Features

### 1. Product Catalog
- Hierarchical category system
- Product attributes and variants (size, color)
- Seller marketplace integration
- Product search and filtering

### 2. Inventory Management
- Real-time stock tracking
- Warehouse distribution
- Reserved inventory for carts
- Low stock alerts

### 3. Recommendations
- "Customers who bought also bought"
- Personalized homepage
- Recently viewed products
- Category-based recommendations

### 4. Order Processing
- Shopping cart management
- Checkout workflow
- Payment processing
- Order status tracking

### 5. Fulfillment
- Warehouse selection
- Shipping estimation
- Delivery tracking
- Returns processing

## Implementation Status

- [ ] Initial architecture design
- [ ] Product catalog with categories
- [ ] Inventory tracking system
- [ ] Search with Elasticsearch
- [ ] Shopping cart and checkout
- [ ] Recommendation engine
- [ ] Order management
- [ ] Local multi-instance testing
- [ ] Documentation

## Key Technical Challenges

1. **Inventory Consistency**: Preventing overselling during flash sales
2. **Product Search**: Full-text search with faceted filtering
3. **Cart Persistence**: Handling abandoned carts and inventory holds
4. **Recommendation Scale**: Computing "also bought" for millions of products
5. **Order State Machine**: Managing complex order lifecycle

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
