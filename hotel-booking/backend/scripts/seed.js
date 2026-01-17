const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Load environment
require('dotenv').config();

const db = require('../src/models/db');
const elasticsearch = require('../src/models/elasticsearch');

const sampleHotels = [
  {
    name: 'Grand Plaza Hotel',
    description: 'A luxurious 5-star hotel in the heart of downtown with stunning city views and world-class amenities.',
    address: '123 Main Street',
    city: 'New York',
    state: 'NY',
    country: 'USA',
    postalCode: '10001',
    latitude: 40.7128,
    longitude: -74.0060,
    starRating: 5,
    amenities: ['wifi', 'pool', 'gym', 'spa', 'restaurant', 'bar', 'room_service', 'parking', 'concierge'],
    checkInTime: '15:00',
    checkOutTime: '11:00',
    cancellationPolicy: 'Free cancellation up to 48 hours before check-in',
    images: [
      'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800',
      'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=800',
      'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800',
    ],
    roomTypes: [
      { name: 'Standard Room', description: 'Comfortable room with city view', capacity: 2, bedType: 'Queen', totalCount: 20, basePrice: 199, amenities: ['wifi', 'tv', 'minibar', 'safe'], sizeSqm: 28 },
      { name: 'Deluxe Room', description: 'Spacious room with premium amenities', capacity: 2, bedType: 'King', totalCount: 15, basePrice: 299, amenities: ['wifi', 'tv', 'minibar', 'safe', 'bathtub'], sizeSqm: 35 },
      { name: 'Executive Suite', description: 'Luxurious suite with separate living area', capacity: 3, bedType: 'King', totalCount: 8, basePrice: 499, amenities: ['wifi', 'tv', 'minibar', 'safe', 'bathtub', 'living_room'], sizeSqm: 55 },
      { name: 'Presidential Suite', description: 'The ultimate luxury experience', capacity: 4, bedType: 'King', totalCount: 2, basePrice: 999, amenities: ['wifi', 'tv', 'minibar', 'safe', 'bathtub', 'living_room', 'dining_room', 'butler_service'], sizeSqm: 120 },
    ],
  },
  {
    name: 'Seaside Resort & Spa',
    description: 'Beautiful beachfront resort with private beach access and full-service spa.',
    address: '500 Ocean Drive',
    city: 'Miami',
    state: 'FL',
    country: 'USA',
    postalCode: '33139',
    latitude: 25.7617,
    longitude: -80.1918,
    starRating: 4,
    amenities: ['wifi', 'pool', 'gym', 'spa', 'restaurant', 'bar', 'beach_access', 'water_sports'],
    checkInTime: '16:00',
    checkOutTime: '10:00',
    cancellationPolicy: 'Free cancellation up to 24 hours before check-in',
    images: [
      'https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800',
      'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=800',
    ],
    roomTypes: [
      { name: 'Ocean View Room', description: 'Room with stunning ocean views', capacity: 2, bedType: 'Queen', totalCount: 30, basePrice: 249, amenities: ['wifi', 'tv', 'minibar', 'balcony'], sizeSqm: 32 },
      { name: 'Beachfront Suite', description: 'Direct beach access from your room', capacity: 2, bedType: 'King', totalCount: 10, basePrice: 449, amenities: ['wifi', 'tv', 'minibar', 'balcony', 'living_room'], sizeSqm: 50 },
      { name: 'Family Villa', description: 'Perfect for families with private pool', capacity: 6, bedType: 'Multiple', totalCount: 5, basePrice: 699, amenities: ['wifi', 'tv', 'kitchen', 'private_pool', 'garden'], sizeSqm: 100 },
    ],
  },
  {
    name: 'Mountain Lodge Retreat',
    description: 'Cozy mountain lodge with ski-in/ski-out access and rustic charm.',
    address: '789 Alpine Way',
    city: 'Aspen',
    state: 'CO',
    country: 'USA',
    postalCode: '81611',
    latitude: 39.1911,
    longitude: -106.8175,
    starRating: 4,
    amenities: ['wifi', 'restaurant', 'bar', 'ski_access', 'fireplace', 'hot_tub', 'ski_storage'],
    checkInTime: '15:00',
    checkOutTime: '11:00',
    cancellationPolicy: 'Free cancellation up to 7 days before check-in during ski season',
    images: [
      'https://images.unsplash.com/photo-1518602164578-cd0074062767?w=800',
      'https://images.unsplash.com/photo-1602002418082-a4443e081dd1?w=800',
    ],
    roomTypes: [
      { name: 'Mountain View Room', description: 'Cozy room with mountain views', capacity: 2, bedType: 'Queen', totalCount: 25, basePrice: 279, amenities: ['wifi', 'tv', 'fireplace'], sizeSqm: 30 },
      { name: 'Ski Chalet', description: 'Private chalet with ski-in/ski-out access', capacity: 4, bedType: 'Multiple', totalCount: 8, basePrice: 549, amenities: ['wifi', 'tv', 'fireplace', 'kitchen', 'hot_tub'], sizeSqm: 75 },
    ],
  },
  {
    name: 'Urban Boutique Hotel',
    description: 'Stylish boutique hotel in the arts district with unique designer rooms.',
    address: '42 Gallery Lane',
    city: 'San Francisco',
    state: 'CA',
    country: 'USA',
    postalCode: '94102',
    latitude: 37.7749,
    longitude: -122.4194,
    starRating: 3,
    amenities: ['wifi', 'restaurant', 'bar', 'art_gallery', 'rooftop_terrace'],
    checkInTime: '14:00',
    checkOutTime: '12:00',
    cancellationPolicy: 'Free cancellation up to 24 hours before check-in',
    images: [
      'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=800',
    ],
    roomTypes: [
      { name: 'Artist Loft', description: 'Uniquely designed room with local artwork', capacity: 2, bedType: 'Queen', totalCount: 15, basePrice: 189, amenities: ['wifi', 'tv', 'artwork'], sizeSqm: 25 },
      { name: 'Designer Suite', description: 'Award-winning interior design', capacity: 2, bedType: 'King', totalCount: 5, basePrice: 329, amenities: ['wifi', 'tv', 'artwork', 'living_room'], sizeSqm: 45 },
    ],
  },
  {
    name: 'Historic Downtown Inn',
    description: 'Charming historic inn in a beautifully restored 19th century building.',
    address: '101 Heritage Square',
    city: 'Boston',
    state: 'MA',
    country: 'USA',
    postalCode: '02108',
    latitude: 42.3601,
    longitude: -71.0589,
    starRating: 3,
    amenities: ['wifi', 'restaurant', 'bar', 'garden', 'library'],
    checkInTime: '15:00',
    checkOutTime: '11:00',
    cancellationPolicy: 'Free cancellation up to 24 hours before check-in',
    images: [
      'https://images.unsplash.com/photo-1564501049412-61c2a3083791?w=800',
    ],
    roomTypes: [
      { name: 'Classic Room', description: 'Elegant room with period furnishings', capacity: 2, bedType: 'Queen', totalCount: 12, basePrice: 159, amenities: ['wifi', 'tv'], sizeSqm: 22 },
      { name: 'Heritage Suite', description: 'Luxurious suite with antique decor', capacity: 2, bedType: 'King', totalCount: 4, basePrice: 279, amenities: ['wifi', 'tv', 'sitting_area', 'fireplace'], sizeSqm: 40 },
    ],
  },
];

async function seed() {
  console.log('Starting database seed...');

  try {
    // Create admin user
    const adminPassword = await bcrypt.hash('admin123', 12);
    const adminResult = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET password_hash = $2
       RETURNING id`,
      ['admin@hotel-booking.com', adminPassword, 'Admin', 'User', 'admin']
    );
    console.log('Admin user created');

    // Create hotel admin user
    const hotelAdminPassword = await bcrypt.hash('hoteladmin123', 12);
    const hotelAdminResult = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET password_hash = $2
       RETURNING id`,
      ['hotel@hotel-booking.com', hotelAdminPassword, 'Hotel', 'Manager', 'hotel_admin']
    );
    const hotelAdminId = hotelAdminResult.rows[0].id;
    console.log('Hotel admin user created');

    // Create regular user
    const userPassword = await bcrypt.hash('user123', 12);
    await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET password_hash = $2
       RETURNING id`,
      ['user@hotel-booking.com', userPassword, 'John', 'Doe', 'user']
    );
    console.log('Regular user created');

    // Setup Elasticsearch index
    await elasticsearch.setupIndex();
    console.log('Elasticsearch index setup complete');

    // Create hotels and room types
    for (const hotelData of sampleHotels) {
      const { roomTypes, ...hotel } = hotelData;

      // Insert hotel
      const hotelResult = await db.query(
        `INSERT INTO hotels
         (owner_id, name, description, address, city, state, country, postal_code,
          latitude, longitude, star_rating, amenities, check_in_time, check_out_time,
          cancellation_policy, images)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          hotelAdminId,
          hotel.name,
          hotel.description,
          hotel.address,
          hotel.city,
          hotel.state,
          hotel.country,
          hotel.postalCode,
          hotel.latitude,
          hotel.longitude,
          hotel.starRating,
          hotel.amenities,
          hotel.checkInTime,
          hotel.checkOutTime,
          hotel.cancellationPolicy,
          hotel.images,
        ]
      );

      const hotelId = hotelResult.rows[0].id;
      console.log(`Created hotel: ${hotel.name}`);

      // Insert room types
      const insertedRoomTypes = [];
      for (const room of roomTypes) {
        const roomResult = await db.query(
          `INSERT INTO room_types
           (hotel_id, name, description, capacity, bed_type, total_count, base_price, amenities, size_sqm)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            hotelId,
            room.name,
            room.description,
            room.capacity,
            room.bedType,
            room.totalCount,
            room.basePrice,
            room.amenities,
            room.sizeSqm,
          ]
        );
        insertedRoomTypes.push(roomResult.rows[0]);
        console.log(`  Created room type: ${room.name}`);
      }

      // Index hotel in Elasticsearch
      const esDoc = {
        hotel_id: hotelId,
        name: hotel.name,
        description: hotel.description,
        city: hotel.city,
        state: hotel.state,
        country: hotel.country,
        address: hotel.address,
        location: { lat: hotel.latitude, lon: hotel.longitude },
        star_rating: hotel.starRating,
        amenities: hotel.amenities,
        images: hotel.images,
        check_in_time: hotel.checkInTime,
        check_out_time: hotel.checkOutTime,
        is_active: true,
        room_types: insertedRoomTypes.map((rt) => ({
          id: rt.id,
          name: rt.name,
          capacity: rt.capacity,
          base_price: parseFloat(rt.base_price),
          amenities: rt.amenities,
        })),
        min_price: Math.min(...insertedRoomTypes.map((rt) => parseFloat(rt.base_price))),
        max_capacity: Math.max(...insertedRoomTypes.map((rt) => rt.capacity)),
        avg_rating: 0,
        review_count: 0,
      };

      await elasticsearch.indexHotel(esDoc);
      console.log(`  Indexed in Elasticsearch`);
    }

    console.log('\nSeed completed successfully!');
    console.log('\nTest accounts:');
    console.log('  Admin: admin@hotel-booking.com / admin123');
    console.log('  Hotel Admin: hotel@hotel-booking.com / hoteladmin123');
    console.log('  User: user@hotel-booking.com / user123');

    process.exit(0);
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
}

seed();
