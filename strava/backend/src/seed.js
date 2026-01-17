import { pool, query } from './utils/db.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import {
  generateSampleRoute,
  calculateMetrics,
  encodePolyline,
  calculateBoundingBox
} from './utils/gps.js';
import dotenv from 'dotenv';

dotenv.config();

async function seed() {
  console.log('Seeding database...');

  // Create sample users
  const passwordHash = await bcrypt.hash('password123', 10);

  const users = [
    { username: 'alice_runner', email: 'alice@example.com', bio: 'Marathon runner and trail enthusiast', location: 'San Francisco, CA' },
    { username: 'bob_cyclist', email: 'bob@example.com', bio: 'Weekend warrior cyclist', location: 'Oakland, CA' },
    { username: 'charlie_triathlete', email: 'charlie@example.com', bio: 'Ironman finisher, always training', location: 'Berkeley, CA' },
    { username: 'diana_hiker', email: 'diana@example.com', bio: 'Hiking and nature lover', location: 'Marin County, CA' },
    { username: 'admin', email: 'admin@example.com', bio: 'Platform administrator', location: 'San Francisco, CA', role: 'admin' }
  ];

  const userIds = [];

  for (const user of users) {
    try {
      const result = await query(
        `INSERT INTO users (username, email, password_hash, bio, location, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (username) DO UPDATE SET bio = EXCLUDED.bio
         RETURNING id`,
        [user.username, user.email, passwordHash, user.bio, user.location, user.role || 'user']
      );
      userIds.push(result.rows[0].id);
      console.log(`Created user: ${user.username}`);
    } catch (error) {
      console.error(`Error creating user ${user.username}:`, error.message);
    }
  }

  // Create follow relationships
  const followPairs = [
    [0, 1], [0, 2], [0, 3],
    [1, 0], [1, 2],
    [2, 0], [2, 1], [2, 3],
    [3, 0], [3, 2]
  ];

  for (const [followerIdx, followingIdx] of followPairs) {
    if (userIds[followerIdx] && userIds[followingIdx]) {
      try {
        await query(
          'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userIds[followerIdx], userIds[followingIdx]]
        );
      } catch (error) {
        // Ignore duplicate follows
      }
    }
  }
  console.log('Created follow relationships');

  // Create sample activities
  const sfLocations = [
    { lat: 37.7749, lng: -122.4194, name: 'Downtown SF' },
    { lat: 37.7694, lng: -122.4862, name: 'Golden Gate Park' },
    { lat: 37.8024, lng: -122.4058, name: 'Embarcadero' },
    { lat: 37.7578, lng: -122.4376, name: 'Mission District' }
  ];

  const activityTypes = ['run', 'ride', 'hike'];

  for (let i = 0; i < userIds.length - 1; i++) { // Skip admin
    const userId = userIds[i];
    const numActivities = 3 + Math.floor(Math.random() * 3);

    for (let j = 0; j < numActivities; j++) {
      const location = sfLocations[Math.floor(Math.random() * sfLocations.length)];
      const type = activityTypes[Math.floor(Math.random() * activityTypes.length)];
      const numPoints = 50 + Math.floor(Math.random() * 100);

      const points = generateSampleRoute(location.lat, location.lng, numPoints, type);
      const metrics = calculateMetrics(points);
      const polylineStr = encodePolyline(points);
      const bbox = calculateBoundingBox(points);

      const daysAgo = Math.floor(Math.random() * 30);
      const startTime = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

      try {
        const activityResult = await query(
          `INSERT INTO activities (
            user_id, type, name, start_time, elapsed_time, moving_time,
            distance, elevation_gain, avg_speed, max_speed, polyline,
            start_lat, start_lng, end_lat, end_lng, privacy
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          RETURNING id`,
          [
            userId,
            type,
            `${type.charAt(0).toUpperCase() + type.slice(1)} near ${location.name}`,
            startTime,
            metrics.elapsedTime,
            metrics.movingTime,
            metrics.distance,
            metrics.elevationGain,
            metrics.avgSpeed,
            metrics.maxSpeed,
            polylineStr,
            points[0].latitude,
            points[0].longitude,
            points[points.length - 1].latitude,
            points[points.length - 1].longitude,
            'public'
          ]
        );

        const activityId = activityResult.rows[0].id;

        // Insert GPS points (sample every 5th point for speed)
        for (let k = 0; k < points.length; k += 5) {
          const pt = points[k];
          await query(
            `INSERT INTO gps_points (activity_id, point_index, timestamp, latitude, longitude, altitude, heart_rate, cadence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [activityId, k, pt.timestamp, pt.latitude, pt.longitude, pt.altitude, pt.heartRate, pt.cadence]
          );
        }

        console.log(`Created ${type} activity for user ${i + 1}`);
      } catch (error) {
        console.error('Error creating activity:', error.message);
      }
    }
  }

  // Create sample segments
  console.log('Creating sample segments...');

  // Golden Gate Park segment
  const ggpPoints = generateSampleRoute(37.7694, -122.4862, 30, 'run');
  const ggpPolyline = encodePolyline(ggpPoints);
  const ggpBbox = calculateBoundingBox(ggpPoints);
  let ggpDistance = 0;
  for (let i = 1; i < ggpPoints.length; i++) {
    ggpDistance += 100; // Approximate
  }

  try {
    await query(
      `INSERT INTO segments (
        creator_id, name, activity_type, distance, elevation_gain, polyline,
        start_lat, start_lng, end_lat, end_lng,
        min_lat, min_lng, max_lat, max_lng
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT DO NOTHING`,
      [
        userIds[0],
        'Golden Gate Park Loop',
        'run',
        ggpDistance,
        50,
        ggpPolyline,
        ggpPoints[0].latitude,
        ggpPoints[0].longitude,
        ggpPoints[ggpPoints.length - 1].latitude,
        ggpPoints[ggpPoints.length - 1].longitude,
        ggpBbox.minLat,
        ggpBbox.minLng,
        ggpBbox.maxLat,
        ggpBbox.maxLng
      ]
    );
    console.log('Created Golden Gate Park segment');
  } catch (error) {
    console.error('Error creating segment:', error.message);
  }

  // Embarcadero segment
  const embPoints = generateSampleRoute(37.8024, -122.4058, 25, 'run');
  const embPolyline = encodePolyline(embPoints);
  const embBbox = calculateBoundingBox(embPoints);

  try {
    await query(
      `INSERT INTO segments (
        creator_id, name, activity_type, distance, elevation_gain, polyline,
        start_lat, start_lng, end_lat, end_lng,
        min_lat, min_lng, max_lat, max_lng
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT DO NOTHING`,
      [
        userIds[1],
        'Embarcadero Sprint',
        'run',
        1500,
        5,
        embPolyline,
        embPoints[0].latitude,
        embPoints[0].longitude,
        embPoints[embPoints.length - 1].latitude,
        embPoints[embPoints.length - 1].longitude,
        embBbox.minLat,
        embBbox.minLng,
        embBbox.maxLat,
        embBbox.maxLng
      ]
    );
    console.log('Created Embarcadero segment');
  } catch (error) {
    console.error('Error creating segment:', error.message);
  }

  // Add some kudos
  console.log('Adding kudos...');
  const activities = await query('SELECT id, user_id FROM activities LIMIT 20');

  for (const activity of activities.rows) {
    const numKudos = Math.floor(Math.random() * 4);
    for (let i = 0; i < numKudos; i++) {
      const kudosGiver = userIds[Math.floor(Math.random() * userIds.length)];
      if (kudosGiver !== activity.user_id) {
        try {
          await query(
            'INSERT INTO kudos (activity_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [activity.id, kudosGiver]
          );
        } catch (error) {
          // Ignore duplicates
        }
      }
    }
  }

  // Update kudos counts
  await query(`
    UPDATE activities a SET kudos_count = (
      SELECT COUNT(*) FROM kudos WHERE activity_id = a.id
    )
  `);

  console.log('Seeding complete!');
  console.log('\nTest accounts:');
  console.log('  alice@example.com / password123');
  console.log('  bob@example.com / password123');
  console.log('  charlie@example.com / password123');
  console.log('  admin@example.com / password123 (admin)');

  process.exit(0);
}

seed().catch(err => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
