# Design Airbnb - Architecture

## System Overview

Airbnb is a two-sided marketplace connecting hosts with guests. Core challenges involve availability management, geographic search, and trust systems.

**Learning Goals:**
- Design availability calendar systems
- Build geographic search with PostGIS
- Handle two-sided marketplace dynamics
- Implement trust and review systems

---

## Requirements

### Functional Requirements

1. **List**: Hosts create property listings
2. **Search**: Guests find properties by location/dates
3. **Book**: Reserve properties with payment
4. **Review**: Two-way rating system
5. **Message**: Host-guest communication

### Non-Functional Requirements

- **Availability**: 99.9% for search
- **Consistency**: Strong for bookings (no double-booking)
- **Latency**: < 200ms for search results
- **Scale**: 10M listings, 1M bookings/day

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Client Layer                                 │
│        React + Search + Booking + Messaging                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Listing Service│    │Booking Service│    │ Search Service│
│               │    │               │    │               │
│ - CRUD        │    │ - Reserve     │    │ - Geo search  │
│ - Calendar    │    │ - Payment     │    │ - Availability│
│ - Pricing     │    │ - Cancellation│    │ - Ranking     │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │           Elasticsearch                       │
│   + PostGIS     │           - Search index                      │
│   - Listings    │           - Geo queries                       │
│   - Bookings    │           - Facets                            │
│   - Calendars   │                                               │
└─────────────────┴───────────────────────────────────────────────┘
```

---

## Core Components

### 1. Availability Calendar

**Schema Options:**

**Option 1: Day-by-Day Rows**
```sql
CREATE TABLE calendar (
  listing_id INTEGER REFERENCES listings(id),
  date DATE,
  available BOOLEAN DEFAULT TRUE,
  price DECIMAL(10, 2),
  PRIMARY KEY (listing_id, date)
);
```
- Pros: Simple queries, easy updates
- Cons: Many rows (365 × listings)

**Option 2: Date Ranges (Chosen)**
```sql
CREATE TABLE availability_blocks (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER REFERENCES listings(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20), -- 'available', 'blocked', 'booked'
  price_per_night DECIMAL(10, 2),
  booking_id INTEGER REFERENCES bookings(id)
);

CREATE INDEX idx_availability_listing_dates
ON availability_blocks(listing_id, start_date, end_date);
```
- Pros: Fewer rows, efficient range queries
- Cons: Complex overlap handling

**Checking Availability:**
```sql
-- Check if dates are available
SELECT COUNT(*) = 0 as is_available
FROM availability_blocks
WHERE listing_id = $1
  AND status != 'available'
  AND (start_date, end_date) OVERLAPS ($2, $3);
```

### 2. Geographic Search

**PostGIS for Location:**
```sql
CREATE TABLE listings (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200),
  description TEXT,
  location GEOGRAPHY(POINT, 4326),
  price_per_night DECIMAL(10, 2),
  ...
);

CREATE INDEX idx_listings_location ON listings USING GIST(location);

-- Search within radius
SELECT *, ST_Distance(location, ST_MakePoint($lon, $lat)::geography) as distance
FROM listings
WHERE ST_DWithin(location, ST_MakePoint($lon, $lat)::geography, $radius_meters)
ORDER BY distance
LIMIT 20;
```

**Combined Search with Availability:**
```javascript
async function searchListings({ location, checkIn, checkOut, guests, priceMax }) {
  // Step 1: Geographic filter
  const nearbyIds = await db.raw(`
    SELECT id FROM listings
    WHERE ST_DWithin(location, ST_MakePoint(?, ?)::geography, 25000)
      AND max_guests >= ?
      AND price_per_night <= ?
  `, [location.lon, location.lat, guests, priceMax])

  // Step 2: Availability filter
  const availableIds = await db.raw(`
    SELECT listing_id FROM (
      SELECT listing_id
      FROM availability_blocks
      WHERE listing_id = ANY(?)
        AND status = 'available'
        AND start_date <= ? AND end_date >= ?
    ) available
    WHERE listing_id NOT IN (
      SELECT listing_id FROM availability_blocks
      WHERE status = 'booked'
        AND (start_date, end_date) OVERLAPS (?, ?)
    )
  `, [nearbyIds, checkIn, checkOut, checkIn, checkOut])

  // Step 3: Fetch and rank
  return rankListings(availableIds)
}
```

### 3. Booking Flow

**Preventing Double-Booking:**
```javascript
async function createBooking(listingId, guestId, checkIn, checkOut) {
  return await db.transaction(async (trx) => {
    // Lock the listing row
    await trx.raw('SELECT * FROM listings WHERE id = ? FOR UPDATE', [listingId])

    // Check availability again (within transaction)
    const conflicts = await trx('availability_blocks')
      .where('listing_id', listingId)
      .where('status', 'booked')
      .whereRaw('(start_date, end_date) OVERLAPS (?, ?)', [checkIn, checkOut])

    if (conflicts.length > 0) {
      throw new Error('Dates no longer available')
    }

    // Create booking
    const [booking] = await trx('bookings')
      .insert({ listing_id: listingId, guest_id: guestId, check_in: checkIn, check_out: checkOut })
      .returning('*')

    // Block the dates
    await trx('availability_blocks').insert({
      listing_id: listingId,
      start_date: checkIn,
      end_date: checkOut,
      status: 'booked',
      booking_id: booking.id
    })

    return booking
  })
}
```

### 4. Two-Sided Reviews

**Review Visibility Rules:**
```javascript
// Reviews hidden until both parties submit
async function getReviews(bookingId) {
  const reviews = await db('reviews').where({ booking_id: bookingId })

  const hostReview = reviews.find(r => r.author_type === 'host')
  const guestReview = reviews.find(r => r.author_type === 'guest')

  // Only show if both submitted
  if (hostReview && guestReview) {
    return { hostReview, guestReview }
  }

  // Otherwise, show nothing or placeholder
  return { pending: true }
}
```

---

## Database Schema

The complete schema is located at: `backend/db/init.sql`

### Entity-Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                        AIRBNB DATABASE ER DIAGRAM                                               │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

                                    ┌─────────────────┐
                                    │     users       │
                                    ├─────────────────┤
                                    │ PK id           │
                                    │    email        │
                                    │    password_hash│
                                    │    name         │
                                    │    is_host      │
                                    │    is_verified  │
                                    │    role         │
                                    │    response_rate│
                                    └────────┬────────┘
                                             │
             ┌───────────────────────────────┼───────────────────────────────┐
             │                               │                               │
             │ host_id                       │ guest_id                      │ user_id
             ▼                               ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐             ┌─────────────────┐
    │    listings     │             │   bookings      │             │   sessions      │
    ├─────────────────┤             ├─────────────────┤             ├─────────────────┤
    │ PK id           │◄────────────│ FK listing_id   │             │ PK id           │
    │ FK host_id      │             │ FK guest_id     │             │ FK user_id      │
    │    title        │             │    check_in     │             │    data (JSONB) │
    │    location     │             │    check_out    │             │    expires_at   │
    │    property_type│             │    total_price  │             └─────────────────┘
    │    room_type    │             │    status       │
    │    price/night  │             │    nights       │
    │    rating       │             └────────┬────────┘
    │    review_count │                      │
    └────────┬────────┘                      │
             │                               │
    ┌────────┼────────┐                      │
    │        │        │                      │
    ▼        ▼        ▼                      ▼
┌──────────┐ ┌────────────────────┐    ┌─────────────────┐
│listing_  │ │availability_blocks │    │    reviews      │
│photos    │ ├────────────────────┤    ├─────────────────┤
├──────────┤ │ PK id              │    │ PK id           │
│ PK id    │ │ FK listing_id      │    │ FK booking_id   │
│ FK list_ │ │ FK booking_id ─────┼────│ FK author_id    │
│   ing_id │ │    start_date      │    │    author_type  │
│    url   │ │    end_date        │    │    rating       │
│    order │ │    status          │    │    is_public    │
└──────────┘ │    price/night     │    └─────────────────┘
             └────────────────────┘

                    ┌─────────────────┐
                    │  conversations  │
                    ├─────────────────┤
                    │ PK id           │
                    │ FK listing_id   │────► listings
                    │ FK booking_id   │────► bookings
                    │ FK host_id      │────► users (host)
                    │ FK guest_id     │────► users (guest)
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │    messages     │
                    ├─────────────────┤
                    │ PK id           │
                    │ FK conversation_│
                    │    id           │
                    │ FK sender_id    │────► users
                    │    content      │
                    │    is_read      │
                    └─────────────────┘

                    ┌─────────────────┐
                    │   audit_logs    │
                    ├─────────────────┤
                    │ PK id           │
                    │ FK user_id      │────► users (optional)
                    │    event_type   │
                    │    resource_type│
                    │    resource_id  │
                    │    action       │
                    │    before_state │
                    │    after_state  │
                    └─────────────────┘
```

### Complete Table Specifications

#### 1. users

**Purpose:** Central user table for both guests and hosts.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | auto | Primary key |
| email | VARCHAR(255) | NO | - | Unique email address |
| password_hash | VARCHAR(255) | NO | - | Bcrypt hashed password |
| name | VARCHAR(100) | NO | - | Display name |
| avatar_url | TEXT | YES | NULL | Profile photo URL |
| bio | TEXT | YES | NULL | User biography |
| phone | VARCHAR(20) | YES | NULL | Phone number |
| is_host | BOOLEAN | NO | FALSE | TRUE when user creates a listing |
| is_verified | BOOLEAN | NO | FALSE | Email/phone verification status |
| role | VARCHAR(20) | NO | 'user' | CHECK: 'user', 'admin' |
| response_rate | DECIMAL(3,2) | NO | 1.00 | Host response rate (0.00-1.00) |
| created_at | TIMESTAMP | NO | NOW() | Account creation time |
| updated_at | TIMESTAMP | NO | NOW() | Last modification (auto-updated) |

**Indexes:**
- PRIMARY KEY on `id`
- UNIQUE on `email`

**Trigger:** `update_users_updated_at` - Auto-updates `updated_at` on row modification

---

#### 2. listings

**Purpose:** Core property listing with geographic location.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | auto | Primary key |
| host_id | INTEGER | YES | - | FK to users(id) |
| title | VARCHAR(200) | NO | - | Listing title |
| description | TEXT | YES | NULL | Full description |
| location | GEOGRAPHY(POINT,4326) | YES | NULL | PostGIS point (lon, lat) |
| address_line1 | VARCHAR(255) | YES | NULL | Street address |
| address_line2 | VARCHAR(255) | YES | NULL | Apt/Suite number |
| city | VARCHAR(100) | YES | NULL | City name |
| state | VARCHAR(100) | YES | NULL | State/Province |
| country | VARCHAR(100) | YES | NULL | Country |
| postal_code | VARCHAR(20) | YES | NULL | ZIP/Postal code |
| property_type | VARCHAR(50) | YES | NULL | CHECK: apartment, house, room, studio, villa, cabin, cottage, loft |
| room_type | VARCHAR(50) | YES | NULL | CHECK: entire_place, private_room, shared_room |
| max_guests | INTEGER | NO | 1 | Maximum guest count |
| bedrooms | INTEGER | YES | 0 | Number of bedrooms |
| beds | INTEGER | YES | 0 | Number of beds |
| bathrooms | DECIMAL(2,1) | YES | 1 | Bathroom count (supports 1.5) |
| amenities | TEXT[] | YES | '{}' | Array of amenity names |
| house_rules | TEXT | YES | NULL | House rules text |
| price_per_night | DECIMAL(10,2) | NO | - | Base nightly price |
| cleaning_fee | DECIMAL(10,2) | YES | 0 | One-time cleaning fee |
| service_fee_percent | DECIMAL(4,2) | YES | 10.00 | Platform fee percentage |
| rating | DECIMAL(2,1) | YES | NULL | Average rating (trigger-updated) |
| review_count | INTEGER | YES | 0 | Public review count (trigger-updated) |
| instant_book | BOOLEAN | NO | FALSE | TRUE = no host approval needed |
| minimum_nights | INTEGER | YES | 1 | Minimum stay requirement |
| maximum_nights | INTEGER | YES | 365 | Maximum stay limit |
| cancellation_policy | VARCHAR(50) | YES | 'flexible' | CHECK: flexible, moderate, strict |
| is_active | BOOLEAN | NO | TRUE | FALSE = hidden from search |
| created_at | TIMESTAMP | NO | NOW() | Creation timestamp |
| updated_at | TIMESTAMP | NO | NOW() | Last modification (auto-updated) |

**Indexes:**
- PRIMARY KEY on `id`
- GIST on `location` (spatial index for geo queries)
- BTREE on `host_id` (find host's listings)
- BTREE on `price_per_night` (price filtering)
- BTREE on `is_active` (active listings filter)

**Trigger:** `update_listings_updated_at` - Auto-updates `updated_at` on modification

---

#### 3. listing_photos

**Purpose:** Multiple photos per listing with ordering.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | auto | Primary key |
| listing_id | INTEGER | YES | - | FK to listings(id) |
| url | TEXT | NO | - | Image URL (MinIO/S3) |
| caption | VARCHAR(255) | YES | NULL | Photo caption |
| display_order | INTEGER | YES | 0 | Display sequence (0 = primary) |
| created_at | TIMESTAMP | NO | NOW() | Upload timestamp |

**Indexes:**
- PRIMARY KEY on `id`
- BTREE on `listing_id`

---

#### 4. availability_blocks

**Purpose:** Date-range based availability tracking (more efficient than day-by-day).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | auto | Primary key |
| listing_id | INTEGER | YES | - | FK to listings(id) |
| start_date | DATE | NO | - | Block start (inclusive) |
| end_date | DATE | NO | - | Block end (exclusive) |
| status | VARCHAR(20) | NO | - | CHECK: available, blocked, booked |
| price_per_night | DECIMAL(10,2) | YES | NULL | Custom pricing (NULL = use listing default) |
| booking_id | INTEGER | YES | NULL | FK to bookings(id) when status='booked' |
| created_at | TIMESTAMP | NO | NOW() | Creation timestamp |

**Constraints:**
- `valid_dates`: CHECK (end_date > start_date)

**Indexes:**
- PRIMARY KEY on `id`
- BTREE on `(listing_id, start_date, end_date)` (date range queries)
- BTREE on `status`

---

#### 5. bookings

**Purpose:** Reservations linking guests to listings for specific dates.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | auto | Primary key |
| listing_id | INTEGER | YES | - | FK to listings(id) |
| guest_id | INTEGER | YES | - | FK to users(id) |
| check_in | DATE | NO | - | Check-in date |
| check_out | DATE | NO | - | Check-out date |
| guests | INTEGER | NO | 1 | Number of guests |
| nights | INTEGER | NO | - | Stay duration (denormalized) |
| price_per_night | DECIMAL(10,2) | NO | - | Captured at booking time |
| cleaning_fee | DECIMAL(10,2) | YES | 0 | Captured at booking time |
| service_fee | DECIMAL(10,2) | YES | 0 | Calculated service fee |
| total_price | DECIMAL(10,2) | NO | - | Total amount |
| status | VARCHAR(20) | YES | 'pending' | CHECK: pending, confirmed, cancelled, completed, declined |
| guest_message | TEXT | YES | NULL | Initial message from guest |
| host_response | TEXT | YES | NULL | Host reply |
| cancelled_by | VARCHAR(10) | YES | NULL | CHECK: guest, host, NULL |
| cancelled_at | TIMESTAMP | YES | NULL | Cancellation timestamp |
| created_at | TIMESTAMP | NO | NOW() | Booking creation |
| updated_at | TIMESTAMP | NO | NOW() | Last modification |

**Constraints:**
- `valid_booking_dates`: CHECK (check_out > check_in)

**Indexes:**
- PRIMARY KEY on `id`
- BTREE on `listing_id`
- BTREE on `guest_id`
- BTREE on `(check_in, check_out)`
- BTREE on `status`

**Trigger:** `update_bookings_updated_at` - Auto-updates `updated_at` on modification

---

#### 6. reviews

**Purpose:** Two-sided reviews (guest reviews listing, host reviews guest).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | auto | Primary key |
| booking_id | INTEGER | YES | - | FK to bookings(id) |
| author_id | INTEGER | YES | - | FK to users(id) |
| author_type | VARCHAR(10) | NO | - | CHECK: 'host', 'guest' |
| rating | INTEGER | NO | - | Overall rating 1-5 |
| cleanliness_rating | INTEGER | YES | NULL | CHECK 1-5 (guest reviews only) |
| communication_rating | INTEGER | YES | NULL | CHECK 1-5 (guest reviews only) |
| location_rating | INTEGER | YES | NULL | CHECK 1-5 (guest reviews only) |
| value_rating | INTEGER | YES | NULL | CHECK 1-5 (guest reviews only) |
| content | TEXT | YES | NULL | Review text |
| is_public | BOOLEAN | NO | FALSE | TRUE when both parties reviewed |
| created_at | TIMESTAMP | NO | NOW() | Review submission time |

**Constraints:**
- UNIQUE on `(booking_id, author_type)` - One review per party per booking

**Indexes:**
- PRIMARY KEY on `id`
- BTREE on `booking_id`
- BTREE on `author_id`

**Triggers:**
- `check_publish_reviews_trigger` - Sets `is_public = TRUE` when both parties review
- `update_listing_rating_trigger` - Updates listing.rating and listing.review_count when guest review becomes public

---

#### 7. conversations

**Purpose:** Message threads between hosts and guests.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | auto | Primary key |
| listing_id | INTEGER | YES | NULL | FK to listings(id) |
| booking_id | INTEGER | YES | NULL | FK to bookings(id) |
| host_id | INTEGER | YES | NULL | FK to users(id) |
| guest_id | INTEGER | YES | NULL | FK to users(id) |
| created_at | TIMESTAMP | NO | NOW() | Thread creation |
| updated_at | TIMESTAMP | NO | NOW() | Last message time |

**Indexes:**
- PRIMARY KEY on `id`
- BTREE on `host_id`
- BTREE on `guest_id`

**Trigger:** `update_conversations_updated_at` - Auto-updates `updated_at` on modification

---

#### 8. messages

**Purpose:** Individual messages within conversation threads.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | auto | Primary key |
| conversation_id | INTEGER | YES | - | FK to conversations(id) |
| sender_id | INTEGER | YES | - | FK to users(id) |
| content | TEXT | NO | - | Message content |
| is_read | BOOLEAN | NO | FALSE | Read status |
| created_at | TIMESTAMP | NO | NOW() | Send timestamp |

**Indexes:**
- PRIMARY KEY on `id`
- BTREE on `conversation_id`
- BTREE on `sender_id`

---

#### 9. sessions

**Purpose:** Server-side session storage for authentication.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | VARCHAR(255) | NO | - | Primary key (session token) |
| user_id | INTEGER | YES | - | FK to users(id) |
| data | JSONB | YES | NULL | Session data |
| expires_at | TIMESTAMP | NO | - | Session expiration |
| created_at | TIMESTAMP | NO | NOW() | Session creation |

**Indexes:**
- PRIMARY KEY on `id`
- BTREE on `user_id`
- BTREE on `expires_at` (cleanup queries)

---

#### 10. audit_logs

**Purpose:** Comprehensive audit trail for all sensitive operations.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| id | SERIAL | NO | auto | Primary key |
| event_type | VARCHAR(100) | NO | - | e.g., 'booking.created' |
| user_id | INTEGER | YES | NULL | FK to users(id) |
| resource_type | VARCHAR(50) | NO | - | e.g., 'booking', 'listing' |
| resource_id | INTEGER | YES | NULL | ID of affected resource |
| action | VARCHAR(50) | NO | - | e.g., 'create', 'update', 'cancel' |
| outcome | VARCHAR(20) | NO | 'success' | CHECK: success, failure, denied |
| ip_address | VARCHAR(45) | YES | NULL | IPv4 or IPv6 |
| user_agent | TEXT | YES | NULL | Browser/client info |
| session_id | VARCHAR(255) | YES | NULL | Session reference |
| request_id | VARCHAR(255) | YES | NULL | Distributed trace ID |
| metadata | JSONB | YES | '{}' | Additional context |
| before_state | JSONB | YES | NULL | State before change |
| after_state | JSONB | YES | NULL | State after change |
| created_at | TIMESTAMP | NO | NOW() | Event timestamp |

**Indexes:**
- PRIMARY KEY on `id`
- BTREE on `event_type`
- BTREE on `user_id`
- BTREE on `(resource_type, resource_id)`
- BTREE on `created_at` (time-range queries)
- BTREE on `request_id` (trace correlation)

---

### Foreign Key Relationships and Cascade Behaviors

| Parent Table | Child Table | FK Column | ON DELETE | Rationale |
|--------------|-------------|-----------|-----------|-----------|
| users | listings | host_id | CASCADE | Delete host's listings when account deleted |
| users | bookings | guest_id | SET NULL | Preserve booking history for accounting |
| users | reviews | author_id | SET NULL | Keep reviews visible even if author deleted |
| users | conversations | host_id, guest_id | SET NULL | Preserve conversation history |
| users | messages | sender_id | SET NULL | Keep message history |
| users | sessions | user_id | CASCADE | Clean up sessions when user deleted |
| users | audit_logs | user_id | SET NULL | Preserve audit trail |
| listings | bookings | listing_id | SET NULL | Preserve booking history if listing deleted |
| listings | listing_photos | listing_id | CASCADE | Delete photos when listing deleted |
| listings | availability_blocks | listing_id | CASCADE | Clean up availability data |
| listings | conversations | listing_id | SET NULL | Preserve message history |
| bookings | reviews | booking_id | CASCADE | Reviews meaningless without booking |
| bookings | availability_blocks | booking_id | SET NULL | Keep availability structure |
| bookings | conversations | booking_id | SET NULL | Preserve message history |
| conversations | messages | conversation_id | CASCADE | Delete messages with conversation |

**Cascade Behavior Rationale:**

1. **CASCADE** - Used when child data is meaningless without parent:
   - Listing photos without listing
   - Availability blocks without listing
   - Sessions without user
   - Messages without conversation

2. **SET NULL** - Used to preserve historical records:
   - Bookings when listing/guest deleted (financial records)
   - Reviews when author deleted (trust data)
   - Audit logs (compliance requirement)
   - Conversations/messages (communication history)

---

### Data Flow for Key Operations

#### 1. Creating a Booking

```
┌─────────────┐     ┌─────────────┐     ┌────────────────────┐     ┌─────────────┐
│   Guest     │────►│  Bookings   │────►│ Availability_blocks│────►│  Listings   │
│   (users)   │     │  (INSERT)   │     │     (INSERT)       │     │ (SELECT     │
│             │     │             │     │  status='booked'   │     │  FOR UPDATE)│
└─────────────┘     └─────────────┘     └────────────────────┘     └─────────────┘
       │                   │                                              │
       │                   │                                              │
       ▼                   ▼                                              │
┌─────────────┐     ┌─────────────┐                                       │
│ Audit_logs  │◄────│Conversations│◄──────────────────────────────────────┘
│  (INSERT)   │     │  (INSERT)   │
└─────────────┘     └─────────────┘

Transaction Flow:
1. BEGIN TRANSACTION
2. SELECT listing FOR UPDATE (row lock prevents double-booking)
3. Check availability_blocks for conflicts using OVERLAPS
4. INSERT booking record
5. INSERT availability_block with status='booked'
6. CREATE conversation between host and guest
7. INSERT audit_log entry
8. COMMIT TRANSACTION
```

#### 2. Submitting Reviews (Two-Sided)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Guest       │────►│  Reviews    │────►│  Trigger:   │────►│  Reviews    │
│ submits     │     │ (INSERT     │     │  check_and_ │     │ is_public   │
│ review      │     │ is_public   │     │  publish_   │     │ = TRUE      │
│             │     │ = FALSE)    │     │  reviews    │     │ (for both)  │
└─────────────┘     └─────────────┘     └──────┬──────┘     └──────┬──────┘
                                               │                   │
                                               │ Both parties     │
                                               │ reviewed?        │
                                               ▼                   ▼
                                        ┌─────────────┐     ┌─────────────┐
                                        │  Trigger:   │────►│  Listings   │
                                        │  update_    │     │  rating,    │
                                        │  listing_   │     │ review_count│
                                        │  rating     │     │  updated    │
                                        └─────────────┘     └─────────────┘

Flow:
1. Guest or Host submits review → is_public = FALSE
2. Trigger checks if both parties have reviewed
3. If both reviewed → SET is_public = TRUE for both
4. If guest review now public → update listing.rating and listing.review_count
```

#### 3. Geographic Search with Availability

```
┌─────────────┐     ┌─────────────┐     ┌────────────────────┐     ┌─────────────┐
│   Search    │────►│  Listings   │────►│ Availability_blocks│────►│  Results    │
│   Request   │     │ (PostGIS    │     │  (check OVERLAPS)  │     │  (ranked)   │
│  lat/lon,   │     │ ST_DWithin) │     │                    │     │             │
│  dates      │     │             │     │                    │     │             │
└─────────────┘     └─────────────┘     └────────────────────┘     └─────────────┘

Query Flow:
1. Filter by geography: ST_DWithin(location, point, radius)
2. Filter by active: is_active = TRUE
3. Filter by capacity: max_guests >= requested_guests
4. Filter by price: price_per_night <= max_price
5. Check availability: No conflicting availability_blocks with status != 'available'
6. Rank by: distance, rating, price, instant_book
```

#### 4. Message Flow

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│   Sender    │────►│  Conversations  │────►│  Messages   │
│   (users)   │     │  (find/create)  │     │  (INSERT)   │
└─────────────┘     └─────────────────┘     └─────────────┘
       │                    │                      │
       │                    ▼                      ▼
       │            ┌─────────────────┐     ┌─────────────┐
       └───────────►│   Recipient     │◄────│ Notification│
                    │   (users)       │     │  (async)    │
                    └─────────────────┘     └─────────────┘

Flow:
1. Find or create conversation for (host, guest, listing)
2. Insert message with sender_id
3. Update conversation.updated_at
4. Publish notification event to message queue
5. Notification worker sends push/email to recipient
```

---

### Why Tables Are Structured This Way

#### Single Users Table for Both Roles
- Most users are both guests AND hosts
- Simplifies authentication and profile management
- `is_host` flag tracks role capability
- Avoids complex inheritance patterns

#### Date Ranges vs Day-by-Day Availability
- 10M listings x 365 days = 3.65 billion rows (day-by-day)
- Date ranges: ~200M rows (18x reduction)
- PostgreSQL OVERLAPS operator handles range queries efficiently
- Trade-off: Requires split/merge logic for partial updates

#### Denormalized Rating/Review Count
- Listing rating is read on every search result
- Calculating average on-the-fly would require JOIN on every search
- Trigger-based updates maintain consistency
- Trade-off: Slightly slower writes for much faster reads

#### Separate Photos Table
- Supports multiple images per listing
- Allows ordering with `display_order`
- Enables lazy loading of images
- CASCADE delete keeps data consistent

#### PostGIS Geography Type
- Native spatial indexing (GIST)
- Efficient radius queries (ST_DWithin)
- Uses WGS84 (SRID 4326) - standard lat/long
- Keeps all data in single database (no Elasticsearch sync)

#### Two-Sided Review Visibility
- Reviews hidden until both submit prevents retaliation
- Encourages honest feedback
- Trigger automates the publication logic
- Industry-standard approach (Airbnb, Uber, Lyft)

#### Audit Logs with Before/After State
- Full change history for dispute resolution
- Captures who, what, when, from where
- request_id links to distributed traces
- JSONB for flexible metadata

---

## Key Design Decisions

### 1. Date Ranges vs Day-by-Day

**Decision**: Store availability as date ranges

**Rationale**:
- Fewer rows in database
- Efficient overlap queries
- Easier to bulk update (block entire month)

### 2. PostGIS for Geographic Queries

**Decision**: Use PostgreSQL with PostGIS extension

**Rationale**:
- Native spatial indexing
- Efficient radius queries
- Keep data in single database

### 3. Optimistic Locking for Bookings

**Decision**: Use database transaction with row-level lock

**Rationale**:
- Prevents double-booking
- Simple implementation
- Acceptable contention at typical scale

---

## Caching and Edge Strategy

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CDN (CloudFront/nginx)                  │
│     Static assets, listing images, search result pages         │
│     TTL: 1 hour for images, 5 min for search pages             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Valkey/Redis Cluster                      │
│     Session cache, listing details, availability snapshots     │
│     TTL: 15 min listing, 1 min availability, 24h sessions      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   PostgreSQL + PostGIS                          │
│                 Source of truth for all data                    │
└─────────────────────────────────────────────────────────────────┘
```

### Cache Strategy by Data Type

| Data Type | Strategy | TTL | Invalidation |
|-----------|----------|-----|--------------|
| Listing details | Cache-aside | 15 min | On listing update |
| Listing images | CDN with origin pull | 1 hour | Version in URL |
| Search results | Cache-aside | 5 min | Time-based expiry |
| Availability | Cache-aside | 1 min | On booking/update |
| User sessions | Write-through | 24 hours | On logout/expiry |
| Review aggregates | Cache-aside | 30 min | On new review |

### Cache-Aside Pattern (Read Path)

```javascript
async function getListingDetails(listingId) {
  const cacheKey = `listing:${listingId}`

  // 1. Try cache first
  const cached = await redis.get(cacheKey)
  if (cached) {
    return JSON.parse(cached)
  }

  // 2. Cache miss - fetch from database
  const listing = await db('listings')
    .where('id', listingId)
    .first()

  // 3. Populate cache with TTL
  await redis.setex(cacheKey, 900, JSON.stringify(listing)) // 15 min

  return listing
}
```

### Write-Through Pattern (Session Management)

```javascript
async function createSession(userId, sessionData) {
  const sessionId = generateSecureId()
  const session = { userId, ...sessionData, createdAt: Date.now() }

  // Write to both cache and database atomically
  await Promise.all([
    redis.setex(`session:${sessionId}`, 86400, JSON.stringify(session)),
    db('sessions').insert({ id: sessionId, user_id: userId, data: session })
  ])

  return sessionId
}
```

### Cache Invalidation Rules

```javascript
// Invalidate on listing update
async function updateListing(listingId, updates) {
  await db('listings').where('id', listingId).update(updates)

  // Invalidate listing cache
  await redis.del(`listing:${listingId}`)

  // Invalidate search cache for affected area (by geo hash)
  const listing = await db('listings').where('id', listingId).first()
  const geoHash = computeGeoHash(listing.location, 4) // 4-char precision
  await redis.del(`search:${geoHash}:*`)
}

// Invalidate availability on booking
async function onBookingCreated(booking) {
  await redis.del(`availability:${booking.listing_id}`)

  // Publish event for downstream caches
  await redis.publish('booking:created', JSON.stringify(booking))
}
```

### Local Development Setup

```yaml
# docker-compose.yml addition for caching
services:
  valkey:
    image: valkey/valkey:8
    ports:
      - "6379:6379"
    command: valkey-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - valkey_data:/data
```

```bash
# Environment variables
REDIS_URL=redis://localhost:6379
CACHE_TTL_LISTING=900
CACHE_TTL_AVAILABILITY=60
CACHE_TTL_SEARCH=300
```

---

## Async Processing and Message Queue

### Queue Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       API Services                              │
│            Listing / Booking / Search / Review                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                     RabbitMQ Exchange                           │
│                    (Topic Exchange)                             │
├─────────────────┬─────────────────┬─────────────────────────────┤
│ booking.created │ listing.updated │ search.reindex              │
│ booking.cancel  │ review.submitted│ notification.send           │
└─────────────────┴─────────────────┴─────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Notification  │    │ Search Index  │    │  Analytics    │
│   Worker      │    │   Worker      │    │   Worker      │
│               │    │               │    │               │
│ - Email       │    │ - ES update   │    │ - Metrics     │
│ - Push        │    │ - Cache warm  │    │ - Reports     │
│ - SMS         │    │               │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
```

### Queue Configuration

| Queue | Purpose | Delivery | DLQ Retention |
|-------|---------|----------|---------------|
| `booking.events` | Booking lifecycle | At-least-once | 7 days |
| `notification.send` | Email/push/SMS | At-least-once | 3 days |
| `search.reindex` | ES/cache updates | At-most-once | 1 day |
| `analytics.events` | Metrics/reporting | At-most-once | 1 day |

### Publishing Events

```javascript
const amqp = require('amqplib')

let channel

async function initQueue() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL)
  channel = await connection.createChannel()

  // Declare exchanges
  await channel.assertExchange('airbnb.events', 'topic', { durable: true })

  // Declare queues with dead-letter exchange
  await channel.assertQueue('booking.events', {
    durable: true,
    deadLetterExchange: 'airbnb.dlx',
    messageTtl: 86400000 // 24 hours
  })

  await channel.bindQueue('booking.events', 'airbnb.events', 'booking.*')
}

async function publishBookingEvent(eventType, booking) {
  const message = {
    eventId: generateUUID(),
    eventType,
    timestamp: new Date().toISOString(),
    data: booking
  }

  channel.publish(
    'airbnb.events',
    `booking.${eventType}`,
    Buffer.from(JSON.stringify(message)),
    {
      persistent: true,
      messageId: message.eventId,
      contentType: 'application/json'
    }
  )
}
```

### Consumer with Idempotency

```javascript
async function startNotificationWorker() {
  await channel.prefetch(10) // Process 10 messages concurrently

  channel.consume('notification.send', async (msg) => {
    const event = JSON.parse(msg.content.toString())

    try {
      // Idempotency check
      const processed = await redis.get(`processed:${event.eventId}`)
      if (processed) {
        channel.ack(msg)
        return
      }

      // Process notification
      await sendNotification(event.data)

      // Mark as processed (TTL 7 days)
      await redis.setex(`processed:${event.eventId}`, 604800, '1')

      channel.ack(msg)
    } catch (error) {
      console.error('Notification failed:', error)

      // Retry up to 3 times, then dead-letter
      const retries = (msg.properties.headers?.['x-retry-count'] || 0) + 1
      if (retries < 3) {
        channel.nack(msg, false, false) // Requeue with delay
        await publishWithDelay(msg, retries)
      } else {
        channel.nack(msg, false, false) // Send to DLQ
      }
    }
  })
}
```

### Backpressure Handling

```javascript
// Producer-side rate limiting
const Bottleneck = require('bottleneck')

const limiter = new Bottleneck({
  maxConcurrent: 100,
  minTime: 10 // 100 messages per second max
})

async function publishWithBackpressure(exchange, routingKey, message) {
  return limiter.schedule(() =>
    channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(message)))
  )
}

// Consumer-side prefetch control
async function startWorkerWithBackpressure() {
  // Only fetch 5 messages at a time
  await channel.prefetch(5)

  // Monitor queue depth
  const queueInfo = await channel.checkQueue('booking.events')
  if (queueInfo.messageCount > 10000) {
    console.warn('Queue backlog detected, scaling consumers')
    metrics.gauge('queue.booking.depth', queueInfo.messageCount)
  }
}
```

### Background Jobs

| Job | Trigger | Frequency | Purpose |
|-----|---------|-----------|---------|
| `cleanup-expired-bookings` | Cron | Every 15 min | Cancel unpaid pending bookings |
| `aggregate-daily-stats` | Cron | Daily 3 AM | Roll up booking/revenue stats |
| `warm-search-cache` | Queue | On listing update | Pre-populate popular searches |
| `send-review-reminder` | Queue | 24h after checkout | Prompt guests to leave reviews |
| `sync-elasticsearch` | Queue | On data change | Keep search index current |

### Local Development Setup

```yaml
# docker-compose.yml addition for RabbitMQ
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"   # AMQP
      - "15672:15672" # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: airbnb
      RABBITMQ_DEFAULT_PASS: airbnb_dev
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq
```

```bash
# Environment variables
RABBITMQ_URL=amqp://airbnb:airbnb_dev@localhost:5672
QUEUE_PREFETCH=10
QUEUE_RETRY_DELAY_MS=5000
```

---

## Observability

### Metrics, Logs, and Traces Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                      Grafana Dashboard                          │
│     SLI visualization, alerts, service health                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Prometheus   │    │    Loki       │    │   Jaeger      │
│   (Metrics)   │    │   (Logs)      │    │  (Traces)     │
│               │    │               │    │               │
│ - Counters    │    │ - Structured  │    │ - Spans       │
│ - Gauges      │    │   JSON logs   │    │ - Service map │
│ - Histograms  │    │ - Labels      │    │ - Latency     │
└───────────────┘    └───────────────┘    └───────────────┘
        ▲                     ▲                     ▲
        │                     │                     │
┌─────────────────────────────────────────────────────────────────┐
│                    Application Services                         │
│           prom-client + winston + opentelemetry                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Metrics

```javascript
const promClient = require('prom-client')

// Enable default metrics (CPU, memory, event loop)
promClient.collectDefaultMetrics({ prefix: 'airbnb_' })

// Custom business metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'airbnb_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
})

const bookingCounter = new promClient.Counter({
  name: 'airbnb_bookings_total',
  help: 'Total number of bookings',
  labelNames: ['status', 'instant_book']
})

const searchLatency = new promClient.Histogram({
  name: 'airbnb_search_latency_seconds',
  help: 'Search request latency',
  labelNames: ['has_dates', 'has_guests'],
  buckets: [0.05, 0.1, 0.2, 0.5, 1]
})

const cacheHitRatio = new promClient.Gauge({
  name: 'airbnb_cache_hit_ratio',
  help: 'Cache hit ratio by cache type',
  labelNames: ['cache_type']
})

const queueDepth = new promClient.Gauge({
  name: 'airbnb_queue_depth',
  help: 'Number of messages in queue',
  labelNames: ['queue_name']
})
```

### SLI Definitions and Targets

| SLI | Definition | Target | Alert Threshold |
|-----|------------|--------|-----------------|
| Availability | Successful requests / Total requests | 99.9% | < 99.5% for 5 min |
| Search Latency | p95 of search response time | < 200ms | > 500ms for 5 min |
| Booking Latency | p95 of booking confirmation time | < 1s | > 2s for 5 min |
| Double-Booking Rate | Conflicting bookings / Total bookings | 0% | > 0 in 1 hour |
| Cache Hit Rate | Cache hits / Total cache requests | > 80% | < 60% for 15 min |
| Queue Lag | Time from publish to consume | < 30s | > 60s for 10 min |

### Structured Logging

```javascript
const winston = require('winston')

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'airbnb-api' },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/app.log' })
  ]
})

// Request logging middleware
function requestLogger(req, res, next) {
  const start = Date.now()
  const requestId = req.headers['x-request-id'] || generateUUID()

  req.requestId = requestId
  res.setHeader('x-request-id', requestId)

  res.on('finish', () => {
    const duration = Date.now() - start
    logger.info('HTTP request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      userId: req.user?.id,
      userAgent: req.headers['user-agent']
    })

    httpRequestDuration
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .observe(duration / 1000)
  })

  next()
}
```

### Distributed Tracing

```javascript
const { NodeSDK } = require('@opentelemetry/sdk-node')
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg')

const sdk = new NodeSDK({
  serviceName: 'airbnb-api',
  traceExporter: new JaegerExporter({
    endpoint: 'http://localhost:14268/api/traces'
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new PgInstrumentation()
  ]
})

sdk.start()

// Manual span for business logic
const { trace } = require('@opentelemetry/api')

async function createBooking(listingId, guestId, dates) {
  const tracer = trace.getTracer('booking-service')

  return tracer.startActiveSpan('createBooking', async (span) => {
    try {
      span.setAttributes({
        'booking.listing_id': listingId,
        'booking.guest_id': guestId,
        'booking.check_in': dates.checkIn,
        'booking.check_out': dates.checkOut
      })

      const booking = await executeBookingTransaction(listingId, guestId, dates)

      span.setAttributes({ 'booking.id': booking.id })
      return booking
    } catch (error) {
      span.recordException(error)
      span.setStatus({ code: 2, message: error.message })
      throw error
    } finally {
      span.end()
    }
  })
}
```

### Audit Logging

```javascript
// Audit log for sensitive operations
const auditLogger = winston.createLogger({
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'logs/audit.log' })
  ]
})

async function logAuditEvent(event) {
  const auditEntry = {
    timestamp: new Date().toISOString(),
    eventType: event.type,
    actor: {
      userId: event.userId,
      ip: event.ip,
      userAgent: event.userAgent
    },
    resource: {
      type: event.resourceType,
      id: event.resourceId
    },
    action: event.action,
    outcome: event.outcome,
    metadata: event.metadata
  }

  auditLogger.info('audit', auditEntry)

  // Also persist to database for querying
  await db('audit_logs').insert({
    event_type: event.type,
    user_id: event.userId,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    action: event.action,
    outcome: event.outcome,
    metadata: JSON.stringify(event.metadata),
    ip_address: event.ip,
    created_at: new Date()
  })
}

// Usage in booking flow
async function createBookingWithAudit(req, listingId, guestId, dates) {
  try {
    const booking = await createBooking(listingId, guestId, dates)

    await logAuditEvent({
      type: 'booking.created',
      userId: guestId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      resourceType: 'booking',
      resourceId: booking.id,
      action: 'create',
      outcome: 'success',
      metadata: { listingId, checkIn: dates.checkIn, checkOut: dates.checkOut }
    })

    return booking
  } catch (error) {
    await logAuditEvent({
      type: 'booking.failed',
      userId: guestId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      resourceType: 'listing',
      resourceId: listingId,
      action: 'create',
      outcome: 'failure',
      metadata: { error: error.message }
    })

    throw error
  }
}
```

### Alert Rules (Prometheus)

```yaml
# prometheus/alerts.yml
groups:
  - name: airbnb-slis
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(airbnb_http_request_duration_seconds_count{status=~"5.."}[5m]))
          / sum(rate(airbnb_http_request_duration_seconds_count[5m])) > 0.005
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: Error rate above 0.5% for 5 minutes

      - alert: SearchLatencyHigh
        expr: |
          histogram_quantile(0.95,
            sum(rate(airbnb_search_latency_seconds_bucket[5m])) by (le)
          ) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: Search p95 latency above 500ms

      - alert: BookingLatencyHigh
        expr: |
          histogram_quantile(0.95,
            sum(rate(airbnb_http_request_duration_seconds_bucket{route="/api/bookings"}[5m])) by (le)
          ) > 2
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: Booking p95 latency above 2s

      - alert: CacheHitRateLow
        expr: airbnb_cache_hit_ratio{cache_type="listing"} < 0.6
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: Cache hit rate below 60%

      - alert: QueueBacklogHigh
        expr: airbnb_queue_depth{queue_name="booking.events"} > 10000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: Queue depth exceeds 10k messages
```

### Local Development Setup

```yaml
# docker-compose.yml addition for observability
services:
  prometheus:
    image: prom/prometheus:v2.45.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus:/etc/prometheus
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'

  grafana:
    image: grafana/grafana:10.0.0
    ports:
      - "3001:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards
      - ./grafana/datasources:/etc/grafana/provisioning/datasources

  loki:
    image: grafana/loki:2.8.0
    ports:
      - "3100:3100"
    volumes:
      - loki_data:/loki

  jaeger:
    image: jaegertracing/all-in-one:1.47
    ports:
      - "16686:16686" # UI
      - "14268:14268" # Collector

volumes:
  prometheus_data:
  grafana_data:
  loki_data:
```

```bash
# Environment variables
PROMETHEUS_METRICS_PORT=9091
JAEGER_ENDPOINT=http://localhost:14268/api/traces
LOKI_URL=http://localhost:3100
LOG_LEVEL=info
ENABLE_AUDIT_LOGGING=true
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Calendar | Date ranges | Day-by-day | Storage efficiency |
| Geo search | PostGIS | Elasticsearch geo | Simplicity |
| Double-booking | Transaction lock | Distributed lock | Single DB is simpler |
| Reviews | Hidden until both submit | Immediate | Fairness |
| Caching | Cache-aside + write-through | Write-behind | Simpler invalidation, acceptable latency |
| Cache store | Valkey/Redis | Memcached | Richer data types, pub/sub for invalidation |
| Message queue | RabbitMQ | Kafka | Simpler setup, sufficient for booking throughput |
| Delivery semantics | At-least-once + idempotency | Exactly-once | Simpler, reliable with dedup |
| Tracing | OpenTelemetry + Jaeger | Zipkin | Vendor-neutral, better ecosystem |
| Logging | Structured JSON | Plain text | Query-friendly, Loki/ELK compatible |

---

## Implementation Notes

This section explains the **why** behind each major implementation decision for the caching, queue, observability, and reliability features.

### Why Cache-Aside Reduces Database Load for Search-Heavy Workloads

Airbnb is fundamentally a **read-heavy application**: users search for listings 100x more than they book. The search-to-booking ratio is typically 100:1 or higher, meaning for every booking, there are hundreds of searches and listing views.

**Problem Without Caching:**
- Each listing detail page fetches from PostgreSQL (listing + photos + reviews = 3 queries)
- Each search hits PostGIS spatial indexes (CPU-intensive)
- At scale (10M listings, 1M daily searches), database becomes the bottleneck

**Why Cache-Aside (Lazy Loading):**
1. **Only caches what's actually accessed** - Popular listings in Manhattan get cached; rural Montana cabin that's viewed once/month doesn't waste cache memory
2. **Naturally handles cold start** - No need to pre-warm the cache; it populates organically as users browse
3. **Simple invalidation** - Delete the key when data changes; next read repopulates
4. **Graceful degradation** - If Redis is down, requests fall back to database (slower but works)

**TTL Strategy:**
- Listings: 15 minutes - Property details change infrequently; stale data is acceptable
- Availability: 1 minute - Must be fresh to prevent booking conflicts
- Search: 5 minutes - Slightly stale results are fine; exact availability verified at booking

**Cache Invalidation Triggers:**
```javascript
// On listing update: delete listing cache + all search caches for that area
await invalidateListingCache(listingId);

// On booking: delete availability cache for that listing
await invalidateAvailabilityCache(listingId);
```

**Measured Impact (Expected):**
- Cache hit rate: 80%+ for popular listings
- Database query reduction: 60-70%
- Search latency improvement: 3x faster for cached results

---

### Why Async Queues Enable Reliable Notification Delivery

When a guest books a listing, multiple things need to happen:
1. Block the dates in the calendar
2. Charge the payment (future)
3. Email the guest confirmation
4. Push notification to the host
5. Update analytics/metrics
6. Trigger review reminder scheduling

**Problem With Synchronous Processing:**
- Booking API becomes slow (waiting for email, push, etc.)
- If email service is down, booking fails (bad UX)
- No retry mechanism for transient failures
- Traffic spikes overwhelm downstream services

**Why RabbitMQ (Message Queue):**

1. **Decoupling** - Booking service publishes event and returns immediately; notification workers consume asynchronously
   ```javascript
   // Booking completes in <500ms
   await publishBookingCreated(booking, listing);
   res.status(201).json({ booking }); // User sees success immediately

   // Separately, workers process notifications (can take 5-10 seconds)
   ```

2. **Reliability (At-Least-Once Delivery)** - Messages persist until acknowledged
   - If worker crashes mid-processing, message is redelivered
   - Dead-letter queue captures permanently failed messages for investigation

3. **Backpressure Handling** - Queue absorbs traffic spikes
   - Black Friday: 10x normal booking volume
   - Queue buffers the spike; workers process at sustainable rate
   - Users see fast booking responses; notifications may be delayed 30 seconds

4. **Retry with Exponential Backoff:**
   ```javascript
   // Retry 1: 5 seconds
   // Retry 2: 10 seconds
   // Retry 3: 20 seconds
   // Then: Dead-letter queue
   ```

5. **Idempotency Protection:**
   ```javascript
   // Track processed message IDs in Redis (TTL 7 days)
   if (await redis.get(`processed:${eventId}`)) {
     channel.ack(msg); // Already processed, skip
     return;
   }
   ```

**Queue Design:**
| Queue | Purpose | Consumers |
|-------|---------|-----------|
| `booking.events` | Booking lifecycle | Notification, Analytics |
| `host.alerts` | Host notifications | Push, Email workers |
| `notification.send` | All notification types | Email, SMS, Push workers |

---

### Why Audit Logging Enables Dispute Resolution

Airbnb handles money and trust. When disputes arise, clear evidence is essential:
- "I never cancelled that booking!" - Audit log shows IP, timestamp, session
- "The host changed the price after I booked!" - Audit log shows before/after state
- "Someone hacked my account and booked!" - Audit log shows unusual IP/device

**What We Log:**
```javascript
{
  event_type: 'booking.cancelled',
  user_id: 123,
  resource_type: 'booking',
  resource_id: 456,
  action: 'cancel',
  outcome: 'success',
  ip_address: '192.168.1.1',
  user_agent: 'Mozilla/5.0...',
  session_id: 'sess_abc123',
  request_id: 'req_xyz789',  // For tracing
  metadata: { cancelledBy: 'guest', reason: 'schedule_change' },
  before_state: { status: 'confirmed', ... },
  after_state: { status: 'cancelled', cancelled_at: '2025-01-15T10:30:00Z' },
  created_at: '2025-01-15T10:30:00.123Z'
}
```

**Use Cases:**

1. **Dispute Resolution** - Customer service can pull complete history:
   ```sql
   SELECT * FROM audit_logs
   WHERE resource_type = 'booking' AND resource_id = 456
   ORDER BY created_at;
   ```

2. **Fraud Detection** - Identify suspicious patterns:
   ```sql
   -- Multiple cancellations from same IP
   SELECT ip_address, COUNT(*) FROM audit_logs
   WHERE event_type = 'booking.cancelled'
   GROUP BY ip_address HAVING COUNT(*) > 10;
   ```

3. **Compliance** - Required for financial regulations:
   - Who approved the refund?
   - When was personal data accessed?
   - Who modified the listing price?

4. **Debugging** - Trace issues through request_id:
   ```sql
   SELECT * FROM audit_logs WHERE request_id = 'req_xyz789';
   ```

**Storage Strategy:**
- Hot data (30 days): PostgreSQL `audit_logs` table with indexes
- Cold data (1+ year): Archive to S3/object storage for compliance

---

### Why Metrics Enable Pricing Optimization

Airbnb's business depends on understanding user behavior to optimize pricing, search ranking, and conversion rates.

**Business Questions Metrics Answer:**

1. **Are hosts pricing correctly?**
   ```promql
   # Average revenue per property type
   sum(rate(airbnb_booking_revenue_total[24h])) by (property_type)
   / sum(rate(airbnb_bookings_total{status="confirmed"}[24h])) by (property_type)
   ```
   If cabins have lower revenue/booking than apartments, recommend hosts adjust pricing.

2. **What's our search-to-booking conversion?**
   ```promql
   rate(airbnb_bookings_total[1h]) / rate(airbnb_searches_total[1h])
   ```
   If conversion drops, investigate search ranking algorithm.

3. **Where are users dropping off?**
   ```promql
   # Availability checks vs actual bookings
   rate(airbnb_availability_checks_total{available="true"}[1h])
   / rate(airbnb_bookings_total[1h])
   ```
   High availability check rate with low booking rate = pricing or UX issue.

4. **Is the system healthy for users?**
   ```promql
   # Search latency p95
   histogram_quantile(0.95, rate(airbnb_search_latency_seconds_bucket[5m]))

   # Alert if > 500ms
   ```

**Metrics We Track:**

| Metric | Type | Purpose |
|--------|------|---------|
| `airbnb_bookings_total` | Counter | Conversion tracking, revenue |
| `airbnb_booking_revenue_total` | Counter | Revenue by property type, city |
| `airbnb_booking_nights_total` | Counter | Average stay length trends |
| `airbnb_searches_total` | Counter | Demand patterns, geographic trends |
| `airbnb_search_latency_seconds` | Histogram | Performance SLI |
| `airbnb_availability_checks_total` | Counter | Demand/supply matching |
| `airbnb_cache_hits_total` | Counter | Infrastructure efficiency |

**Pricing Optimization Flow:**
1. Collect booking/search metrics per location + property type
2. Build demand model (searches per available night)
3. Recommend price adjustments to hosts
4. A/B test pricing suggestions
5. Measure conversion rate changes

**SLI/SLO Dashboard Example:**
```
| SLI | Target | Current | Alert |
|-----|--------|---------|-------|
| Search p95 | < 200ms | 145ms | OK |
| Booking success rate | > 99% | 99.7% | OK |
| Cache hit ratio | > 80% | 82% | OK |
| Queue lag | < 30s | 5s | OK |
```

---

## Frontend Architecture

The React frontend follows a modular architecture with clear separation of concerns. This section describes the component organization and patterns used.

### Directory Structure

```
frontend/src/
├── components/                    # Reusable UI components
│   ├── BookingWidget.tsx          # Booking form with calendar
│   ├── Calendar.tsx               # Date selection calendar
│   ├── Header.tsx                 # Site navigation header
│   ├── ListingCard.tsx            # Listing preview card
│   ├── SearchBar.tsx              # Search input with filters
│   └── listing-form/              # Multi-step listing creation wizard
│       ├── index.ts               # Barrel export for all components
│       ├── types.ts               # Shared types and constants
│       ├── useListingForm.ts      # Form state management hook
│       ├── ProgressIndicator.tsx  # Step progress visualization
│       ├── StepBasicInfo.tsx      # Step 1: Property type, title
│       ├── StepLocation.tsx       # Step 2: Address, coordinates
│       ├── StepDetails.tsx        # Step 3: Capacity, amenities
│       └── StepPricing.tsx        # Step 4: Price, booking settings
├── hooks/                         # Custom React hooks
├── routes/                        # Page components (Tanstack Router)
│   ├── __root.tsx                 # Root layout with Header
│   ├── index.tsx                  # Home page
│   ├── search.tsx                 # Search results
│   ├── listing.$id.tsx            # Listing detail page
│   ├── trips.tsx                  # Guest trip history
│   ├── messages.tsx               # Conversations
│   └── host/                      # Host-specific pages
│       ├── listings.tsx           # Manage listings
│       ├── listings.new.tsx       # Create new listing (wizard)
│       └── reservations.tsx       # Manage reservations
├── services/                      # API client functions
│   └── api.ts                     # Centralized API calls
├── stores/                        # Zustand state stores
│   └── authStore.ts               # Authentication state
├── types/                         # TypeScript type definitions
│   └── index.ts                   # Shared types (Listing, Booking, etc.)
└── utils/                         # Helper functions
    └── helpers.ts                 # Formatters, label mappers
```

### Component Organization Principles

#### 1. Feature-Based Grouping

Related components are grouped into feature directories with barrel exports:

```typescript
// Import from feature directory
import {
  StepBasicInfo,
  StepLocation,
  useListingForm,
  PROPERTY_TYPES,
} from '../components/listing-form';
```

#### 2. Custom Hooks for State Logic

Complex state management is extracted into custom hooks:

```typescript
// useListingForm.ts encapsulates:
// - Multi-step navigation
// - Form field state
// - Validation logic
// - API submission
const { step, formData, updateField, submitForm } = useListingForm();
```

#### 3. Prop Interfaces with JSDoc

All components have documented props:

```typescript
interface StepBasicInfoProps extends StepNavigationProps {
  /** Current form data */
  formData: ListingFormData;
  /** Callback to update form fields */
  onUpdate: <K extends keyof ListingFormData>(field: K, value: ListingFormData[K]) => void;
}
```

#### 4. Component Size Guidelines

- **Route components**: < 150 lines, orchestration only
- **Feature components**: < 200 lines, single responsibility
- **Shared components**: < 100 lines, highly reusable

### State Management Strategy

| State Type | Solution | Example |
|------------|----------|---------|
| Server data | React Query / useEffect | Listings, bookings |
| Auth state | Zustand store | Current user, session |
| Form state | Custom hook / useState | Listing creation wizard |
| UI state | Local useState | Modal open, tab selection |

### Multi-Step Form Pattern

The listing creation wizard demonstrates the pattern for complex forms:

```
┌─────────────────────────────────────────────────────────┐
│                  NewListingPage                         │
│  (Route component - orchestrates steps)                 │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              useListingForm Hook                 │   │
│  │  - step state                                    │   │
│  │  - formData state                                │   │
│  │  - navigation functions                          │   │
│  │  - submit function                               │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │  Step 1  │ │  Step 2  │ │  Step 3  │ │  Step 4  │  │
│  │ BasicInfo│ │ Location │ │ Details  │ │ Pricing  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│       ▲            ▲            ▲            ▲         │
│       │            │            │            │         │
│       └────────────┴────────────┴────────────┘         │
│              Shared: formData, onUpdate                 │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Testing Strategy (Planned)

| Layer | Tool | Coverage |
|-------|------|----------|
| Components | Vitest + Testing Library | User interactions |
| Hooks | Vitest | State transitions |
| API calls | MSW | Mock server responses |
| E2E | Playwright | Critical user flows |

---

### Circuit Breaker for Resilience

The circuit breaker pattern prevents cascading failures when dependent services fail.

**Problem Scenario:**
1. PostgreSQL has high latency due to a slow query
2. All API requests wait, connection pool exhausts
3. Health checks fail, load balancer marks all instances unhealthy
4. Complete outage

**Circuit Breaker Solution:**
```javascript
// If 50% of requests fail over 10 seconds, open the circuit
const breaker = createCircuitBreaker('search', searchFn, {
  errorThresholdPercentage: 50,
  resetTimeout: 30000, // Try again after 30 seconds
});

// When circuit is open, return fallback immediately
breaker.fallback(() => ({ listings: [], fromFallback: true }));
```

**States:**
- **CLOSED** - Normal operation, requests go through
- **OPEN** - Too many failures, fail immediately with fallback
- **HALF-OPEN** - Testing if service recovered

**Configured Breakers:**
| Service | Timeout | Threshold | Fallback |
|---------|---------|-----------|----------|
| Search | 5s | 60% failures | Empty results |
| Availability | 3s | 40% failures | "Unavailable" |
| Notifications | 15s | 70% failures | Queue for retry |

This prevents one slow query from taking down the entire API.
