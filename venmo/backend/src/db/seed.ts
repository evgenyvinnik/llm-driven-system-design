import { pool, transaction } from './pool.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import type pg from 'pg';

interface SeedUser {
  id: string;
  username: string;
  email: string;
  phone: string;
  name: string;
  avatar_url: string;
}

interface SampleTransfer {
  senderId: string;
  receiverId: string;
  amount: number;
  note: string;
  visibility: string;
}

const seed = async (): Promise<void> => {
  console.log('Seeding database...');

  const passwordHash = await bcrypt.hash('password123', 10);
  const pinHash = await bcrypt.hash('1234', 10);

  await transaction(async (client: pg.PoolClient) => {
    // Create sample users
    const users: SeedUser[] = [
      {
        id: uuidv4(),
        username: 'alice',
        email: 'alice@example.com',
        phone: '555-0101',
        name: 'Alice Johnson',
        avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=alice',
      },
      {
        id: uuidv4(),
        username: 'bob',
        email: 'bob@example.com',
        phone: '555-0102',
        name: 'Bob Smith',
        avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=bob',
      },
      {
        id: uuidv4(),
        username: 'charlie',
        email: 'charlie@example.com',
        phone: '555-0103',
        name: 'Charlie Brown',
        avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=charlie',
      },
      {
        id: uuidv4(),
        username: 'diana',
        email: 'diana@example.com',
        phone: '555-0104',
        name: 'Diana Prince',
        avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=diana',
      },
      {
        id: uuidv4(),
        username: 'admin',
        email: 'admin@example.com',
        phone: '555-0100',
        name: 'Admin User',
        avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=admin',
      },
    ];

    for (const user of users) {
      await client.query(
        `INSERT INTO users (id, username, email, phone, name, avatar_url, password_hash, pin_hash, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (username) DO NOTHING`,
        [
          user.id,
          user.username,
          user.email,
          user.phone,
          user.name,
          user.avatar_url,
          passwordHash,
          pinHash,
          user.username === 'admin' ? 'admin' : 'user',
        ]
      );

      // Create wallet for each user with some initial balance
      const initialBalance = user.username === 'alice' ? 50000 : user.username === 'bob' ? 25000 : 10000; // in cents
      await client.query(
        `INSERT INTO wallets (user_id, balance)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id, initialBalance]
      );

      // Create a bank account for each user
      await client.query(
        `INSERT INTO payment_methods (id, user_id, type, is_default, name, last4, bank_name, routing_number, account_number_encrypted, verified)
         VALUES ($1, $2, 'bank', true, $3, $4, $5, $6, $7, true)
         ON CONFLICT DO NOTHING`,
        [
          uuidv4(),
          user.id,
          `${user.name}'s Checking`,
          '4567',
          'Sample Bank',
          '021000021',
          'encrypted_account_number',
        ]
      );
    }

    // Get user IDs
    const userResult = await client.query('SELECT id, username FROM users');
    const userMap: Record<string, string> = {};
    userResult.rows.forEach((row: { id: string; username: string }) => {
      userMap[row.username] = row.id;
    });

    // Create friendships
    const friendships: [string, string][] = [
      [userMap['alice'], userMap['bob']],
      [userMap['alice'], userMap['charlie']],
      [userMap['alice'], userMap['diana']],
      [userMap['bob'], userMap['charlie']],
      [userMap['bob'], userMap['diana']],
      [userMap['charlie'], userMap['diana']],
    ];

    for (const [userId, friendId] of friendships) {
      if (userId && friendId) {
        await client.query(
          `INSERT INTO friendships (user_id, friend_id, status)
           VALUES ($1, $2, 'accepted'), ($2, $1, 'accepted')
           ON CONFLICT DO NOTHING`,
          [userId, friendId]
        );
      }
    }

    // Create some sample transfers
    const sampleTransfers: SampleTransfer[] = [
      {
        senderId: userMap['alice'],
        receiverId: userMap['bob'],
        amount: 2500,
        note: 'Lunch yesterday',
        visibility: 'public',
      },
      {
        senderId: userMap['bob'],
        receiverId: userMap['charlie'],
        amount: 1500,
        note: 'Coffee run',
        visibility: 'public',
      },
      {
        senderId: userMap['charlie'],
        receiverId: userMap['alice'],
        amount: 5000,
        note: 'Concert tickets',
        visibility: 'friends',
      },
      {
        senderId: userMap['diana'],
        receiverId: userMap['bob'],
        amount: 3500,
        note: 'Uber split',
        visibility: 'public',
      },
    ];

    for (const transfer of sampleTransfers) {
      if (transfer.senderId && transfer.receiverId) {
        const transferId = uuidv4();
        await client.query(
          `INSERT INTO transfers (id, sender_id, receiver_id, amount, note, visibility, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'completed', NOW() - INTERVAL '${Math.floor(Math.random() * 7) + 1} days')`,
          [
            transferId,
            transfer.senderId,
            transfer.receiverId,
            transfer.amount,
            transfer.note,
            transfer.visibility,
          ]
        );

        // Add to feed for sender, receiver, and friends if public
        await client.query(
          `INSERT INTO feed_items (user_id, transfer_id, created_at)
           SELECT user_id, $1, NOW() - INTERVAL '${Math.floor(Math.random() * 7) + 1} days'
           FROM (
             SELECT $2 as user_id
             UNION SELECT $3
             UNION SELECT friend_id FROM friendships WHERE user_id IN ($2, $3) AND status = 'accepted'
           ) feed_users`,
          [transferId, transfer.senderId, transfer.receiverId]
        );
      }
    }

    // Create sample payment requests
    if (userMap['charlie'] && userMap['alice']) {
      await client.query(
        `INSERT INTO payment_requests (requester_id, requestee_id, amount, note, status)
         VALUES ($1, $2, 2000, 'Movie tickets', 'pending')`,
        [userMap['charlie'], userMap['alice']]
      );
    }

    if (userMap['diana'] && userMap['bob']) {
      await client.query(
        `INSERT INTO payment_requests (requester_id, requestee_id, amount, note, status)
         VALUES ($1, $2, 1500, 'Pizza night', 'pending')`,
        [userMap['diana'], userMap['bob']]
      );
    }
  });

  console.log('Seed completed successfully!');
  console.log('\nSample users created:');
  console.log('  - alice / password123 (balance: $500.00)');
  console.log('  - bob / password123 (balance: $250.00)');
  console.log('  - charlie / password123 (balance: $100.00)');
  console.log('  - diana / password123 (balance: $100.00)');
  console.log('  - admin / password123 (admin user)');
  process.exit(0);
};

seed().catch((err: Error) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
