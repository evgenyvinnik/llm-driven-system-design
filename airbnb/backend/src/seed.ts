import { query } from './db.js';
import { hashPassword } from './services/auth.js';
import { connectRedis } from './redis.js';

const sampleListings = [
  {
    title: 'Cozy Downtown Studio',
    description: 'A charming studio apartment in the heart of the city. Walking distance to restaurants, shops, and public transit.',
    latitude: 40.7484,
    longitude: -73.9857,
    city: 'New York',
    state: 'NY',
    country: 'USA',
    property_type: 'studio',
    room_type: 'entire_place',
    max_guests: 2,
    bedrooms: 0,
    beds: 1,
    bathrooms: 1,
    amenities: ['wifi', 'kitchen', 'air_conditioning', 'washer', 'tv'],
    price_per_night: 120,
    cleaning_fee: 50,
    instant_book: true,
  },
  {
    title: 'Spacious Brooklyn Loft',
    description: 'Industrial-chic loft with exposed brick, high ceilings, and modern amenities. Perfect for couples or solo travelers.',
    latitude: 40.6892,
    longitude: -73.9442,
    city: 'Brooklyn',
    state: 'NY',
    country: 'USA',
    property_type: 'loft',
    room_type: 'entire_place',
    max_guests: 4,
    bedrooms: 1,
    beds: 2,
    bathrooms: 1,
    amenities: ['wifi', 'kitchen', 'heating', 'workspace', 'tv', 'coffee_maker'],
    price_per_night: 175,
    cleaning_fee: 75,
    instant_book: true,
  },
  {
    title: 'Sunny Venice Beach Apartment',
    description: 'Steps from the beach! Enjoy the California lifestyle in this bright, modern apartment with ocean views.',
    latitude: 33.985,
    longitude: -118.4695,
    city: 'Los Angeles',
    state: 'CA',
    country: 'USA',
    property_type: 'apartment',
    room_type: 'entire_place',
    max_guests: 3,
    bedrooms: 1,
    beds: 1,
    bathrooms: 1,
    amenities: ['wifi', 'kitchen', 'air_conditioning', 'pool', 'parking', 'beach_access'],
    price_per_night: 200,
    cleaning_fee: 80,
    instant_book: false,
  },
  {
    title: 'Charming Victorian in SF',
    description: 'Beautiful Victorian home with modern updates. Located in a quiet neighborhood with easy access to downtown.',
    latitude: 37.7749,
    longitude: -122.4194,
    city: 'San Francisco',
    state: 'CA',
    country: 'USA',
    property_type: 'house',
    room_type: 'entire_place',
    max_guests: 6,
    bedrooms: 3,
    beds: 4,
    bathrooms: 2,
    amenities: ['wifi', 'kitchen', 'heating', 'washer', 'dryer', 'parking', 'backyard'],
    price_per_night: 350,
    cleaning_fee: 100,
    instant_book: true,
  },
  {
    title: 'Mountain Cabin Retreat',
    description: 'Escape to nature in this cozy cabin. Hiking trails, stunning views, and complete tranquility await.',
    latitude: 39.5501,
    longitude: -105.7821,
    city: 'Denver',
    state: 'CO',
    country: 'USA',
    property_type: 'cabin',
    room_type: 'entire_place',
    max_guests: 4,
    bedrooms: 2,
    beds: 2,
    bathrooms: 1,
    amenities: ['wifi', 'kitchen', 'fireplace', 'heating', 'hot_tub', 'parking'],
    price_per_night: 180,
    cleaning_fee: 60,
    instant_book: false,
  },
  {
    title: 'Modern Miami Condo',
    description: 'Luxury condo with stunning bay views. Rooftop pool, gym, and walking distance to nightlife.',
    latitude: 25.7617,
    longitude: -80.1918,
    city: 'Miami',
    state: 'FL',
    country: 'USA',
    property_type: 'apartment',
    room_type: 'entire_place',
    max_guests: 4,
    bedrooms: 2,
    beds: 2,
    bathrooms: 2,
    amenities: ['wifi', 'kitchen', 'air_conditioning', 'pool', 'gym', 'doorman'],
    price_per_night: 250,
    cleaning_fee: 90,
    instant_book: true,
  },
  {
    title: 'Cozy Room in Shared Home',
    description: 'Private room in a friendly shared home. Great for budget travelers looking to meet locals.',
    latitude: 47.6062,
    longitude: -122.3321,
    city: 'Seattle',
    state: 'WA',
    country: 'USA',
    property_type: 'room',
    room_type: 'private_room',
    max_guests: 2,
    bedrooms: 1,
    beds: 1,
    bathrooms: 1,
    amenities: ['wifi', 'kitchen', 'heating', 'washer', 'coffee_maker'],
    price_per_night: 65,
    cleaning_fee: 25,
    instant_book: true,
  },
  {
    title: 'Historic Boston Brownstone',
    description: 'Elegant brownstone in historic Back Bay. Classic architecture with modern comforts.',
    latitude: 42.3601,
    longitude: -71.0589,
    city: 'Boston',
    state: 'MA',
    country: 'USA',
    property_type: 'house',
    room_type: 'entire_place',
    max_guests: 8,
    bedrooms: 4,
    beds: 5,
    bathrooms: 2.5,
    amenities: ['wifi', 'kitchen', 'heating', 'air_conditioning', 'washer', 'dryer', 'parking'],
    price_per_night: 400,
    cleaning_fee: 120,
    instant_book: false,
  },
];

async function seed() {
  try {
    await connectRedis();
    console.log('Connected to Redis');

    console.log('Seeding database...');

    // Create users
    const password = await hashPassword('password123');

    // Create hosts
    const host1Result = await query(
      `INSERT INTO users (email, password_hash, name, is_host, bio)
      VALUES ($1, $2, $3, TRUE, $4)
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`,
      ['host1@example.com', password, 'Sarah Johnson', 'Superhost with 5+ years of experience. I love meeting travelers!']
    );
    const host1Id = host1Result.rows[0].id;

    const host2Result = await query(
      `INSERT INTO users (email, password_hash, name, is_host, bio)
      VALUES ($1, $2, $3, TRUE, $4)
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`,
      ['host2@example.com', password, 'Michael Chen', 'Property investor and travel enthusiast. My spaces are designed for comfort.']
    );
    const host2Id = host2Result.rows[0].id;

    // Create guests
    const guest1Result = await query(
      `INSERT INTO users (email, password_hash, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`,
      ['guest1@example.com', password, 'Emily Davis']
    );
    const guest1Id = guest1Result.rows[0].id;

    const guest2Result = await query(
      `INSERT INTO users (email, password_hash, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`,
      ['guest2@example.com', password, 'James Wilson']
    );
    const guest2Id = guest2Result.rows[0].id;

    // Create admin
    await query(
      `INSERT INTO users (email, password_hash, name, role)
      VALUES ($1, $2, $3, 'admin')
      ON CONFLICT (email) DO UPDATE SET role = 'admin'
      RETURNING id`,
      ['admin@example.com', password, 'Admin User']
    );

    console.log('Users created');

    // Clear existing listings
    await query('DELETE FROM listings');

    // Create listings
    const hosts = [host1Id, host2Id];
    const listingIds = [];

    for (let i = 0; i < sampleListings.length; i++) {
      const listing = sampleListings[i];
      const hostId = hosts[i % hosts.length];

      const result = await query(
        `INSERT INTO listings (
          host_id, title, description, location, city, state, country,
          property_type, room_type, max_guests, bedrooms, beds, bathrooms,
          amenities, price_per_night, cleaning_fee, instant_book
        ) VALUES (
          $1, $2, $3, ST_MakePoint($4, $5)::geography, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
        ) RETURNING id`,
        [
          hostId, listing.title, listing.description, listing.longitude, listing.latitude,
          listing.city, listing.state, listing.country, listing.property_type,
          listing.room_type, listing.max_guests, listing.bedrooms, listing.beds,
          listing.bathrooms, listing.amenities, listing.price_per_night,
          listing.cleaning_fee, listing.instant_book,
        ]
      );

      listingIds.push(result.rows[0].id);

      // Add sample photo URLs (placeholder images)
      await query(
        `INSERT INTO listing_photos (listing_id, url, display_order) VALUES ($1, $2, 0)`,
        [result.rows[0].id, `https://picsum.photos/seed/${result.rows[0].id}/800/600`]
      );
    }

    console.log('Listings created');

    // Create a sample completed booking with reviews
    if (listingIds.length > 0) {
      const checkIn = new Date();
      checkIn.setDate(checkIn.getDate() - 14);
      const checkOut = new Date();
      checkOut.setDate(checkOut.getDate() - 11);

      const bookingResult = await query(
        `INSERT INTO bookings (
          listing_id, guest_id, check_in, check_out, guests,
          nights, price_per_night, cleaning_fee, service_fee, total_price, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed')
        RETURNING id`,
        [listingIds[0], guest1Id, checkIn, checkOut, 2, 3, 120, 50, 36, 446]
      );

      const bookingId = bookingResult.rows[0].id;

      // Add availability block for the booking
      await query(
        `INSERT INTO availability_blocks (listing_id, start_date, end_date, status, booking_id)
        VALUES ($1, $2, $3, 'booked', $4)`,
        [listingIds[0], checkIn, checkOut, bookingId]
      );

      // Add reviews (both sides, so they become visible)
      await query(
        `INSERT INTO reviews (booking_id, author_id, author_type, rating, cleanliness_rating, communication_rating, location_rating, value_rating, content)
        VALUES ($1, $2, 'guest', 5, 5, 5, 5, 4, 'Amazing stay! The apartment was exactly as described. Sarah was a wonderful host.')`,
        [bookingId, guest1Id]
      );

      await query(
        `INSERT INTO reviews (booking_id, author_id, author_type, rating, content)
        VALUES ($1, $2, 'host', 5, 'Emily was a fantastic guest. Left the place spotless. Would welcome back anytime!')`,
        [bookingId, host1Id]
      );

      console.log('Sample booking and reviews created');
    }

    console.log('Database seeded successfully!');
    console.log('\nSample login credentials:');
    console.log('  Host: host1@example.com / password123');
    console.log('  Host: host2@example.com / password123');
    console.log('  Guest: guest1@example.com / password123');
    console.log('  Guest: guest2@example.com / password123');
    console.log('  Admin: admin@example.com / password123');

    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
