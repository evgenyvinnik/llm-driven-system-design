import pg from 'pg';
import { v4 as uuid } from 'uuid';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'maps',
  password: process.env.DB_PASSWORD || 'mapspassword',
  database: process.env.DB_NAME || 'apple_maps',
});

/**
 * Generate a grid-based road network centered on San Francisco
 */
async function seedDatabase() {
  console.log('Seeding database...');

  // San Francisco coordinates as center
  const centerLat = 37.7749;
  const centerLng = -122.4194;

  // Grid parameters
  const gridSize = 20; // 20x20 grid
  const spacing = 0.005; // ~0.5km between nodes

  // Street names
  const nsStreets = [
    'Van Ness Ave', 'Polk St', 'Larkin St', 'Hyde St', 'Leavenworth St',
    'Jones St', 'Taylor St', 'Mason St', 'Powell St', 'Stockton St',
    'Grant Ave', 'Kearny St', 'Montgomery St', 'Sansome St', 'Battery St',
    'Front St', 'Davis St', 'Drumm St', 'Main St', 'Spear St'
  ];

  const ewStreets = [
    'Market St', 'Mission St', 'Howard St', 'Folsom St', 'Harrison St',
    'Bryant St', 'Brannan St', 'Townsend St', 'King St', 'Berry St',
    'Bush St', 'Sutter St', 'Post St', 'Geary St', 'O\'Farrell St',
    'Ellis St', 'Eddy St', 'Turk St', 'Golden Gate Ave', 'McAllister St'
  ];

  // Clear existing data
  console.log('Clearing existing data...');
  await pool.query('DELETE FROM navigation_sessions');
  await pool.query('DELETE FROM incidents');
  await pool.query('DELETE FROM traffic_flow');
  await pool.query('DELETE FROM pois');
  await pool.query('DELETE FROM road_segments');
  await pool.query('DELETE FROM road_nodes');

  // Create nodes
  console.log('Creating road nodes...');
  const nodeIds = [];

  for (let row = 0; row < gridSize; row++) {
    const rowIds = [];
    for (let col = 0; col < gridSize; col++) {
      const lat = centerLat - (gridSize / 2 - row) * spacing;
      const lng = centerLng - (gridSize / 2 - col) * spacing;
      const isIntersection = true;

      const result = await pool.query(`
        INSERT INTO road_nodes (location, lat, lng, is_intersection)
        VALUES (ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $1, $2, $3)
        RETURNING id
      `, [lat, lng, isIntersection]);

      rowIds.push(result.rows[0].id);
    }
    nodeIds.push(rowIds);
  }

  console.log(`Created ${gridSize * gridSize} nodes`);

  // Create segments (roads)
  console.log('Creating road segments...');
  let segmentCount = 0;

  // Horizontal roads (East-West)
  for (let row = 0; row < gridSize; row++) {
    const streetName = ewStreets[row % ewStreets.length];
    const roadClass = row === Math.floor(gridSize / 2) ? 'arterial' : 'local';
    const speed = roadClass === 'arterial' ? 50 : 35;

    for (let col = 0; col < gridSize - 1; col++) {
      const startNodeId = nodeIds[row][col];
      const endNodeId = nodeIds[row][col + 1];

      const startLat = centerLat - (gridSize / 2 - row) * spacing;
      const startLng = centerLng - (gridSize / 2 - col) * spacing;
      const endLat = startLat;
      const endLng = centerLng - (gridSize / 2 - col - 1) * spacing;

      // Calculate length in meters (approximate)
      const length = spacing * 111000 * Math.cos(startLat * Math.PI / 180);

      await pool.query(`
        INSERT INTO road_segments (
          start_node_id, end_node_id, geometry, street_name, road_class,
          length_meters, free_flow_speed_kph, is_toll, is_one_way
        )
        VALUES (
          $1, $2,
          ST_SetSRID(ST_MakeLine(ST_MakePoint($4, $3), ST_MakePoint($6, $5)), 4326)::geography,
          $7, $8, $9, $10, FALSE, FALSE
        )
      `, [
        startNodeId, endNodeId, startLat, startLng, endLat, endLng,
        streetName, roadClass, length, speed
      ]);

      segmentCount++;
    }
  }

  // Vertical roads (North-South)
  for (let col = 0; col < gridSize; col++) {
    const streetName = nsStreets[col % nsStreets.length];
    const roadClass = col === Math.floor(gridSize / 2) ? 'arterial' : 'local';
    const speed = roadClass === 'arterial' ? 50 : 35;

    for (let row = 0; row < gridSize - 1; row++) {
      const startNodeId = nodeIds[row][col];
      const endNodeId = nodeIds[row + 1][col];

      const startLat = centerLat - (gridSize / 2 - row) * spacing;
      const startLng = centerLng - (gridSize / 2 - col) * spacing;
      const endLat = centerLat - (gridSize / 2 - row - 1) * spacing;
      const endLng = startLng;

      // Calculate length in meters
      const length = spacing * 111000;

      await pool.query(`
        INSERT INTO road_segments (
          start_node_id, end_node_id, geometry, street_name, road_class,
          length_meters, free_flow_speed_kph, is_toll, is_one_way
        )
        VALUES (
          $1, $2,
          ST_SetSRID(ST_MakeLine(ST_MakePoint($4, $3), ST_MakePoint($6, $5)), 4326)::geography,
          $7, $8, $9, $10, FALSE, FALSE
        )
      `, [
        startNodeId, endNodeId, startLat, startLng, endLat, endLng,
        streetName, roadClass, length, speed
      ]);

      segmentCount++;
    }
  }

  console.log(`Created ${segmentCount} road segments`);

  // Create POIs
  console.log('Creating points of interest...');

  const poiData = [
    // Restaurants
    { name: 'The Grill House', category: 'restaurant', rating: 4.5, reviews: 245 },
    { name: 'Sushi Palace', category: 'restaurant', rating: 4.7, reviews: 189 },
    { name: 'Pasta Paradise', category: 'restaurant', rating: 4.3, reviews: 312 },
    { name: 'Burger Joint', category: 'restaurant', rating: 4.1, reviews: 156 },
    { name: 'Thai Garden', category: 'restaurant', rating: 4.6, reviews: 203 },
    { name: 'Mexican Cantina', category: 'restaurant', rating: 4.4, reviews: 178 },
    { name: 'French Bistro', category: 'restaurant', rating: 4.8, reviews: 89 },
    { name: 'Pizza Corner', category: 'restaurant', rating: 4.2, reviews: 267 },

    // Coffee shops
    { name: 'Blue Bottle Coffee', category: 'coffee', rating: 4.6, reviews: 412 },
    { name: 'Philz Coffee', category: 'coffee', rating: 4.5, reviews: 523 },
    { name: 'Starbucks Reserve', category: 'coffee', rating: 4.3, reviews: 289 },
    { name: 'Sightglass Coffee', category: 'coffee', rating: 4.7, reviews: 345 },
    { name: 'Ritual Coffee', category: 'coffee', rating: 4.4, reviews: 256 },

    // Gas stations
    { name: 'Shell Gas Station', category: 'gas_station', rating: 3.8, reviews: 67 },
    { name: 'Chevron', category: 'gas_station', rating: 4.0, reviews: 89 },
    { name: '76 Station', category: 'gas_station', rating: 3.9, reviews: 45 },

    // Hotels
    { name: 'Grand Hyatt', category: 'hotel', rating: 4.5, reviews: 1234 },
    { name: 'Marriott Union Square', category: 'hotel', rating: 4.3, reviews: 987 },
    { name: 'Hilton Financial District', category: 'hotel', rating: 4.4, reviews: 756 },
    { name: 'The St. Regis', category: 'hotel', rating: 4.8, reviews: 543 },

    // Attractions
    { name: 'Golden Gate Park', category: 'park', rating: 4.9, reviews: 5678 },
    { name: 'Fisherman\'s Wharf', category: 'attraction', rating: 4.2, reviews: 4321 },
    { name: 'Alcatraz Island', category: 'attraction', rating: 4.7, reviews: 3456 },
    { name: 'Cable Car Museum', category: 'museum', rating: 4.5, reviews: 876 },
    { name: 'SFMOMA', category: 'museum', rating: 4.6, reviews: 2345 },

    // Shopping
    { name: 'Westfield Mall', category: 'shopping', rating: 4.1, reviews: 1567 },
    { name: 'Union Square Shopping', category: 'shopping', rating: 4.3, reviews: 2134 },
    { name: 'Ghirardelli Square', category: 'shopping', rating: 4.5, reviews: 987 },

    // Services
    { name: 'UCSF Medical Center', category: 'hospital', rating: 4.2, reviews: 567 },
    { name: 'SF General Hospital', category: 'hospital', rating: 3.9, reviews: 432 },
    { name: 'CVS Pharmacy', category: 'pharmacy', rating: 3.8, reviews: 234 },
    { name: 'Walgreens', category: 'pharmacy', rating: 3.7, reviews: 189 },

    // Entertainment
    { name: 'AMC Theatre', category: 'entertainment', rating: 4.1, reviews: 765 },
    { name: 'The Fillmore', category: 'entertainment', rating: 4.6, reviews: 543 },
    { name: 'Davies Symphony Hall', category: 'entertainment', rating: 4.8, reviews: 432 },
  ];

  let poiCount = 0;
  for (const poi of poiData) {
    // Random location within grid
    const row = Math.floor(Math.random() * (gridSize - 2)) + 1;
    const col = Math.floor(Math.random() * (gridSize - 2)) + 1;

    // Slight offset from intersection
    const lat = centerLat - (gridSize / 2 - row) * spacing + (Math.random() - 0.5) * 0.002;
    const lng = centerLng - (gridSize / 2 - col) * spacing + (Math.random() - 0.5) * 0.002;

    const address = `${Math.floor(Math.random() * 900) + 100} ${ewStreets[row % ewStreets.length]}, San Francisco, CA`;

    await pool.query(`
      INSERT INTO pois (name, category, location, lat, lng, address, rating, review_count)
      VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $3, $4, $5, $6, $7)
    `, [poi.name, poi.category, lat, lng, address, poi.rating, poi.reviews]);

    poiCount++;
  }

  console.log(`Created ${poiCount} points of interest`);

  // Create some initial traffic data
  console.log('Creating initial traffic data...');

  const segments = await pool.query('SELECT id, free_flow_speed_kph FROM road_segments');

  for (const segment of segments.rows) {
    const variation = 0.7 + Math.random() * 0.3; // 70-100% of free flow
    const speed = segment.free_flow_speed_kph * variation;

    let congestion = 'free';
    if (variation < 0.8) congestion = 'light';
    if (variation < 0.5) congestion = 'moderate';
    if (variation < 0.3) congestion = 'heavy';

    await pool.query(`
      INSERT INTO traffic_flow (segment_id, speed_kph, congestion_level)
      VALUES ($1, $2, $3)
    `, [segment.id, speed, congestion]);
  }

  console.log('Created initial traffic data');

  console.log('Database seeding complete!');
  console.log(`Summary:
  - Nodes: ${gridSize * gridSize}
  - Road Segments: ${segmentCount}
  - Points of Interest: ${poiCount}
  - Traffic data initialized
  `);

  await pool.end();
}

seedDatabase().catch(console.error);
