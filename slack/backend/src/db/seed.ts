/**
 * @fileoverview Database seeding script for development and testing.
 * Creates demo users, a sample workspace with channels, and example messages.
 * Provides ready-to-use test credentials for local development.
 */

import { pool } from './index.js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Seeds the database with demo data for development.
 * Creates four demo users (alice, bob, charlie, diana) with a shared password,
 * a workspace called "Acme Corp", three channels (general, random, engineering),
 * and sample messages with threading and reactions.
 * Outputs demo credentials to console upon completion.
 * @throws Error if seeding fails, with details logged to console
 */
async function seed(): Promise<void> {
  console.log('Seeding database...');

  try {
    // Create demo users
    const passwordHash = await bcrypt.hash('password123', 10);

    const users = [
      { id: uuidv4(), email: 'alice@example.com', username: 'alice', display_name: 'Alice Johnson' },
      { id: uuidv4(), email: 'bob@example.com', username: 'bob', display_name: 'Bob Smith' },
      { id: uuidv4(), email: 'charlie@example.com', username: 'charlie', display_name: 'Charlie Brown' },
      { id: uuidv4(), email: 'diana@example.com', username: 'diana', display_name: 'Diana Ross' },
    ];

    for (const user of users) {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, username, display_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO NOTHING`,
        [user.id, user.email, passwordHash, user.username, user.display_name]
      );
    }

    // Create demo workspace
    const workspaceId = uuidv4();
    await pool.query(
      `INSERT INTO workspaces (id, name, domain)
       VALUES ($1, $2, $3)
       ON CONFLICT (domain) DO NOTHING`,
      [workspaceId, 'Acme Corp', 'acme']
    );

    // Get workspace ID (in case it already existed)
    const workspaceResult = await pool.query('SELECT id FROM workspaces WHERE domain = $1', ['acme']);
    const actualWorkspaceId = workspaceResult.rows[0]?.id || workspaceId;

    // Get user IDs
    const userResult = await pool.query('SELECT id, username FROM users WHERE email IN ($1, $2, $3, $4)',
      ['alice@example.com', 'bob@example.com', 'charlie@example.com', 'diana@example.com']);
    const userIds = userResult.rows;

    // Add users to workspace
    for (const user of userIds) {
      const role = user.username === 'alice' ? 'owner' : 'member';
      await pool.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [actualWorkspaceId, user.id, role]
      );
    }

    // Create default channels
    const channels = [
      { name: 'general', topic: 'Company-wide announcements and general discussions' },
      { name: 'random', topic: 'Random fun stuff' },
      { name: 'engineering', topic: 'Engineering team discussions' },
    ];

    const aliceId = userIds.find(u => u.username === 'alice')?.id;

    for (const channel of channels) {
      const channelId = uuidv4();
      await pool.query(
        `INSERT INTO channels (id, workspace_id, name, topic, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, name) DO NOTHING`,
        [channelId, actualWorkspaceId, channel.name, channel.topic, aliceId]
      );
    }

    // Get channel IDs
    const channelResult = await pool.query('SELECT id, name FROM channels WHERE workspace_id = $1', [actualWorkspaceId]);
    const channelIds = channelResult.rows;

    // Add all users to general and random channels
    for (const channel of channelIds.filter(c => ['general', 'random'].includes(c.name))) {
      for (const user of userIds) {
        await pool.query(
          `INSERT INTO channel_members (channel_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [channel.id, user.id]
        );
      }
    }

    // Add engineering team to engineering channel
    const engineeringChannel = channelIds.find(c => c.name === 'engineering');
    const engineeringTeam = userIds.filter(u => ['alice', 'bob', 'charlie'].includes(u.username));
    for (const user of engineeringTeam) {
      await pool.query(
        `INSERT INTO channel_members (channel_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [engineeringChannel?.id, user.id]
      );
    }

    // Add some sample messages
    const generalChannel = channelIds.find(c => c.name === 'general');
    if (generalChannel && aliceId) {
      const bobId = userIds.find(u => u.username === 'bob')?.id;
      const charlieId = userIds.find(u => u.username === 'charlie')?.id;

      // First message
      const msg1Result = await pool.query(
        `INSERT INTO messages (workspace_id, channel_id, user_id, content)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [actualWorkspaceId, generalChannel.id, aliceId, 'Welcome to Acme Corp workspace! Feel free to introduce yourself here.']
      );

      // Reply to first message (thread)
      if (bobId) {
        await pool.query(
          `INSERT INTO messages (workspace_id, channel_id, user_id, thread_ts, content)
           VALUES ($1, $2, $3, $4, $5)`,
          [actualWorkspaceId, generalChannel.id, bobId, msg1Result.rows[0].id, 'Thanks Alice! Excited to be here!']
        );

        // Update reply count
        await pool.query(
          'UPDATE messages SET reply_count = reply_count + 1 WHERE id = $1',
          [msg1Result.rows[0].id]
        );
      }

      // More messages
      if (charlieId) {
        await pool.query(
          `INSERT INTO messages (workspace_id, channel_id, user_id, content)
           VALUES ($1, $2, $3, $4)`,
          [actualWorkspaceId, generalChannel.id, charlieId, 'Hey everyone! Looking forward to working with you all.']
        );
      }

      // Add a reaction
      await pool.query(
        `INSERT INTO reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [msg1Result.rows[0].id, bobId, 'wave']
      );
    }

    console.log('Seeding completed successfully');
    console.log('\nDemo credentials:');
    console.log('Email: alice@example.com, Password: password123');
    console.log('Email: bob@example.com, Password: password123');
    console.log('Workspace domain: acme');
  } catch (error) {
    console.error('Seeding failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

seed();
