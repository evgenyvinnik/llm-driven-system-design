/**
 * @fileoverview Cassandra client for Instagram Direct Messages.
 * Provides connection management and prepared statements for DM operations.
 */

import cassandra from 'cassandra-driver';
import { logger } from './logger.js';

const { Client, types } = cassandra;

interface CassandraConfig {
  contactPoints: string[];
  localDataCenter: string;
  keyspace: string;
}

// Cassandra configuration
const CASSANDRA_CONFIG: CassandraConfig = {
  contactPoints: (process.env.CASSANDRA_HOSTS || 'localhost').split(','),
  localDataCenter: process.env.CASSANDRA_DC || 'datacenter1',
  keyspace: process.env.CASSANDRA_KEYSPACE || 'instagram_dm',
};

let client: cassandra.Client | null = null;
let isConnected: boolean = false;

/**
 * Initialize Cassandra client connection.
 */
export async function initCassandra(): Promise<void> {
  try {
    client = new Client({
      contactPoints: CASSANDRA_CONFIG.contactPoints,
      localDataCenter: CASSANDRA_CONFIG.localDataCenter,
      keyspace: CASSANDRA_CONFIG.keyspace,
      pooling: {
        coreConnectionsPerHost: {
          [cassandra.types.distance.local]: 2,
          [cassandra.types.distance.remote]: 1,
        },
      },
    });

    await client.connect();
    isConnected = true;
    logger.info({ contactPoints: CASSANDRA_CONFIG.contactPoints }, 'Cassandra connected successfully');
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to connect to Cassandra');
    // Don't throw - DMs are not critical for core functionality
    isConnected = false;
  }
}

/**
 * Get Cassandra client instance.
 */
export function getCassandraClient(): cassandra.Client | null {
  return client;
}

/**
 * Check if Cassandra is connected.
 */
export function isCassandraConnected(): boolean {
  return isConnected;
}

/**
 * Close Cassandra connection.
 */
export async function closeCassandra(): Promise<void> {
  if (client) {
    await client.shutdown();
    isConnected = false;
    logger.info('Cassandra connection closed');
  }
}

/**
 * Generate a TimeUUID for message ordering.
 */
export function generateTimeUuid(): cassandra.types.TimeUuid {
  return types.TimeUuid.now();
}

/**
 * Convert a string UUID to Cassandra UUID type.
 */
export function toUuid(uuid: string): cassandra.types.Uuid {
  return types.Uuid.fromString(uuid);
}

/**
 * Generate a sorted user pair key for conversation lookup.
 */
export function generateUserPairKey(userId1: string, userId2: string): string {
  return [userId1, userId2].sort().join(':');
}

export { types };
