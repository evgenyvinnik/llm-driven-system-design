/**
 * Development seed for the Find My backend.
 *
 * This is a TypeScript seeder rather than a plain SQL one for a specific reason:
 * location history is stored as AES-256-GCM blobs keyed by a *rotating*
 * identifier hash derived from each device's master secret. There is no way to
 * author that in SQL — the ciphertext and the per-period identifier both have to
 * be produced by the same crypto the app uses to read them back. So devices are
 * inserted here and their history is generated through KeyManager/encryptLocation,
 * which means the seeded data is decryptable by exactly the code path a real
 * owner session uses, and the server still never holds plaintext it derived.
 *
 * Run with: npm run seed
 */
import bcrypt from 'bcrypt';
import pool from './pool.js';
import { KeyManager, encryptLocation } from '../utils/crypto.js';

/** 15-minute key rotation period, mirroring KEY_ROTATION_PERIOD in utils/crypto. */
const KEY_ROTATION_PERIOD = 15 * 60 * 1000;

interface SeedDevice {
  id: string;
  ownerEmail: string;
  deviceType: 'airtag' | 'iphone' | 'macbook' | 'ipad' | 'airpods';
  name: string;
  emoji: string;
  masterSecret: string;
  /** Location trail, oldest first. minsAgo drives which rotation period it lands in. */
  trail: Array<{ lat: number; lng: number; accuracy: number; minsAgo: number }>;
}

const USERS = [
  { email: 'admin@findmy.local', name: 'Admin', role: 'admin' },
  { email: 'alice@example.com', name: 'Alice Johnson', role: 'user' },
  { email: 'bob@example.com', name: 'Bob Smith', role: 'user' },
];

const DEVICES: SeedDevice[] = [
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    ownerEmail: 'admin@findmy.local',
    deviceType: 'airtag',
    name: 'Keys',
    emoji: '🔑',
    masterSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
    trail: [
      { lat: 37.7952, lng: -122.3937, accuracy: 12, minsAgo: 180 },
      { lat: 37.7941, lng: -122.3968, accuracy: 9, minsAgo: 120 },
      { lat: 37.7933, lng: -122.3989, accuracy: 8, minsAgo: 60 },
      { lat: 37.7928, lng: -122.401, accuracy: 6, minsAgo: 5 },
    ],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    ownerEmail: 'admin@findmy.local',
    deviceType: 'airtag',
    name: 'Backpack',
    emoji: '🎒',
    masterSecret: 'b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a2',
    trail: [
      { lat: 37.7849, lng: -122.4077, accuracy: 15, minsAgo: 240 },
      { lat: 37.7812, lng: -122.4118, accuracy: 11, minsAgo: 150 },
      { lat: 37.7776, lng: -122.4163, accuracy: 7, minsAgo: 20 },
    ],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000003',
    ownerEmail: 'admin@findmy.local',
    deviceType: 'iphone',
    name: 'iPhone 15 Pro',
    emoji: '📱',
    masterSecret: 'c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a2b3',
    trail: [
      { lat: 37.7624, lng: -122.4351, accuracy: 10, minsAgo: 90 },
      { lat: 37.7618, lng: -122.4348, accuracy: 5, minsAgo: 3 },
    ],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000004',
    ownerEmail: 'admin@findmy.local',
    deviceType: 'macbook',
    name: 'MacBook Pro',
    emoji: '💻',
    masterSecret: 'd4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a2b3c4',
    trail: [{ lat: 37.7899, lng: -122.4012, accuracy: 8, minsAgo: 45 }],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000005',
    ownerEmail: 'admin@findmy.local',
    deviceType: 'airpods',
    name: 'AirPods Pro',
    emoji: '🎧',
    masterSecret: 'e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a2b3c4d5',
    trail: [{ lat: 37.7719, lng: -122.4269, accuracy: 14, minsAgo: 300 }],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000006',
    ownerEmail: 'alice@example.com',
    deviceType: 'airtag',
    name: 'Luggage',
    emoji: '🧳',
    masterSecret: 'f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a2b3c4d5e6',
    trail: [{ lat: 37.6188, lng: -122.375, accuracy: 25, minsAgo: 480 }],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000007',
    ownerEmail: 'alice@example.com',
    deviceType: 'iphone',
    name: 'Alice iPhone',
    emoji: '📱',
    masterSecret: '0718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a2b3c4d5e6f7',
    trail: [{ lat: 37.8002, lng: -122.4358, accuracy: 9, minsAgo: 30 }],
  },
];

async function seed(): Promise<void> {
  console.log('Seeding Find My database...');

  const passwordHash = await bcrypt.hash('password123', 10);
  const userIds: Record<string, string> = {};

  for (const user of USERS) {
    await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [user.email, passwordHash, user.name, user.role]
    );
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [user.email]);
    userIds[user.email] = rows[0].id;
  }
  console.log(`  ${USERS.length} users`);

  let reportCount = 0;

  for (const device of DEVICES) {
    await pool.query(
      `INSERT INTO registered_devices (id, user_id, device_type, name, emoji, master_secret)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        device.id,
        userIds[device.ownerEmail],
        device.deviceType,
        device.name,
        device.emoji,
        device.masterSecret,
      ]
    );

    // Generate the encrypted location trail. Each point is filed under the
    // identifier hash for the rotation period it falls in, exactly as a finder
    // device would have submitted it at that time.
    const keyManager = new KeyManager(device.masterSecret);

    for (const point of device.trail) {
      const timestamp = Date.now() - point.minsAgo * 60 * 1000;
      const period = Math.floor(timestamp / KEY_ROTATION_PERIOD);
      const identifierHash = keyManager.getIdentifierHashForPeriod(period);
      const encryptedPayload = encryptLocation(
        { latitude: point.lat, longitude: point.lng, accuracy: point.accuracy, timestamp },
        device.masterSecret
      );

      await pool.query(
        `INSERT INTO location_reports (identifier_hash, encrypted_payload, reporter_region, created_at)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))`,
        [identifierHash, JSON.stringify(encryptedPayload), 'US', timestamp]
      );
      reportCount++;
    }
  }
  console.log(`  ${DEVICES.length} devices, ${reportCount} encrypted location reports`);

  // AirPods left at the gym — shows the lost-mode flow.
  await pool.query(
    `INSERT INTO lost_mode (device_id, enabled, message, contact_phone, contact_email, enabled_at)
     VALUES ($1, TRUE, $2, $3, $4, NOW() - INTERVAL '4 hours')
     ON CONFLICT (device_id) DO NOTHING`,
    [
      'c0000000-0000-4000-8000-000000000005',
      'Lost at the gym — please call, reward offered.',
      '+1-415-555-0142',
      'admin@findmy.local',
    ]
  );

  const notifications: Array<[string, string | null, string, string, string, boolean, number]> = [
    [
      'admin@findmy.local',
      'c0000000-0000-4000-8000-000000000005',
      'device_found',
      'AirPods Pro located',
      'A device in the Find My network reported your AirPods Pro near Duboce Triangle.',
      false,
      25,
    ],
    [
      'admin@findmy.local',
      null,
      'unknown_tracker',
      'Unknown tracker detected',
      'An unknown AirTag has been travelling with you for over an hour across 1.2 km.',
      false,
      70,
    ],
    [
      'admin@findmy.local',
      'c0000000-0000-4000-8000-000000000001',
      'device_found',
      'Keys located',
      'Your Keys were last seen near 101 Market St.',
      true,
      300,
    ],
  ];

  for (const [email, deviceId, type, title, message, isRead, minsAgo] of notifications) {
    await pool.query(
      `INSERT INTO notifications (user_id, device_id, type, title, message, is_read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() - ($7 || ' minutes')::interval)`,
      [userIds[email], deviceId, type, title, message, isRead, minsAgo]
    );
  }
  console.log(`  ${notifications.length} notifications, 1 device in lost mode`);

  console.log('Seeding completed successfully');
  console.log('  Login: admin@findmy.local / password123');
}

seed()
  .then(() => pool.end())
  .catch((error) => {
    console.error('Seeding failed:', error);
    pool.end();
    process.exit(1);
  });
