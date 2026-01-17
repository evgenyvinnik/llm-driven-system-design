import { query } from './index.js';
import bcrypt from 'bcrypt';

async function seed() {
  console.log('Seeding database...');

  // Create demo users
  const passwordHash = await bcrypt.hash('password123', 10);

  const users = [
    { username: 'johndoe', email: 'john@example.com', display_name: 'John Doe', bio: 'Full-stack developer' },
    { username: 'janedoe', email: 'jane@example.com', display_name: 'Jane Doe', bio: 'Backend engineer' },
    { username: 'admin', email: 'admin@example.com', display_name: 'Admin User', role: 'admin' },
  ];

  for (const user of users) {
    await query(
      `INSERT INTO users (username, email, password_hash, display_name, bio, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (username) DO NOTHING`,
      [user.username, user.email, passwordHash, user.display_name, user.bio || null, user.role || 'user']
    );
  }

  console.log('Created demo users');

  // Create demo labels for use with repos
  console.log('Database seeded successfully!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});
