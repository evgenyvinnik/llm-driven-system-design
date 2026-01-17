# Local Delivery Service - Architecture Design

## System Overview

A last-mile delivery platform for local goods and services, similar to DoorDash, Instacart, or Uber Eats. The core challenges are real-time driver location tracking, efficient driver-order matching, route optimization, and handling the three-sided marketplace dynamics between customers, merchants, and drivers.

## Requirements

### Functional Requirements

1. **Order placement** - Customers order from local merchants
2. **Driver matching** - Match orders to nearby available drivers
3. **Real-time tracking** - Live driver location and ETA updates
4. **Route optimization** - Efficient routing for deliveries
5. **Notifications** - Order status updates to all parties
6. **Ratings** - Two-way ratings for drivers and customers

### Non-Functional Requirements

- **Latency**: Driver match within 30 seconds, location updates every 3 seconds
- **Scale**: Designed for 1M orders/day, 100K concurrent drivers (local demo version)
- **Availability**: 99.99% for order placement
- **Accuracy**: ETA within 3 minutes 90% of the time

## Capacity Estimation

**Order volume (production):**
- 1 million orders per day
- Peak hours (lunch/dinner): 3x average = 35 orders/second
- Average order: $25, 3 items

**Driver fleet (production):**
- 100,000 active drivers
- 30% online at any time = 30,000 concurrent
- Location updates every 3 seconds = 10,000 updates/second

**Local demo:**
- 3 test merchants
- 3 test drivers
- Sample menu items

## High-Level Architecture

```
                                    ┌─────────────────────────────────┐
                                    │          Client Apps            │
                                    │   (Customer, Driver, Admin)     │
                                    └───────────────┬─────────────────┘
                                                    │
                                         ┌──────────┴──────────┐
                                         │                     │
                                    HTTPS│                     │WebSocket
                                         │                     │
                              ┌──────────▼──────────┐  ┌───────▼───────┐
                              │     API Server      │  │  WebSocket    │
                              │    (Express.js)     │  │   Handler     │
                              └──────────┬──────────┘  └───────┬───────┘
                                         │                     │
        ┌────────────────────────────────┼─────────────────────┼──────────┐
        │                                │                     │          │
┌───────▼───────┐            ┌───────────▼───────────┐  ┌──────▼──────┐  │
│ Auth Service  │            │   Location Service    │  │  Tracking   │  │
│               │            │                       │  │  Service    │  │
│ - Register    │            │ - Driver positions    │  │             │  │
│ - Login       │            │ - Geo indexing        │  │ - Pub/Sub   │  │
│ - Sessions    │            │ - Nearby search       │  │ - ETA       │  │
└───────────────┘            └───────────┬───────────┘  └─────────────┘  │
                                         │                               │
┌───────────────┐            ┌───────────▼───────────┐                   │
│ Order Service │            │   Matching Service    │                   │
│               │            │                       │                   │
│ - Create      │            │ - Driver selection    │                   │
│ - Update      │            │ - Scoring algorithm   │                   │
│ - History     │            │ - Offer management    │                   │
└───────┬───────┘            └───────────────────────┘                   │
        │                                                                 │
        └─────────────────────────────┬───────────────────────────────────┘
                                      │
                   ┌──────────────────┼──────────────────┐
                   │                  │                  │
            ┌──────▼──────┐   ┌───────▼───────┐  ┌──────▼──────┐
            │  PostgreSQL │   │     Redis     │  │   Redis     │
            │             │   │  (Geo Index)  │  │  (Pub/Sub)  │
            │ - Users     │   │               │  │             │
            │ - Orders    │   │ - Locations   │  │ - Events    │
            │ - Merchants │   │ - Sessions    │  │ - Updates   │
            └─────────────┘   └───────────────┘  └─────────────┘
```

### Core Components

1. **Auth Service**
   - User registration and login
   - Session-based authentication with Redis
   - Role-based access control (customer, driver, merchant, admin)

2. **Order Service**
   - Order lifecycle management
   - State machine (pending -> confirmed -> preparing -> picked_up -> delivered)
   - Order items and pricing

3. **Location Service**
   - Ingests driver location updates
   - Maintains real-time geo index in Redis
   - Supports nearby driver queries using GEORADIUS

4. **Matching Service**
   - Assigns orders to drivers
   - Scoring algorithm considers distance, rating, acceptance rate, current load
   - Handles driver acceptance/rejection with 30-second timeout

5. **Tracking Service**
   - Real-time location streaming to customers via WebSocket
   - ETA calculations based on Haversine distance
   - Redis Pub/Sub for message distribution

## Data Model

### Entity-Relationship Diagram

```
                                    ┌─────────────────────────┐
                                    │      users              │
                                    │─────────────────────────│
                                    │ id (PK, UUID)           │
                                    │ email (UNIQUE)          │
                                    │ password_hash           │
                                    │ name                    │
                                    │ phone                   │
                                    │ role                    │
                                    │ created_at, updated_at  │
                                    └───────────┬─────────────┘
                                                │
              ┌─────────────────────────────────┼─────────────────────────────────┐
              │                                 │                                 │
              │ 1:1 (id = users.id)             │ 1:N (owner_id)                  │ 1:N (user_id)
              ▼                                 │                                 ▼
┌─────────────────────────────┐                 │                   ┌─────────────────────────────┐
│       drivers               │                 │                   │       sessions              │
│─────────────────────────────│                 │                   │─────────────────────────────│
│ id (PK, FK -> users)        │                 │                   │ id (PK, UUID)               │
│ vehicle_type                │                 │                   │ user_id (FK -> users)       │
│ license_plate               │                 │                   │ token (UNIQUE)              │
│ status                      │                 │                   │ expires_at                  │
│ rating, total_deliveries    │                 │                   │ created_at                  │
│ acceptance_rate             │                 │                   └─────────────────────────────┘
│ current_lat, current_lng    │                 │
│ location_updated_at         │                 ▼
│ created_at, updated_at      │   ┌─────────────────────────────┐
└──────────────┬──────────────┘   │       merchants             │
               │                  │─────────────────────────────│
               │                  │ id (PK, UUID)               │
               │                  │ owner_id (FK -> users)      │
               │                  │ name, description           │
               │                  │ address, lat, lng           │
               │                  │ category                    │
               │                  │ avg_prep_time_minutes       │
               │                  │ rating, is_open             │
               │                  │ opens_at, closes_at         │
               │                  │ created_at, updated_at      │
               │                  └──────────────┬──────────────┘
               │                                 │
               │  1:N (driver_id)                │  1:N (merchant_id)
               │                                 ▼
               │                  ┌─────────────────────────────┐
               │                  │       menu_items            │
               │                  │─────────────────────────────│
               │                  │ id (PK, UUID)               │
               │                  │ merchant_id (FK -> merchants│
               │                  │ name, description, price    │
               │                  │ category, image_url         │
               │                  │ is_available                │
               │                  │ created_at, updated_at      │
               │                  └──────────────┬──────────────┘
               │                                 │
               │                                 │  N:1 (menu_item_id)
               ▼                                 │
┌─────────────────────────────┐                  │
│       orders                │◄─────────────────┘
│─────────────────────────────│
│ id (PK, UUID)               │
│ customer_id (FK -> users)   │◄──────── 1:N from users (customer role)
│ merchant_id (FK -> merchants│
│ driver_id (FK -> drivers)   │
│ status                      │
│ delivery_address/lat/lng    │
│ subtotal, delivery_fee, tip │
│ total                       │
│ estimated_prep_time_minutes │
│ estimated_delivery_time     │
│ archived_at, retention_days │◄──────── Retention policy columns
│ timestamps (created, etc.)  │
└──────────────┬──────────────┘
               │
               │  1:N (order_id)
    ┌──────────┼──────────┬───────────────┐
    ▼          ▼          ▼               ▼
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────────────┐
│order_items │ │driver_offers│ │  ratings   │ │driver_location_history │
│────────────│ │────────────│ │────────────│ │────────────────────────│
│id (PK)     │ │id (PK)     │ │id (PK)     │ │id (PK)                 │
│order_id FK │ │order_id FK │ │order_id FK │ │driver_id (FK -> drivers│
│menu_item_id│ │driver_id FK│ │rater_id FK │ │lat, lng                │
│name, qty   │ │status      │ │rated_user  │ │speed, heading          │
│unit_price  │ │offered_at  │ │rated_merch │ │recorded_at             │
│special_inst│ │expires_at  │ │rating 1-5  │ └────────────────────────┘
│created_at  │ │responded_at│ │comment     │
└────────────┘ └────────────┘ │created_at  │
                              └────────────┘

┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌─────────────────────────────┐
│     delivery_zones          │  │     idempotency_keys        │  │     retention_policies      │
│─────────────────────────────│  │─────────────────────────────│  │─────────────────────────────│
│ id (PK, UUID)               │  │ key (PK, VARCHAR(64))       │  │ id (PK, UUID)               │
│ name                        │  │ user_id (FK -> users)       │  │ table_name (UNIQUE)         │
│ center_lat, center_lng      │  │ operation                   │  │ hot_storage_days            │
│ radius_km                   │  │ response (JSONB)            │  │ warm_storage_days           │
│ is_active                   │  │ status                      │  │ archive_enabled             │
│ base_delivery_fee           │  │ created_at, expires_at      │  │ last_cleanup_at             │
│ per_km_fee                  │  └─────────────────────────────┘  │ created_at, updated_at      │
│ created_at                  │                                   └─────────────────────────────┘
└─────────────────────────────┘
```

### Complete PostgreSQL Schema

#### 1. Users Table
Central identity table for all user types in the system.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| email | VARCHAR(255) | UNIQUE NOT NULL | Login email address |
| password_hash | VARCHAR(255) | NOT NULL | Bcrypt hashed password |
| name | VARCHAR(255) | NOT NULL | Display name |
| phone | VARCHAR(20) | | Contact phone number |
| role | VARCHAR(20) | NOT NULL, CHECK | One of: 'customer', 'driver', 'merchant', 'admin' |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Account creation time |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last modification (trigger-updated) |

**Design Rationale:** Single table for all user types with role-based access control. Drivers and merchants have extended tables linked by the same UUID. This simplifies authentication while allowing role-specific attributes.

#### 2. Drivers Table
Extended profile for users with role='driver'.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, FK -> users(id) ON DELETE CASCADE | Same as user ID (1:1 relationship) |
| vehicle_type | VARCHAR(20) | NOT NULL, CHECK | 'bicycle', 'motorcycle', 'car', 'van' |
| license_plate | VARCHAR(20) | | Vehicle registration (null for bicycles) |
| status | VARCHAR(20) | NOT NULL DEFAULT 'offline', CHECK | 'offline', 'available', 'busy' |
| rating | DECIMAL(3,2) | DEFAULT 5.00 | Average rating (1.00-5.00) |
| total_deliveries | INTEGER | DEFAULT 0 | Lifetime completed deliveries |
| acceptance_rate | DECIMAL(5,4) | DEFAULT 1.0000 | Offer acceptance ratio (0.0000-1.0000) |
| current_lat | DECIMAL(10,8) | | Last known latitude |
| current_lng | DECIMAL(11,8) | | Last known longitude |
| location_updated_at | TIMESTAMP | | When location was last updated |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Driver profile creation |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last modification |

**Design Rationale:** Inherits from users via same UUID (not a separate FK). This enforces 1:1 relationship and allows the user to be deleted with cascade to driver record. Location stored here is the "persistent" last-known location; real-time location is in Redis.

#### 3. Merchants Table
Business profiles that offer products for delivery.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| owner_id | UUID | FK -> users(id) ON DELETE SET NULL | User who manages this merchant |
| name | VARCHAR(255) | NOT NULL | Business name |
| description | TEXT | | Business description |
| address | TEXT | NOT NULL | Full street address |
| lat | DECIMAL(10,8) | NOT NULL | Pickup location latitude |
| lng | DECIMAL(11,8) | NOT NULL | Pickup location longitude |
| category | VARCHAR(50) | NOT NULL | Business type (pizza, burgers, sushi, etc.) |
| avg_prep_time_minutes | INTEGER | DEFAULT 15 | Typical order preparation time |
| rating | DECIMAL(3,2) | DEFAULT 5.00 | Average customer rating |
| is_open | BOOLEAN | DEFAULT true | Currently accepting orders |
| opens_at | TIME | DEFAULT '09:00' | Daily opening time |
| closes_at | TIME | DEFAULT '22:00' | Daily closing time |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Profile creation |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last modification |

**Design Rationale:** ON DELETE SET NULL for owner_id allows merchant to remain if owner account is deleted (business continuity). Separate from users table because a merchant is a business entity, not a person.

#### 4. Menu Items Table
Products available for order from merchants.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| merchant_id | UUID | FK -> merchants(id) ON DELETE CASCADE | Owning merchant |
| name | VARCHAR(255) | NOT NULL | Item name |
| description | TEXT | | Item description |
| price | DECIMAL(10,2) | NOT NULL | Current price |
| category | VARCHAR(50) | | Item category (pizza, sides, drinks) |
| image_url | TEXT | | Product image URL |
| is_available | BOOLEAN | DEFAULT true | Currently available for order |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Item creation |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last modification |

**Design Rationale:** ON DELETE CASCADE because menu items have no meaning without their merchant. Price stored here is the current price; order_items stores the price at time of order.

#### 5. Orders Table
Core transaction table tracking customer orders.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| customer_id | UUID | FK -> users(id) ON DELETE SET NULL | Ordering customer |
| merchant_id | UUID | FK -> merchants(id) ON DELETE SET NULL | Source merchant |
| driver_id | UUID | FK -> drivers(id) ON DELETE SET NULL | Assigned driver |
| status | VARCHAR(30) | NOT NULL DEFAULT 'pending', CHECK | Order lifecycle state |
| delivery_address | TEXT | NOT NULL | Full delivery address |
| delivery_lat | DECIMAL(10,8) | NOT NULL | Delivery latitude |
| delivery_lng | DECIMAL(11,8) | NOT NULL | Delivery longitude |
| delivery_instructions | TEXT | | Special delivery notes |
| subtotal | DECIMAL(10,2) | NOT NULL | Sum of item prices |
| delivery_fee | DECIMAL(10,2) | NOT NULL DEFAULT 0 | Delivery charge |
| tip | DECIMAL(10,2) | DEFAULT 0 | Driver tip |
| total | DECIMAL(10,2) | NOT NULL | subtotal + delivery_fee + tip |
| estimated_prep_time_minutes | INTEGER | | Merchant's prep time estimate |
| estimated_delivery_time | TIMESTAMP | | Predicted delivery time |
| actual_delivery_time | TIMESTAMP | | Actual delivery time |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Order placed |
| confirmed_at | TIMESTAMP | | Merchant confirmed |
| picked_up_at | TIMESTAMP | | Driver picked up |
| delivered_at | TIMESTAMP | | Order delivered |
| cancelled_at | TIMESTAMP | | Order cancelled |
| cancellation_reason | TEXT | | Why cancelled |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last modification |
| archived_at | TIMESTAMP | | When archived to cold storage |
| retention_days | INTEGER | DEFAULT 90 | Override retention period |

**Status Values:** 'pending', 'confirmed', 'preparing', 'ready_for_pickup', 'driver_assigned', 'picked_up', 'in_transit', 'delivered', 'cancelled'

**Design Rationale:** ON DELETE SET NULL for all FKs preserves order history even if users/merchants/drivers are deleted. Timestamps for each state transition enable SLA tracking and analytics. Archival columns support data lifecycle management.

#### 6. Order Items Table
Line items within an order.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| order_id | UUID | FK -> orders(id) ON DELETE CASCADE | Parent order |
| menu_item_id | UUID | FK -> menu_items(id) ON DELETE SET NULL | Original menu item |
| name | VARCHAR(255) | NOT NULL | Item name (denormalized) |
| quantity | INTEGER | NOT NULL DEFAULT 1 | Number of items |
| unit_price | DECIMAL(10,2) | NOT NULL | Price at time of order |
| special_instructions | TEXT | | Customer customization notes |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Item added |

**Design Rationale:** ON DELETE CASCADE because items are meaningless without their order. Name and unit_price are denormalized from menu_items to preserve historical accuracy if menu changes.

#### 7. Driver Offers Table
Tracks order assignments and driver responses.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| order_id | UUID | FK -> orders(id) ON DELETE CASCADE | Order being offered |
| driver_id | UUID | FK -> drivers(id) ON DELETE CASCADE | Driver receiving offer |
| status | VARCHAR(20) | NOT NULL DEFAULT 'pending', CHECK | 'pending', 'accepted', 'rejected', 'expired' |
| offered_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | When offer was sent |
| expires_at | TIMESTAMP | NOT NULL | Deadline for response |
| responded_at | TIMESTAMP | | When driver responded |

**Design Rationale:** ON DELETE CASCADE for both FKs because offer history is tied to specific orders and drivers. Enables tracking of acceptance rates and matching algorithm performance.

#### 8. Ratings Table
Two-way ratings for completed deliveries.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| order_id | UUID | FK -> orders(id) ON DELETE CASCADE | Related order |
| rater_id | UUID | FK -> users(id) ON DELETE SET NULL | User giving rating |
| rated_user_id | UUID | FK -> users(id) ON DELETE SET NULL | User being rated (driver or customer) |
| rated_merchant_id | UUID | FK -> merchants(id) ON DELETE SET NULL | Merchant being rated |
| rating | INTEGER | NOT NULL, CHECK (1-5) | Star rating |
| comment | TEXT | | Review text |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Rating submitted |

**Design Rationale:** Flexible schema allows rating drivers, customers, or merchants from the same table. Only one of rated_user_id or rated_merchant_id is set per record.

#### 9. Delivery Zones Table
Geographic areas with pricing configuration.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| name | VARCHAR(100) | NOT NULL | Zone name |
| center_lat | DECIMAL(10,8) | NOT NULL | Zone center latitude |
| center_lng | DECIMAL(11,8) | NOT NULL | Zone center longitude |
| radius_km | DECIMAL(5,2) | NOT NULL | Coverage radius |
| is_active | BOOLEAN | DEFAULT true | Zone accepting orders |
| base_delivery_fee | DECIMAL(10,2) | DEFAULT 2.99 | Minimum delivery fee |
| per_km_fee | DECIMAL(10,2) | DEFAULT 0.50 | Per-kilometer charge |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Zone creation |

**Design Rationale:** Circular zones simplify containment checks (Haversine distance < radius). Per-zone pricing enables location-based fee structures.

#### 10. Sessions Table
Authentication sessions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| user_id | UUID | FK -> users(id) ON DELETE CASCADE | Session owner |
| token | VARCHAR(255) | UNIQUE NOT NULL | Session token |
| expires_at | TIMESTAMP | NOT NULL | Expiration time |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Session creation |

**Design Rationale:** ON DELETE CASCADE automatically invalidates sessions when user is deleted. Primarily used as backup to Redis session cache.

#### 11. Driver Location History Table
Historical location data for analytics.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| driver_id | UUID | FK -> drivers(id) ON DELETE CASCADE | Driver tracked |
| lat | DECIMAL(10,8) | NOT NULL | Latitude |
| lng | DECIMAL(11,8) | NOT NULL | Longitude |
| speed | DECIMAL(6,2) | | Speed in km/h |
| heading | DECIMAL(5,2) | | Direction in degrees |
| recorded_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Recording time |

**Design Rationale:** Separate from drivers table for time-series data. High-volume table with retention policy (7 days hot, then archived).

#### 12. Idempotency Keys Table
Prevents duplicate operations on network retry.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| key | VARCHAR(64) | PRIMARY KEY | Client-provided unique key |
| user_id | UUID | FK -> users(id) ON DELETE CASCADE | Key owner |
| operation | VARCHAR(50) | NOT NULL | Operation type (create_order, etc.) |
| response | JSONB | | Cached response for completed ops |
| status | VARCHAR(20) | NOT NULL DEFAULT 'pending', CHECK | 'pending', 'completed', 'failed' |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Key creation |
| expires_at | TIMESTAMP | NOT NULL | Key expiration |

**Design Rationale:** Enables exactly-once semantics for critical operations like order creation. Keys expire after 24 hours to prevent unbounded table growth.

#### 13. Retention Policies Table
Data lifecycle configuration per table.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique identifier |
| table_name | VARCHAR(100) | UNIQUE NOT NULL | Target table |
| hot_storage_days | INTEGER | NOT NULL DEFAULT 30 | Days in primary storage |
| warm_storage_days | INTEGER | NOT NULL DEFAULT 365 | Days before archival |
| archive_enabled | BOOLEAN | DEFAULT true | Whether to archive |
| last_cleanup_at | TIMESTAMP | | Last cleanup job run |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Policy creation |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last modification |

**Design Rationale:** Centralized configuration for data lifecycle management. Enables automated cleanup jobs to manage database size.

### Foreign Key Relationships and Cascade Behaviors

| Parent Table | Child Table | FK Column | ON DELETE Behavior | Rationale |
|--------------|-------------|-----------|-------------------|-----------|
| users | drivers | id | CASCADE | Driver profile is meaningless without user |
| users | merchants | owner_id | SET NULL | Keep merchant for business continuity |
| users | orders | customer_id | SET NULL | Preserve order history |
| users | sessions | user_id | CASCADE | Sessions should be deleted with user |
| users | ratings (rater) | rater_id | SET NULL | Keep rating, just anonymize |
| users | ratings (rated) | rated_user_id | SET NULL | Keep rating, just anonymize |
| users | idempotency_keys | user_id | CASCADE | Keys are user-specific |
| drivers | orders | driver_id | SET NULL | Preserve order history |
| drivers | driver_offers | driver_id | CASCADE | Offers are driver-specific |
| drivers | driver_location_history | driver_id | CASCADE | History is driver-specific |
| merchants | menu_items | merchant_id | CASCADE | Menu belongs to merchant |
| merchants | orders | merchant_id | SET NULL | Preserve order history |
| merchants | ratings | rated_merchant_id | SET NULL | Keep rating, just anonymize |
| orders | order_items | order_id | CASCADE | Items belong to order |
| orders | driver_offers | order_id | CASCADE | Offers are order-specific |
| orders | ratings | order_id | CASCADE | Rating belongs to order |
| menu_items | order_items | menu_item_id | SET NULL | Keep ordered item history |

### Database Indexes

| Index Name | Table | Columns | Type | Purpose |
|------------|-------|---------|------|---------|
| idx_orders_status | orders | status | B-tree | Filter by order status |
| idx_orders_customer | orders | customer_id | B-tree | Customer order history |
| idx_orders_driver | orders | driver_id | Partial (active statuses) | Active driver orders |
| idx_orders_merchant | orders | merchant_id | B-tree | Merchant order history |
| idx_orders_created | orders | created_at DESC | B-tree | Recent orders listing |
| idx_orders_archive | orders | created_at, archived_at | Partial (not archived) | Archive job queries |
| idx_drivers_status | drivers | status | B-tree | Available driver lookup |
| idx_drivers_location | drivers | current_lat, current_lng | Partial (available) | Nearby driver search |
| idx_merchants_location | merchants | lat, lng | B-tree | Nearby merchant search |
| idx_merchants_category | merchants | category | B-tree | Category filtering |
| idx_menu_items_merchant | menu_items | merchant_id | B-tree | Menu listing |
| idx_driver_offers_order | driver_offers | order_id | B-tree | Offers per order |
| idx_driver_offers_driver | driver_offers | driver_id | B-tree | Offers per driver |
| idx_sessions_token | sessions | token | B-tree | Session lookup |
| idx_sessions_user | sessions | user_id | B-tree | User sessions |
| idx_driver_location_history | driver_location_history | driver_id, recorded_at DESC | B-tree | Driver path queries |
| idx_idempotency_keys_expires | idempotency_keys | expires_at | B-tree | Cleanup job |
| idx_idempotency_keys_user | idempotency_keys | user_id | B-tree | User key lookup |

### Data Flow Between Tables

#### Order Placement Flow
```
1. Customer (users.role='customer') selects items from menu_items
2. Order created in orders with customer_id, merchant_id, status='pending'
3. Order items copied to order_items with denormalized name/price
4. Matching service finds nearby drivers (via Redis geo-index)
5. Driver offers created in driver_offers with 30-second expiry
6. When driver accepts, orders.driver_id set, status='driver_assigned'
7. Status transitions recorded via timestamp columns
8. Rating created in ratings after delivery
```

#### Driver Location Flow
```
1. Driver logs in, session created in sessions
2. Driver goes online, drivers.status='available'
3. Location updates: Redis GEOADD (real-time) + drivers.current_lat/lng (persistent)
4. Historical points logged to driver_location_history (analytics)
5. Retention job archives location history after 7 days
```

#### Idempotency Flow
```
1. Client generates unique idempotency key
2. Request arrives with X-Idempotency-Key header
3. Check idempotency_keys for existing key
4. If found + completed: return cached response
5. If not found: create pending record, execute operation
6. On success: update to completed with response JSONB
7. Cleanup job removes expired keys daily
```

### Redis Data Structures

```
# Driver locations (geo index)
drivers:locations          -> GEOADD (lng, lat, driver_id)

# Driver metadata
driver:{id}                -> HASH (lat, lng, status, updated_at)

# Active orders by driver
driver:{id}:orders         -> SET [order_ids]

# Session storage
session:{token}            -> JSON (userId, expiresAt)

# Real-time location pubsub
driver:{id}:location       -> PUBSUB channel
order:{id}:status          -> PUBSUB channel
```

## API Design

### Customer API
- `GET /api/v1/merchants` - Browse nearby merchants
- `GET /api/v1/merchants/:id/menu` - Get menu
- `POST /api/v1/orders` - Place order
- `GET /api/v1/orders/:id` - Get order details
- WebSocket: Subscribe to order tracking

### Driver API
- `POST /api/v1/driver/go-online` - Start accepting orders
- `POST /api/v1/driver/go-offline` - Stop accepting orders
- `POST /api/v1/driver/location` - Update location
- `POST /api/v1/driver/offers/:id/accept` - Accept order
- `POST /api/v1/driver/orders/:id/delivered` - Complete delivery

### Admin API
- `GET /api/v1/admin/stats` - Dashboard statistics
- `GET /api/v1/admin/orders` - View all orders
- `GET /api/v1/admin/drivers` - View all drivers

## Key Design Decisions

### 1. Real-time Driver Location with Redis Geo

Using Redis GEOADD/GEORADIUS for driver location tracking:
- Sub-millisecond query times for nearby driver searches
- Efficient for real-time matching requirements
- Location updates published via Redis Pub/Sub

### 2. Scoring-based Driver Matching

Driver selection algorithm considers multiple factors:
- Distance to pickup (40% weight)
- Driver rating (25% weight)
- Acceptance rate (20% weight)
- Current order load (15% weight)

### 3. WebSocket for Real-time Updates

- Customers subscribe to order updates
- Drivers receive new offers in real-time
- Location updates streamed to tracking subscribers

### 4. Session-based Authentication

- Tokens stored in Redis with TTL
- Fast validation without database queries
- Easy session invalidation on logout

## Technology Stack

- **Frontend**: React 19, TypeScript, Vite, Tanstack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, WebSocket (ws library)
- **Database**: PostgreSQL 16
- **Cache/Geo**: Redis 7
- **Containerization**: Docker Compose

## Scalability Considerations

### Geographic Sharding (Production)
- Partition by city/region
- Each region has its own Redis instance for geo queries
- Cross-region queries routed appropriately

### Horizontal Scaling
- Stateless API servers behind load balancer
- Redis Cluster for geo operations
- PostgreSQL read replicas for query scaling

### Current Local Setup
- Single PostgreSQL instance
- Single Redis instance
- Multiple API server instances on different ports

## Trade-offs and Alternatives

| Decision | Trade-off |
|----------|-----------|
| Redis geo-index | Fast queries, but data loss risk on failure |
| 3-second location updates | Accuracy vs. bandwidth/battery |
| Sequential driver offers | Fair, but slower matching |
| Session tokens in Redis | Fast validation, but requires Redis availability |

### Alternatives Considered

1. **PostgreSQL PostGIS for locations**
   - More durable
   - Slower for real-time queries
   - Better for historical analysis

2. **JWT for authentication**
   - Stateless
   - Cannot revoke tokens instantly
   - More complex refresh flow

3. **Socket.io instead of WebSocket**
   - More features (rooms, acknowledgments)
   - Higher overhead
   - Native WebSocket sufficient for our needs

## Monitoring and Observability

### Metrics to Track
- Order placement rate
- Driver acceptance rate
- Average delivery time
- ETA accuracy
- WebSocket connection count
- Redis geo query latency

### Health Checks
- `/health` endpoint checks PostgreSQL and Redis connectivity

## Security Considerations

- Password hashing with bcrypt
- Session tokens with expiration
- Role-based access control
- Input validation on all endpoints
- CORS configuration for frontend

## Consistency and Idempotency Semantics

### Consistency Model by Entity

| Entity | Consistency | Rationale |
|--------|-------------|-----------|
| Orders | Strong (PostgreSQL transactions) | Order state transitions must be atomic; no duplicate orders or lost payments |
| Driver locations | Eventual (Redis, 3-second lag acceptable) | Stale location is tolerable; freshness traded for throughput |
| Session tokens | Eventual (Redis, TTL-based) | Logout propagation within seconds is acceptable |
| Ratings | Eventual (async write) | Ratings can lag behind order completion |

### Idempotency Keys

**Order creation** uses client-generated idempotency keys to prevent duplicate orders on network retries:

```sql
-- idempotency_keys table
CREATE TABLE idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  response JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for cleanup
CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
```

**Implementation pattern:**
1. Client sends `X-Idempotency-Key` header with order requests
2. Server checks if key exists in `idempotency_keys` table
3. If exists, return cached response; otherwise, execute transaction
4. Store response with key on success
5. Clean up keys older than 24 hours via cron job

**Driver location updates** are naturally idempotent (last-write-wins via `GEOADD`). No special handling needed.

**Order status transitions** use optimistic locking:
```sql
UPDATE orders
SET status = 'picked_up', picked_up_at = NOW()
WHERE id = $1 AND status = 'preparing'
RETURNING *;
```
If affected rows = 0, the transition was already applied or invalid.

### Conflict Resolution

| Scenario | Resolution Strategy |
|----------|---------------------|
| Two drivers accept same order | First `UPDATE` wins (PostgreSQL row lock); second gets "already assigned" error |
| Driver goes offline with active order | Order stays assigned; admin can manually reassign after timeout (10 min) |
| Simultaneous location updates | Redis `GEOADD` is atomic; latest timestamp wins |
| Duplicate order submission | Idempotency key returns cached response |

### Replay Handling

For message replay in Pub/Sub (e.g., after WebSocket reconnect):
1. Client sends last received `message_id` on reconnect
2. Server replays missed messages from Redis stream (kept for 1 hour)
3. Clients deduplicate by `message_id` on their side

```redis
# Store recent messages for replay
XADD order:{id}:events MAXLEN 100 * type status_change data {...}

# On reconnect, read from last known ID
XREAD STREAMS order:{id}:events $last_id
```

## Data Lifecycle Policies

### Retention Policies

| Data Type | Hot Storage | Warm Storage | Archive | Deletion |
|-----------|-------------|--------------|---------|----------|
| Active orders | PostgreSQL | - | - | - |
| Completed orders | PostgreSQL (30 days) | PostgreSQL partitioned (1 year) | CSV export to MinIO (7 years) | After 7 years |
| Driver locations (Redis) | Current only | - | - | Overwritten continuously |
| Driver location history | PostgreSQL (7 days) | - | Aggregated daily to MinIO | After 30 days |
| Session tokens | Redis (24h TTL) | - | - | Auto-expire |
| Idempotency keys | PostgreSQL (24h) | - | - | Cron purge daily |
| Audit logs | PostgreSQL (90 days) | - | MinIO (2 years) | After 2 years |

### PostgreSQL Table Partitioning

Orders are partitioned by month for efficient archival:

```sql
-- Create partitioned orders table
CREATE TABLE orders (
  id SERIAL,
  created_at TIMESTAMP NOT NULL,
  -- ... other columns
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE orders_2025_01 PARTITION OF orders
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

-- Detach and archive old partitions
ALTER TABLE orders DETACH PARTITION orders_2024_01;
-- Export to CSV, upload to MinIO, then DROP
```

### Archival Procedure (Local Development)

For the local learning project, archival is simplified:

```bash
# Weekly archive script (run manually or via cron)
#!/bin/bash
ARCHIVE_DATE=$(date -d '30 days ago' +%Y-%m-%d)

# Export old orders to CSV
psql -c "COPY (SELECT * FROM orders WHERE created_at < '$ARCHIVE_DATE')
  TO '/tmp/orders_archive.csv' CSV HEADER"

# Upload to MinIO
mc cp /tmp/orders_archive.csv local/delivery-archive/orders/

# Delete archived records
psql -c "DELETE FROM orders WHERE created_at < '$ARCHIVE_DATE'"
```

### TTL Configuration

```yaml
# Redis TTL settings
session_tokens: 86400      # 24 hours
idempotency_cache: 86400   # 24 hours
driver_metadata: 3600      # 1 hour (refreshed on location update)
pubsub_messages: 3600      # 1 hour retention in streams
```

### Backfill Procedures

**Scenario: Redis geo-index lost after restart**

Redis driver locations are volatile. On Redis restart:
1. All online drivers are marked offline in PostgreSQL
2. Drivers must re-authenticate and call `/go-online`
3. First location update repopulates Redis geo-index

**Scenario: Rebuild search index from PostgreSQL**

```bash
# Restore driver locations from PostgreSQL to Redis
psql -c "SELECT id, current_lat, current_lng FROM drivers WHERE status = 'online'" \
  --csv | while IFS=, read id lat lng; do
    redis-cli GEOADD drivers:locations $lng $lat $id
  done
```

**Scenario: Replay orders for analytics rebuild**

Orders remain in PostgreSQL as source of truth. To rebuild analytics:
1. Query `orders` table with date range
2. Reprocess through analytics pipeline
3. No special replay infrastructure needed for local dev

## Deployment and Operations

### Local Development Rollout

Since this is a learning project running locally, "deployment" means restarting services:

```bash
# Full restart (safe for local dev)
docker-compose down && docker-compose up -d
cd backend && npm run dev

# Zero-downtime restart (multiple instances)
# Start new instance, wait for health check, stop old instance
npm run dev:server2 &
sleep 5
curl http://localhost:3002/health && kill %1
```

### Schema Migration Strategy

Migrations use sequential numbered SQL files:

```
backend/src/db/migrations/
  001_initial_schema.sql
  002_add_driver_location_history.sql
  003_add_idempotency_keys.sql
```

**Migration runner (`npm run db:migrate`):**

```typescript
// Tracks applied migrations in schema_migrations table
const applied = await db.query('SELECT version FROM schema_migrations');
const pending = migrations.filter(m => !applied.includes(m.version));

for (const migration of pending) {
  await db.query('BEGIN');
  try {
    await db.query(migration.sql);
    await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
```

**Migration best practices:**
- Migrations are forward-only (no automatic rollback)
- Each migration is idempotent where possible (`CREATE TABLE IF NOT EXISTS`)
- Destructive changes (column drops) require manual confirmation
- Test migrations on a copy of production data before applying

### Rollback Runbooks

#### Scenario 1: Bad Migration Applied

**Symptoms:** Application errors after migration, schema mismatch

**Runbook:**
```bash
# 1. Stop the application
pkill -f "npm run dev"

# 2. Identify the bad migration
psql -c "SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 5"

# 3. Write a compensating migration (e.g., 004_revert_003.sql)
# Example: ALTER TABLE orders DROP COLUMN IF EXISTS bad_column;

# 4. Apply the fix
npm run db:migrate

# 5. Restart application
npm run dev
```

#### Scenario 2: Redis Data Corruption

**Symptoms:** Driver matching fails, locations stale

**Runbook:**
```bash
# 1. Flush driver locations (safe - will repopulate)
redis-cli DEL drivers:locations

# 2. Mark all drivers offline in PostgreSQL
psql -c "UPDATE drivers SET status = 'offline'"

# 3. Notify drivers to re-authenticate (in production: push notification)
# For local dev: manually log drivers back in

# 4. Verify recovery
redis-cli ZCARD drivers:locations  # Should increase as drivers reconnect
```

#### Scenario 3: Application Won't Start

**Symptoms:** Service crashes on startup

**Runbook:**
```bash
# 1. Check logs for error
npm run dev 2>&1 | head -50

# 2. Verify dependencies are running
docker-compose ps
curl http://localhost:5432  # PostgreSQL (will fail but port check)
redis-cli ping              # Should return PONG

# 3. Reset to known good state
git stash                   # Save local changes
git checkout main           # Return to stable branch
npm run dev                 # Try again

# 4. If database is corrupt
docker-compose down -v      # WARNING: Deletes all data
docker-compose up -d
npm run db:migrate
npm run db:seed-admin
```

#### Scenario 4: Orders Stuck in Processing

**Symptoms:** Orders remain in `preparing` state indefinitely

**Runbook:**
```bash
# 1. Identify stuck orders
psql -c "SELECT id, status, created_at FROM orders
  WHERE status IN ('pending', 'preparing')
  AND created_at < NOW() - INTERVAL '1 hour'"

# 2. Option A: Cancel old orders
psql -c "UPDATE orders SET status = 'cancelled', cancelled_at = NOW()
  WHERE status IN ('pending', 'preparing')
  AND created_at < NOW() - INTERVAL '2 hours'"

# 3. Option B: Manually reassign to a driver
psql -c "UPDATE orders SET driver_id = 1, status = 'assigned'
  WHERE id = <stuck_order_id>"
```

### Health Check Endpoints

```typescript
// GET /health - Basic liveness check
{ status: 'ok' }

// GET /health/ready - Readiness with dependency checks
{
  status: 'ok',
  postgres: 'connected',
  redis: 'connected',
  uptime_seconds: 3600
}
```

### Monitoring Alerts (Local Development)

For local development, use simple log-based monitoring:

```bash
# Watch for errors in real-time
npm run dev 2>&1 | grep -E "(ERROR|FATAL|Exception)"

# Check order processing health
watch -n 10 'psql -c "SELECT status, COUNT(*) FROM orders GROUP BY status"'

# Monitor Redis memory
watch -n 30 'redis-cli INFO memory | grep used_memory_human'
```

## Future Optimizations

- [x] Add Prometheus + Grafana for monitoring (Prometheus metrics implemented)
- [ ] Implement surge pricing based on demand/supply
- [ ] Add multi-stop route optimization (TSP)
- [ ] Machine learning for demand prediction
- [ ] Implement push notifications
- [ ] Add payment integration (Stripe)
- [ ] Performance testing with k6 or Artillery

## Implementation Notes

This section documents the rationale behind key operational features implemented in the codebase.

### WHY Idempotency Prevents Duplicate Orders and Charges

**Problem:** Network failures during order placement create a critical risk. If a customer submits an order, the server processes it successfully, but the response is lost due to a network timeout, the client will retry. Without idempotency protection, this retry creates a duplicate order and potentially a double charge.

**Solution:** The idempotency service (`src/shared/idempotency.ts`) implements exactly-once semantics:

```typescript
// Client sends unique key with each order request
const result = await withIdempotency(
  req.headers['x-idempotency-key'],  // e.g., "ord-uuid-12345"
  userId,
  'create_order',
  async () => createOrder(userId, orderData)
);
```

**How it works:**
1. Client generates a unique UUID before submitting the order
2. Server checks `idempotency_keys` table for existing key
3. If key exists with `status=completed`, return cached response (no duplicate)
4. If key doesn't exist, create it with `status=pending`, execute order, update to `completed`
5. If key exists with `status=pending`, another request is in progress (race condition protection)
6. Keys expire after 24 hours to prevent unbounded table growth

**Benefits:**
- Zero duplicate orders on network retries
- Zero double charges (payment would be part of the idempotent operation)
- Safe for aggressive client retry policies
- Audit trail of all order attempts

**Implementation files:**
- `/backend/src/shared/idempotency.ts` - Core idempotency logic
- `/backend/src/routes/orders.ts` - Integration with order creation
- `/backend/src/db/migrations/001_add_idempotency_keys.sql` - Database schema

### WHY Delivery Retention Balances History vs Storage

**Problem:** A delivery service generates massive amounts of data: orders, driver location history, offer records, ratings. Keeping everything forever leads to:
- Unbounded database growth (100K orders/day = 36M orders/year)
- Slower queries as tables grow
- Higher infrastructure costs
- Compliance risks (GDPR right to erasure)

**Solution:** The retention service (`src/shared/retention.ts`) implements tiered data lifecycle:

| Data Type | Hot (Fast Access) | Warm (Queryable) | Archive (Cold) | Delete |
|-----------|-------------------|------------------|----------------|--------|
| Orders | 30 days | 1 year | 7 years (MinIO) | After 7 years |
| Driver locations | Current only | 7 days | 30 days aggregated | After 30 days |
| Sessions | 24 hours | - | - | Auto-expire |
| Idempotency keys | 24 hours | - | - | Daily cleanup |

**Rationale by data type:**

1. **Orders (30 days hot, 7 years archive)**
   - Hot: Recent orders for customer support, refunds, disputes
   - Archive: Legal compliance, financial auditing, fraud investigation
   - 7 years: Standard financial record retention period

2. **Driver location history (7 days hot, 30 days warm)**
   - Hot: Route optimization analysis, ETA accuracy tuning
   - Warm: Weekly aggregated analytics, driver performance review
   - Delete: Individual GPS points have no long-term value after aggregation

3. **Sessions (24 hours)**
   - Functional requirement only (authentication)
   - No business value in historical sessions
   - Auto-expire via Redis TTL

**Implementation files:**
- `/backend/src/shared/retention.ts` - Cleanup jobs and policy management
- `/backend/src/db/migrations/002_add_retention_policies.sql` - Configuration table

### WHY Driver Metrics Enable Route Optimization

**Problem:** Without visibility into driver behavior and delivery patterns, the system cannot:
- Identify underperforming drivers
- Optimize matching algorithm weights
- Predict demand surges
- Detect systematic issues (e.g., certain zones always have delayed deliveries)

**Solution:** Prometheus metrics (`src/shared/metrics.ts`) track key driver and delivery KPIs:

```typescript
// Driver assignment metrics
driverAssignmentsCounter.inc({ result: 'accepted' });  // or 'rejected', 'expired', 'no_driver'
driverMatchingDurationHistogram.observe(duration);     // Time to find a driver
offersPerAssignmentHistogram.observe(offerCount);      // Offers before acceptance

// Delivery performance
deliveryTimeHistogram.observe(deliverySeconds);        // Pickup to delivery time
deliveryDistanceHistogram.observe(distanceKm);         // Delivery distance distribution
```

**How metrics enable optimization:**

1. **Matching algorithm tuning:**
   - If `offers_per_assignment` is consistently high, drivers are rejecting orders
   - Analyze by zone to find areas with driver shortages
   - Adjust scoring weights based on what actually predicts acceptance

2. **Route optimization:**
   - `delivery_time` histogram reveals slow zones (traffic, building access issues)
   - `delivery_distance` distribution shows if matching prefers close drivers effectively
   - Correlation with `vehicle_type` reveals which vehicles are optimal for which zones

3. **Capacity planning:**
   - `online_drivers` gauge by time-of-day shows driver availability patterns
   - `driver_acceptance_rate` histogram identifies reliable vs. flaky drivers
   - `active_orders` by status shows system throughput bottlenecks

**Prometheus endpoint:** `GET /metrics` returns all metrics in Prometheus text format.

**Implementation files:**
- `/backend/src/shared/metrics.ts` - Metric definitions
- `/backend/src/services/orderService.ts` - Driver matching metrics
- `/backend/src/index.ts` - HTTP request metrics and `/metrics` endpoint

### WHY Circuit Breakers Protect Matching Service

**Problem:** The driver matching service depends on multiple external systems:
- Redis for geo queries (finding nearby drivers)
- PostgreSQL for driver details and offer records
- Network I/O for each driver offer/response cycle

If any dependency is slow or unavailable:
- Matching requests pile up, consuming memory
- Workers block waiting for timeouts
- System becomes unresponsive to all requests
- Cascading failure affects unrelated features

**Solution:** Circuit breaker pattern (`src/shared/circuitBreaker.ts`) wraps the matching service:

```typescript
const driverMatchingCircuitBreaker = createCircuitBreaker(
  'driver-matching',
  async (orderId: string) => startDriverMatching(orderId),
  {
    timeout: 180000,              // 3 minutes per matching attempt
    errorThresholdPercentage: 50, // Open after 50% failures
    volumeThreshold: 3,           // Minimum 3 requests before tripping
    resetTimeout: 30000,          // Try again after 30 seconds
  }
);
```

**Circuit breaker states:**

1. **Closed (Normal):** All requests pass through. Failures are counted.
2. **Open (Tripped):** All requests fail immediately with fallback. No matching attempted.
3. **Half-Open (Testing):** One request allowed through to test recovery.

**Fallback behavior:**
```typescript
driverMatchingCircuitBreaker.fallback(async (orderId: string) => {
  // Order stays in 'pending' status
  // Logged for manual intervention or retry queue
  return false;
});
```

**Why this matters:**

1. **Fail fast:** Instead of waiting 3 minutes per order during an outage, orders fail in <1ms
2. **System stability:** Other endpoints (order history, login) remain responsive
3. **Auto-recovery:** Half-open state automatically tests when the matching service recovers
4. **Observability:** Circuit state exposed in `/health` and Prometheus metrics

**Circuit breaker metrics:**
```typescript
circuitBreakerState.set({ name: 'driver-matching' }, 1);  // 0=closed, 0.5=half-open, 1=open
circuitBreakerEvents.inc({ name: 'driver-matching', event: 'open' });
```

**Implementation files:**
- `/backend/src/shared/circuitBreaker.ts` - Generic circuit breaker factory
- `/backend/src/services/orderService.ts` - Driver matching circuit breaker
- `/backend/src/index.ts` - Health check includes circuit breaker status
